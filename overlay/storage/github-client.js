'use strict';

/**
 * GitHub 仓库读写客户端。
 *
 * 设计要点：
 * 1. 读取走 Contents API（单文件）与 Git Trees API（批量列目录），
 *    比"每次下载全量数据"少几个数量级的流量。
 * 2. 写入走 Git Data API（blobs → tree → commit → ref）。相比"一个文件一次 PUT"，
 *    多分片写入只需要一次 commit，天然原子：要么全部生效，要么全部不生效。
 * 3. 用 ref 更新时的 force=false 作为乐观锁：如果在我们读取 head 之后分支被推进，
 *    非快进更新会被 GitHub 拒绝（422），从而暴露冲突而不是静默覆盖别人的提交。
 * 4. 所有请求都带重试（网络抖动 / 5xx / 429），但 4xx（除 429）直接抛出，
 *    因为重试 401/403/422 没有意义。
 */

const { setTimeout: sleep } = require('node:timers/promises');
const { createHash } = require('node:crypto');

const USER_AGENT = 'Waline-Sharded-CSV';

/**
 * 计算 git blob SHA：sha1("blob <字节数>\0<内容>")。
 *
 * 它与 GitHub `POST /git/blobs` 返回的 SHA 完全一致，因此在提交前就能在本地
 * 算出各分片的新 SHA，无需再读一次 manifest 就能让缓存与远端对齐。
 * 这是"提交后不重复下载自己刚写入的数据"的关键。
 */
const gitBlobSha = (content) => {
  const buffer = Buffer.from(content, 'utf8');

  return createHash('sha1')
    .update(`blob ${buffer.length}\0`, 'utf8')
    .update(buffer)
    .digest('hex');
};

/** GitHub API 返回的业务错误（携带 HTTP 状态码，便于上层分流处理）。 */
class GithubApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'GithubApiError';
    this.status = status;
    this.body = body;
  }
}

/** 分片 SHA / 分支已被他人推进：属于可恢复的写冲突。 */
class ShaConflictError extends GithubApiError {
  constructor(message, body) {
    super(409, message, body);
    this.name = 'ShaConflictError';
  }
}

/** 仓库不存在或 token 无权限（GitHub 对两者都返回 404，需要区分提示）。 */
class RepoNotAccessibleError extends GithubApiError {
  constructor(repo) {
    super(
      404,
      `无法访问 GitHub 仓库 "${repo}"：请确认 GITHUB_REPO 为 owner/repo 形式，且 GITHUB_TOKEN 已授权访问该仓库`,
    );
    this.name = 'RepoNotAccessibleError';
  }
}

const isRetryableStatus = (status) => status === 429 || status >= 500;

class GithubClient {
  constructor({
    token,
    repo,
    branch = 'main',
    apiBase = 'https://api.github.com',
    fetchImpl = globalThis.fetch,
    logger = console,
    maxRetries = 2,
    timeoutMs = 20000,
  } = {}) {
    if (!token) {
      throw new Error('GITHUB_TOKEN 未配置，无法读写 GitHub 仓库');
    }
    if (!repo) {
      throw new Error('GITHUB_REPO 未配置（应为 owner/repo 形式）');
    }

    this.token = String(token).trim();
    // 环境变量常被粘贴成完整 URL / 带 .git / 带首尾空白，这里统一归一化
    this.repo = String(repo)
      .trim()
      .replace(/^https?:\/\/(?:www\.)?github\.com\//iu, '')
      .replace(/\.git$/iu, '')
      .replace(/^\/+|\/+$/gu, '');
    this.branch = String(branch || 'main').trim();
    this.apiBase = apiBase.replace(/\/+$/u, '');
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.requestCount = 0;
  }

  /**
   * 统一请求出口。计数器 requestCount 供性能报告统计 API 调用次数，
   * 让"改造成本"可量化而不是靠感觉。
   */
  async request(method, path, { body, query, allow404 = false } = {}) {
    let url = `${this.apiBase}/repos/${this.repo}${path}`;

    if (query) {
      url += `?${new URLSearchParams(query).toString()}`;
    }

    const init = {
      method,
      headers: {
        accept: 'application/vnd.github.v3+json',
        authorization: `token ${this.token}`,
        'user-agent': USER_AGENT,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };

    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      this.requestCount += 1;

      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};

        if (res.ok) {
          return data;
        }
        if (res.status === 404 && allow404) {
          return null;
        }
        if (!isRetryableStatus(res.status)) {
          throw new GithubApiError(res.status, data?.message || res.statusText, data);
        }

        lastError = new GithubApiError(res.status, data?.message || res.statusText, data);
      } catch (err) {
        if (err instanceof GithubApiError && !isRetryableStatus(err.status)) {
          throw err;
        }
        lastError = err;
      }

      if (attempt < this.maxRetries) {
        const backoff = 500 * 2 ** attempt;
        this.logger.warn?.(
          `[github] ${method} ${path} 第 ${attempt + 1} 次失败（${lastError.message}），${backoff}ms 后重试`,
        );
        await sleep(backoff);
      }
    }

