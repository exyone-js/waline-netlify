'use strict';

/**
 * 内存版 GitHub API 模拟服务。
 *
 * 为什么需要一个"真的会讲 HTTP"的 mock，而不是 mock 掉 GithubClient：
 * 本方案最容易出错的地方恰好都在协议语义里 —— ref 的非快进更新被拒、
 * tree 用 sha:null 删除文件、>1MB 文件 Contents API 不返回 content、
 * manifest 与分片是同一个 commit 里的原子写入。只有走真实 HTTP、
 * 真正维护 blob/tree/commit/ref 四层对象，才能把这些行为测出来。
 */

const http = require('node:http');

const { gitBlobSha } = require('../csv-store/github-client');

class MockGitHub {
  constructor({ owner = 'owner', repo = 'repo', branch = 'main', contentsMaxBytes = 1024 * 1024 } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.contentsMaxBytes = contentsMaxBytes;

    /** sha → Buffer */
    this.blobs = new Map();
    /** sha → Map<path, blobSha> */
    this.trees = new Map();
    /** sha → { tree, parents, message } */
    this.commits = new Map();
    /** refs/heads/<branch> → commit sha */
    this.refs = new Map();

    this.sequences = 0;
    /** [{method, path, requestBytes, responseBytes}]：性能报告用它统计 API 调用次数与流量 */
    this.requestLog = [];
    this.bytesSent = 0;
    this.bytesReceived = 0;
    /** 故障注入：{ pattern, status, times } */
    this.faults = [];

    this.server = null;
    this.port = 0;
    /** 竞态注入钩子：refs PATCH 之前执行，用于模拟"另一个实例刚好同时提交" */
    this.hooks = { refPatch: null };
  }

  get apiBase() {
    return `http://127.0.0.1:${this.port}`;
  }

  get headCommit() {
    return this.refs.get(`heads/${this.branch}`) ?? null;
  }

  nextSha(prefix) {
    this.sequences += 1;

    return `${prefix}-${String(this.sequences).padStart(6, '0')}`;
  }

  // --------------------------------------------------------------------------
  // 对象写入（也可供测试直接构造初始状态）
  // --------------------------------------------------------------------------

  putBlob(content) {
    const buffer = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8');
    const sha = gitBlobSha(buffer);

    this.blobs.set(sha, buffer);

    return sha;
  }

  /** 从 base tree 派生新 tree，支持 sha:null 删除。 */
  buildTree(baseTreeSha, entries) {
    const tree = new Map(baseTreeSha ? this.trees.get(baseTreeSha) ?? new Map() : []);

    for (const entry of entries) {
      if (entry.sha === null) {
        tree.delete(entry.path);
      } else {
        tree.set(entry.path, entry.sha);
      }
    }

    const sha = this.nextSha('tree');

    this.trees.set(sha, tree);

    return sha;
  }

  createCommit({ tree, parents = [], message = '' }) {
    const sha = this.nextSha('commit');

    this.commits.set(sha, { tree, parents, message });

    return sha;
  }

  /** 直接落一次提交（模拟"另一个实例/另一个人"写入）。 */
  externalCommit(files, message = 'external commit') {
    const entries = [...files].map(([path, content]) => ({ path, sha: this.putBlob(content) }));
    const baseTree = this.headCommit ? this.commits.get(this.headCommit).tree : null;
    const tree = this.buildTree(baseTree, entries);
    const sha = this.createCommit({ tree, parents: this.headCommit ? [this.headCommit] : [], message });

    this.refs.set(`heads/${this.branch}`, sha);

    return sha;
  }

  /** 模拟远端删掉某文件。 */
  externalDelete(paths) {
    const baseTree = this.headCommit ? this.commits.get(this.headCommit).tree : null;
    const tree = this.buildTree(baseTree, [...paths].map((path) => ({ path, sha: null })));
    const sha = this.createCommit({ tree, parents: this.headCommit ? [this.headCommit] : [], message: 'external delete' });

    this.refs.set(`heads/${this.branch}`, sha);

    return sha;
  }

