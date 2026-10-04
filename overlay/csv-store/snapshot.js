'use strict';

/**
 * 快照：一天一个"清单文件"，按天数保留，并支持一键恢复；外加"重置仓库"。
 *
 * ---------------------------------------------------------------------------
 * 为什么快照从"整目录复制"改成"单文件清单"
 * ---------------------------------------------------------------------------
 * 旧格式把每个数据文件在 `_snapshots/<date>/` 下复制一份 tree entry。
 * 文件数因此是「分片数 × (保留天数 + 1)」：2000 个分片 + 保留 30 天 ≈ 6 万条，
 * 很快逼近 Git Trees API 的截断上限；一旦 truncated=true，
 * 快照 / 恢复 / rebuild 会一起失效——偏偏那时最需要它们。
 *
 * 新格式一天只写一个文件 `_snapshots/<date>.csv`（path,sha 清单）：
 *   - 文件数与保留天数同阶，不再随分片数放大；
 *   - 恢复时按清单重建 tree entry，语义与"整体覆盖"完全等价；
 *   - 依旧零内容上传（引用的都是仓库里已有的 blob）。
 * 旧格式的目录快照仍然可读（恢复时自动识别），所以历史快照不会变成死数据。
 *
 * ---------------------------------------------------------------------------
 * 为什么可以放心地"覆盖式恢复"与"重置仓库"
 * ---------------------------------------------------------------------------
 * 评论数据没有"查看历史提交"的价值：任何时点都能用快照恢复，而快照本身
 * 只是一份引用清单。反过来，历史提交是仓库体积的主要来源——每次写入都会
 * 重写整个分片并产生一个新的 blob。所以运维上提供了 resetRepository()：
 * 用当前数据构造一个没有父提交的 commit 并强制更新分支，历史一次性清零。
 */

const { setTimeout: sleep } = require('node:timers/promises');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const { ShaConflictError } = require('./github-client');