    throw lastError;
  }

  /**
   * 取分支 head。一次请求同时拿到 commit SHA 与 tree SHA，
   * 后者作为 Git Data API 的 base_tree，避免多一次 GET /git/commits。
   * 空仓库（分支尚不存在）返回 null，由 commitChanges 走"首个提交"分支。
   */
  async getBranchHead() {
    const data = await this.request('GET', `/branches/${encodeURIComponent(this.branch)}`, {
      allow404: true,
    });

    if (!data) {
      // 分支不存在时要区分"空仓库"与"仓库不可访问"，否则用户会拿到误导性的报错
      const repoInfo = await this.request('GET', '', { allow404: true });

      if (!repoInfo) {
        throw new RepoNotAccessibleError(this.repo);
      }

      return null;
    }

    return { headSha: data.commit.sha, treeSha: data.commit.commit.tree.sha };
  }

  /**
   * 读取单个文件。
   * - 返回 null 表示文件不存在（首次写入前的正常状态）。
   * - 文件超过 1MB 时 Contents API 不返回 content，改走 Blob API。
   */
  async getFile(filePath) {
    const data = await this.request(
      'GET',
      `/contents/${encodeURI(filePath)}`,
      { query: { ref: this.branch }, allow404: true },
    );

    if (!data) {
      return null;
    }
    if (Array.isArray(data)) {
      throw new GithubApiError(400, `期望文件但拿到目录：${filePath}`);
    }

    const content =
      data.encoding === 'base64' && data.content
        ? Buffer.from(data.content, 'base64').toString('utf8')
        : await this.getBlobContent(data.sha);

    return { content, sha: data.sha, size: data.size ?? Buffer.byteLength(content, 'utf8') };
  }

  async getBlobContent(sha) {
    const blob = await this.request('GET', `/git/blobs/${sha}`);

    return Buffer.from(blob.content, 'base64').toString('utf8');
  }

  /**
   * 递归列出仓库树，返回 Map<path, {sha, size}>。
   * 用于快照与分片合并这类"需要知道目录里有什么"的场景。
   * 空仓库（还没有任何提交）返回空 Map，而不是抛错。
   */
  async listTree(prefix = '') {
    const data = await this.request('GET', `/git/trees/${encodeURIComponent(this.branch)}`, {
      query: { recursive: '1' },
      allow404: true,
    });

    if (!data) {
      return new Map();
    }
    if (data.truncated) {
      throw new GithubApiError(
        422,
        '仓库文件过多，Git Trees API 返回被截断，无法安全地做快照/合并；请拆分仓库或联系维护者',
      );
    }

    const files = new Map();

    for (const entry of data.tree ?? []) {
      if (entry.type === 'blob' && (!prefix || entry.path.startsWith(prefix))) {
        files.set(entry.path, { sha: entry.sha, size: entry.size ?? 0 });
      }
    }

    return files;
  }

  async createBlob(content) {
    const data = await this.request('POST', '/git/blobs', {
      body: { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' },
    });

    return data.sha;
  }

  /**
   * 一次提交多个分片。
   *
   * @param {object} options
   * @param {string} options.message  提交信息
   * @param {Map<string, string|{sha: string}>} options.upserts 路径 → 内容（或已存在的 blob sha，快照场景直接复用 blob，零上传）
   * @param {Iterable<string>} options.deletes 需要删除的路径
   * @param {{headSha: string, treeSha: string}|null} [options.head]
   *        调用方在"读取数据快照之前"读到的分支 head。
   *
   * 【为什么 head 要由调用方传入，而不是在这里自己读】
   * 调用方的顺序必须是：读 head → 读数据 → 提交。如果反过来（先读数据、再由本函数
   * 读 head），那么"读数据"和"读 head"之间别人提交的内容不会出现在我们的基线里，
   * 而我们又恰好基于新的 head 提交，就会把别人的改动静默覆盖掉。
   * 传进来的 head 配合 force=false 的 ref 更新构成完整的乐观锁：
   * head 之后任何人再提交，我们的非快进更新都会被 GitHub 拒绝。
   *
   * 不传 head 时才在本函数内读取（仅供快照等自读自写的场景使用）。
   */
  async commitChanges({ message, upserts = new Map(), deletes = [], head }) {
    const resolvedHead = head === undefined ? await this.getBranchHead() : head;

    if (upserts.size === 0 && [...deletes].length === 0) {
      return { headSha: resolvedHead?.headSha ?? null, uploaded: 0 };
    }

    const tree = [];
    let uploaded = 0;

    for (const [filePath, value] of upserts) {
      const sha = typeof value === 'string' ? await this.createBlob(value) : value.sha;

      if (typeof value === 'string') {
        uploaded += 1;
      }
      tree.push({ path: filePath, mode: '100644', type: 'blob', sha });
    }
    for (const filePath of deletes) {
      // Git Data API 用 sha: null 表示删除该路径
      tree.push({ path: filePath, mode: '100644', type: 'blob', sha: null });
    }

    const treeData = await this.request('POST', '/git/trees', {
      body: { ...(resolvedHead ? { base_tree: resolvedHead.treeSha } : {}), tree },
    });
    const commitData = await this.request('POST', '/git/commits', {
      body: {
        message,
        tree: treeData.sha,
        parents: resolvedHead ? [resolvedHead.headSha] : [],
      },
    });

    await this.updateRef(commitData.sha, resolvedHead?.headSha ?? null);

    return { headSha: commitData.sha, uploaded };
  }

  /**
   * 更新分支指针。force=false 是关键：若分支在我们读 head 之后被推进，
   * GitHub 会以 422 拒绝这次非快进更新，冲突因此不会被静默覆盖。
   */
  async updateRef(commitSha, previousHeadSha) {
    if (previousHeadSha === null) {
      try {
        await this.request('POST', '/git/refs', {
          body: { ref: `refs/heads/${this.branch}`, sha: commitSha },
        });

        return;
      } catch (err) {
        // 422 表示分支在我们读取 head 之后已被别人创建 → 同样属于写冲突
        if (err instanceof GithubApiError && err.status === 422) {
          throw new ShaConflictError(`分支 ${this.branch} 已被并发创建`, err.body);
        }
        throw err;
      }
    }

    try {
      await this.request('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, {
        body: { sha: commitSha, force: false },
      });
    } catch (err) {
      if (err instanceof GithubApiError && (err.status === 422 || err.status === 409)) {
        throw new ShaConflictError(`分支 ${this.branch} 已被并发推进`, err.body);
      }
      throw err;
    }
  }
}

module.exports = {
  GithubClient,
  GithubApiError,
  ShaConflictError,
  RepoNotAccessibleError,
  gitBlobSha,
};