  readFile(path) {
    const head = this.headCommit;

    if (!head) {
      return null;
    }
    const tree = this.trees.get(this.commits.get(head).tree);
    const blobSha = tree?.get(path);

    return blobSha ? { sha: blobSha, content: this.blobs.get(blobSha) } : null;
  }

  /** 仓库当前全部文件（path → {sha, size}）。 */
  listFiles() {
    const head = this.headCommit;

    if (!head) {
      return new Map();
    }
    const tree = this.trees.get(this.commits.get(head).tree) ?? new Map();
    const files = new Map();

    for (const [path, sha] of tree) {
      files.set(path, { sha, size: this.blobs.get(sha)?.length ?? 0 });
    }

    return files;
  }

  /** 读取某个路径的文本内容，供断言使用。 */
  readText(path) {
    return this.readFile(path)?.content?.toString('utf8') ?? null;
  }

  failNext(pattern, status, times = 1) {
    this.faults.push({ pattern, status, times });
  }

  reset() {
    this.blobs.clear();
    this.trees.clear();
    this.commits.clear();
    this.refs.clear();
    this.requestLog.length = 0;
    this.faults.length = 0;
    this.sequences = 0;
    this.bytesSent = 0;
    this.bytesReceived = 0;
  }

  // --------------------------------------------------------------------------
  // HTTP 层
  // --------------------------------------------------------------------------