const SNAPSHOT_DIRNAME = '_snapshots';
const SNAPSHOT_MANIFEST_HEADER = ['path', 'sha'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** 本地日期（不是 UTC），快照目录名与运维的直观认知一致。 */
const localDateString = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * 运维写操作（快照 / 清理 / 恢复）的重试外壳。
 *
 * 它们不像写入队列那样维护"本地待提交变更"，冲突时整体重做一遍即可；
 * 但没有重试的话，一次并发提交就会让管理员看到 500。
 */
async function withConflictRetry(operation, { retries = 3, logger } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;

      if (!(err instanceof ShaConflictError)) {
        throw err;
      }
      logger?.warn?.(`[snapshot] 写冲突（第 ${attempt}/${retries} 次），重做：${err.message}`);

      if (attempt < retries) {
        await sleep(300 * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
}

class SnapshotManager {
  constructor({
    github,
    manager,
    cache,
    logger = console,
    keepDays = 30,
    snapshotHour = 3,
    maxRetries = 3,
  } = {}) {
    this.github = github;
    this.manager = manager;
    this.cache = cache;
    this.logger = logger;
    this.keepDays = keepDays;
    this.snapshotHour = snapshotHour;
    this.maxRetries = maxRetries;
    this.lastRunDate = null;
  }

  get snapshotRoot() {
    return `${this.manager.storeDir}/${SNAPSHOT_DIRNAME}`;
  }

  /** 某日快照清单文件的仓库路径。 */
  snapshotManifestPath(date) {
    return `${this.snapshotRoot}/${date}.csv`;
  }

  /** 当前数据文件（不含 _snapshots 自身）。 */
  async dataFiles() {
    const files = await this.github.listTree(`${this.manager.storeDir}/`);
    const result = new Map();

    for (const [path, meta] of files) {
      if (!path.startsWith(`${this.snapshotRoot}/`)) {
        result.set(path, meta);
      }
    }

    return result;
  }

  /**
   * 读取某日快照，返回 Map<仓库路径, {sha}>。
   * 优先新格式（单文件清单），兼容旧格式（目录复制）。
   */
  async snapshotFiles(date) {
    const manifest = await this.github.getFile(this.snapshotManifestPath(date));

    if (manifest) {
      return this.parseSnapshotManifest(manifest.content);
    }

    const prefix = `${this.snapshotRoot}/${date}/`;
    const files = await this.github.listTree(prefix);
    const result = new Map();

    for (const [path, meta] of files) {
      if (path.startsWith(prefix)) {
        result.set(path.slice(prefix.length), meta);
      }
    }

    return result;
  }

  parseSnapshotManifest(text) {
    const result = new Map();

    if (!text || !text.trim()) {
      return result;
    }

    for (const record of parse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    })) {
      const path = String(record.path ?? '').trim();
      const sha = String(record.sha ?? '').trim();

      if (path && sha) {
        result.set(path, { sha });
      }
    }

    return result;
  }

  serializeSnapshotManifest(files) {
    const records = [...files]
      .map(([path, meta]) => ({ path, sha: meta.sha }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));

    return stringify(records, {
      header: true,
      columns: SNAPSHOT_MANIFEST_HEADER,
      record_delimiter: '\n',
    });
  }

  /** 从 `_snapshots/` 下的路径里抽出日期；新旧两种格式都能识别。 */
  static dateOfSnapshotPath(rest) {
    const [head] = rest.split('/');
    const matched = /^(?<date>\d{4}-\d{2}-\d{2})(?:\.csv)?$/u.exec(head ?? '');

    return matched ? matched.groups.date : null;
  }

  async listSnapshots() {
    const files = await this.github.listTree(`${this.snapshotRoot}/`);
    const dates = new Set();

    for (const path of files.keys()) {
      const date = SnapshotManager.dateOfSnapshotPath(path.slice(this.snapshotRoot.length + 1));

      if (date) {
        dates.add(date);
      }
    }

    return [...dates].sort().reverse();
  }

  /** 创建快照：只上传一份清单文件，数据本身零上传。 */
  createSnapshot(date = localDateString()) {
    return withConflictRetry(
      async () => {
        // 先读 head 再列目录：与写入队列同样的顺序，保证快照内容与提交基线一致
        const head = await this.github.getBranchHead();
        const files = await this.dataFiles();

        if (files.size === 0) {
          return { date, files: 0, skipped: true };
        }

        const upserts = new Map([[this.snapshotManifestPath(date), this.serializeSnapshotManifest(files)]]);
        const result = await this.github.commitChanges({
          message: `chore(csv-store): snapshot ${date} (${files.size} files)`,
          upserts,
          head,
        });

        this.logger.info?.(`[snapshot] 已创建快照 ${date}，包含 ${files.size} 个文件`);

        return { date, files: files.size, skipped: false, headSha: result.headSha };
      },
      { retries: this.maxRetries, logger: this.logger },
    );
  }

  /** 按 SNAPSHOT_KEEP_DAYS 保留最近若干天，删除更早的快照。 */
  pruneSnapshots() {
    return withConflictRetry(
      async () => {
        if (this.keepDays <= 0) {
          return { removed: [] };
        }

        const dates = await this.listSnapshots();
        const expired = dates.slice(this.keepDays);

        if (expired.length === 0) {
          return { removed: [] };
        }

        const head = await this.github.getBranchHead();
        const files = await this.github.listTree(`${this.snapshotRoot}/`);
        const deletes = [];

        for (const path of files.keys()) {
          const date = SnapshotManager.dateOfSnapshotPath(path.slice(this.snapshotRoot.length + 1));

          if (date && expired.includes(date)) {
            deletes.push(path);
          }
        }

        await this.github.commitChanges({
          message: `chore(csv-store): prune snapshots older than ${this.keepDays} days`,
          deletes,
          head,
        });

        this.logger.info?.(`[snapshot] 已清理 ${expired.length} 个过期快照：${expired.join(', ')}`);

        return { removed: expired };
      },
      { retries: this.maxRetries, logger: this.logger },
    );
  }

  /**
   * 用指定日期的快照覆盖当前数据目录。
   *
   * 覆盖 = 快照里的文件全部写回原路径 + 当前多出来的文件全部删除，
   * 因此恢复后的状态与该快照完全一致（而不是"混合"）。
   */
  async restore(date) {
    const normalized = String(date ?? '').trim();

    if (!DATE_PATTERN.test(normalized)) {
      throw new Error(`快照日期格式应为 YYYY-MM-DD，当前值：${date}`);
    }

    return withConflictRetry(
      async () => {
        const snapshot = await this.snapshotFiles(normalized);

        if (snapshot.size === 0) {
          throw new Error(`快照 ${normalized} 不存在或不包含任何文件`);
        }
        const head = await this.github.getBranchHead();
        const current = await this.dataFiles();
        const upserts = new Map();

        for (const [path, meta] of snapshot) {
          upserts.set(path, { sha: meta.sha });
        }

        const deletes = [...current.keys()].filter((path) => !snapshot.has(path));
        const result = await this.github.commitChanges({
          message: `chore(csv-store): restore snapshot ${normalized}`,
          upserts,
          deletes,
          head,
        });

        // 内存视图必须作废，否则会继续对外提供恢复前的数据
        this.cache.reset();
        await this.cache.refresh({ force: true });

        this.logger.warn?.(
          `[snapshot] 已从 ${normalized} 恢复：写回 ${upserts.size} 个文件，删除 ${deletes.length} 个文件`,
        );

        return { date: normalized, restored: upserts.size, deleted: deletes.length, headSha: result.headSha };
      },
      { retries: this.maxRetries, logger: this.logger },
    );
  }

  /**
   * 重置数据仓库：用当前数据文件构造一个无父提交的 commit，并强制更新分支指针。
   *
   * 为什么提供它：写入即提交，历史里堆着每一次分片重写产生的 blob，仓库体积
   * 只增不减（GitHub 推荐仓库 <1GB）。而评论数据的历史提交没有价值——
   * 任何时点都能用快照恢复。一次 orphan commit 就把历史清零：
   *   - 仓库回到"一个提交"的状态，`.git` 体积随之降到当前数据大小；
   *   - 快照目录树也一并丢弃（它同样只是历史负担）；
   *   - 不需要新建仓库再切环境变量，没有"两份数据并存"的窗口。
   *
   * 这是不可逆操作，调用方（运维接口）要求显式确认后才执行。
   *
   * @param {object} options
   * @param {boolean} options.keepSnapshots 是否连同快照一起保留（默认丢弃）
   * @returns {Promise<{reset: boolean, files: number, headSha?: string}>}
   */
  async resetRepository({ keepSnapshots = false } = {}) {
    const head = await this.github.getBranchHead();
    const files = await this.dataFiles();
    const snapshots = keepSnapshots ? await this.github.listTree(`${this.snapshotRoot}/`) : new Map();
    const upserts = new Map();

    for (const [path, meta] of files) {
      upserts.set(path, { sha: meta.sha });
    }
    for (const [path, meta] of snapshots) {
      upserts.set(path, { sha: meta.sha });
    }

    if (upserts.size === 0) {
      return { reset: false, files: 0, reason: '仓库里没有数据文件，无需重置' };
    }

    const result = await this.github.commitChanges({
      message: `chore(csv-store): reset repository (${upserts.size} files, history rewritten)`,
      upserts,
      head,
      orphan: true,
      force: true,
    });

    this.cache.reset();
    await this.cache.refresh({ force: true });
    // 每日快照的"今天已执行"标记属于被丢弃的那段历史，重置后应当重新拍一张
    this.lastRunDate = null;

    this.logger.warn?.(`[csv-store] 已重置数据仓库：${upserts.size} 个文件，历史提交已丢弃`);

    return { reset: true, files: upserts.size, snapshotsKept: keepSnapshots, headSha: result.headSha };
  }

  /**
   * 每日快照。
   *
   * 这里用"请求驱动"的惰性触发（每天首个经过 SNAPSHOT_HOUR 之后的请求触发一次），
   * 而不是依赖平台定时任务：Netlify/Vercel 的免费计划对 cron 支持不一，
   * 惰性触发在任意部署形态下都成立。需要更精确的时点可以：
   *   - 用平台的 Scheduled Function 调 POST /csv-store/snapshot
   *   - 或用 VPS 的 crontab 调同一个接口
   */
  async maybeRunDaily(now = new Date()) {
    if (this.keepDays <= 0) {
      return { skipped: true, reason: 'SNAPSHOT_KEEP_DAYS <= 0，快照功能已关闭' };
    }

    const today = localDateString(now);

    if (this.lastRunDate === today || now.getHours() < this.snapshotHour) {
      return { skipped: true, reason: '今日已执行或未到执行时点' };
    }

    const created = await this.createSnapshot(today);
    const pruned = await this.pruneSnapshots();

    // 成功之后才记账：失败时当天还要再试，否则一次抖动就让今天没有快照
    this.lastRunDate = today;

    return { skipped: false, created, pruned };
  }
}

module.exports = { SnapshotManager, localDateString, SNAPSHOT_DIRNAME, DATE_PATTERN, withConflictRetry };