  async start() {
    if (this.server) {
      return this;
    }
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `mock 内部错误：${err.message}` }));
      });
    });
    await new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });

    return this;
  }

  async stop() {
    if (!this.server) {
      return;
    }
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  send(res, status, body) {
    const text = JSON.stringify(body ?? {});
    const size = Buffer.byteLength(text, 'utf8');

    // 把响应体大小记到本次请求上：性能报告用它统计"一次查询下载了多少字节"
    if (res.__entry) {
      res.__entry.responseBytes += size;
    }
    this.bytesSent += size;

    res.writeHead(status, { 'content-type': 'application/json' });

    res.end(text);
  }

  async readBody(req) {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

    if (req.__entry) {
      req.__entry.requestBytes += size;
    }
    this.bytesReceived += size;

    return size > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  consumeFault(method, pathname) {
    for (const fault of this.faults) {
      if (fault.times <= 0 || !pathname.includes(fault.pattern)) {
        continue;
      }
      fault.times -= 1;

      return fault.status;
    }

    return null;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    const entry = { method: req.method, path: pathname, requestBytes: 0, responseBytes: 0 };

    res.__entry = entry;
    req.__entry = entry;
    this.requestLog.push(entry);

    const prefix = `/repos/${this.owner}/${this.repo}`;

    if (!pathname.startsWith(prefix)) {
      this.send(res, 404, { message: 'Not Found' });

      return;
    }

    const injected = this.consumeFault(req.method, pathname);

    if (injected) {
      this.send(res, injected, { message: `injected ${injected}` });

      return;
    }

    const rest = pathname.slice(prefix.length);
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await this.readBody(req) : {};

    this.route(req, res, rest, url, body);
  }

  route(req, res, rest, url, body) {
    // 仓库信息
    if (rest === '' || rest === '/') {
      this.send(res, 200, { name: this.repo, full_name: `${this.owner}/${this.repo}` });

      return;
    }

    // 分支 head
    const branchMatch = /^\/branches\/(?<branch>[^/]+)$/u.exec(rest);

    if (branchMatch) {
      const head = this.refs.get(`heads/${branchMatch.groups.branch}`);

      if (!head) {
        this.send(res, 404, { message: 'Branch not found' });

        return;
      }
      this.send(res, 200, {
        name: branchMatch.groups.branch,
        commit: { sha: head, commit: { tree: { sha: this.commits.get(head).tree } } },
      });

      return;
    }

    // Contents API
    if (rest.startsWith('/contents/')) {
      const filePath = rest.slice('/contents/'.length);
      const file = this.readFile(filePath);

      if (!file) {
        this.send(res, 404, { message: 'Not Found' });

        return;
      }
      const size = file.content.length;
      // 模拟 GitHub 行为：超过 1MB 的文件 Contents API 不返回 content
      const inline = size <= this.contentsMaxBytes;

      this.send(res, 200, {
        name: filePath.split('/').pop(),
        path: filePath,
        sha: file.sha,
        size,
        encoding: inline ? 'base64' : 'none',
        content: inline ? file.content.toString('base64') : '',
      });

      return;
    }

    // 创建 blob
    if (rest === '/git/blobs' && req.method === 'POST') {
      this.send(res, 201, { sha: this.putBlob(Buffer.from(body.content, 'base64')) });

      return;
    }

    // 读取单个 blob
    const blobMatch = /^\/git\/blobs\/(?<sha>[^/]+)$/u.exec(rest);

    if (blobMatch && req.method === 'GET') {
      const content = this.blobs.get(blobMatch.groups.sha);

      if (!content) {
        this.send(res, 404, { message: 'Not Found' });

        return;
      }
      this.send(res, 200, {
        sha: blobMatch.groups.sha,
        size: content.length,
        encoding: 'base64',
        content: content.toString('base64'),
      });

      return;
    }

    // tree 读取（tree sha / commit sha / 分支名都允许）
    const treeMatch = /^\/git\/trees\/(?<ref>[^/]+)$/u.exec(rest);

    if (treeMatch && req.method === 'GET') {
      const ref = treeMatch.groups.ref;
      let treeSha = this.trees.has(ref) ? ref : null;

      if (!treeSha && this.commits.has(ref)) {
        treeSha = this.commits.get(ref).tree;
      }
      if (!treeSha && this.refs.has(`heads/${ref}`)) {
        treeSha = this.commits.get(this.refs.get(`heads/${ref}`)).tree;
      }
      if (!treeSha) {
        this.send(res, 404, { message: 'Not Found' });

        return;
      }
      const tree = this.trees.get(treeSha);
      const entries = [...tree].map(([path, sha]) => ({
        path,
        mode: '100644',
        type: 'blob',
        sha,
        size: this.blobs.get(sha)?.length ?? 0,
      }));

      this.send(res, 200, { sha: treeSha, truncated: false, tree: entries });

      return;
    }

    if (rest === '/git/trees' && req.method === 'POST') {
      this.send(res, 201, { sha: this.buildTree(body.base_tree ?? null, body.tree ?? []) });

      return;
    }

    if (rest === '/git/commits' && req.method === 'POST') {
      this.send(res, 201, {
        sha: this.createCommit({ tree: body.tree, parents: body.parents ?? [], message: body.message }),
      });

      return;
    }

    if (rest === '/git/refs' && req.method === 'POST') {
      const name = String(body.ref ?? '').replace(/^refs\//u, '');

      if (this.refs.has(name)) {
        this.send(res, 422, { message: 'Reference already exists' });

        return;
      }
      this.refs.set(name, body.sha);
      this.send(res, 201, { ref: body.ref, object: { sha: body.sha } });

      return;
    }

    const refMatch = /^\/git\/refs\/heads\/(?<branch>[^/]+)$/u.exec(rest);

    if (refMatch && req.method === 'PATCH') {
      const name = `heads/${refMatch.groups.branch}`;
      const current = this.refs.get(name);

      if (!current) {
        this.send(res, 422, { message: 'Reference does not exist' });

        return;
      }
      // 竞态注入：在真正更新 ref 之前插入一次"别人的提交"
      if (this.hooks.refPatch) {
        const hook = this.hooks.refPatch;

        this.hooks.refPatch = null;
        hook(this);
      }
      // 非快进更新被拒：这正是我们把 force 固定为 false 所依赖的乐观锁
      const commit = this.commits.get(body.sha);
      const head = this.refs.get(name);

      if (!body.force && (!commit || !commit.parents.includes(head))) {
        this.send(res, 422, { message: 'Update is not a fast forward' });

        return;
      }
      this.refs.set(name, body.sha);
      this.send(res, 200, { ref: `refs/${name}`, object: { sha: body.sha } });

      return;
    }

    this.send(res, 404, { message: `mock 未实现的接口：${req.method} ${rest}${url.search}` });
  }
}

module.exports = { MockGitHub };
