'use strict';

/**
 * 快照：整目录复制到 `_snapshots/YYYY-MM-DD/`，按天数保留，并支持一键恢复。
 *
 * 关键实现技巧：快照不重新上传任何文件内容，而是直接在新的 tree 里引用
 * 已存在分片的 blob SHA。于是"复制整个数据目录"只需要一次 commit，
 * 几百个分片也只是几百条 tree entry，零字节上传、秒级完成。
 *
 * 为什么可以放心地"覆盖式恢复"：数据本身就活在 git 里，恢复操作同样是一次
 * 提交，旧状态永远可以从历史 commit 里找回，因此不需要在恢复前再拍一次快照。
 */

const SNAPSHOT_DIRNAME = '_snapshots';

/** 本地日期（不是 UTC），快照目录名与运维的直观认知一致。 */
const localDateString = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

class SnapshotManager {
  constructor({ github, manager, cache, logger = console, keepDays = 30, snapshotHour = 3 } = {}) {
    this.github = github;
    this.manager = manager;
    this.cache = cache;
    this.logger = logger;
    this.keepDays = keepDays;
    this.snapshotHour = snapshotHour;
    this.lastRunDate = null;
  }

  get snapshotRoot() {
    return `${this.manager.storeDir}/${SNAPSHOT_DIRNAME}`;
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

  /** 某次快照内的文件，key 为"恢复后应处的原始路径"。 */
  async snapshotFiles(date) {
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

  async listSnapshots() {
    const files = await this.github.listTree(`${this.snapshotRoot}/`);
    const dates = new Set();

    for (const path of files.keys()) {
      const rest = path.slice(this.snapshotRoot.length + 1);
      const [date] = rest.split('/');

      if (date) {
        dates.add(date);
      }
    }

    return [...dates].sort().reverse();
  }

  /** 创建快照：tree entry 直接复用已有 blob，不产生任何内容上传。 */
  async createSnapshot(date = localDateString()) {
    // 先读 head 再列目录：与写入队列同样的顺序，保证快照内容与提交基线一致
    const head = await this.github.getBranchHead();
    const files = await this.dataFiles();

    if (files.size === 0) {
      return { date, files: 0, skipped: true };
    }

    const upserts = new Map();

    for (const [path, meta] of files) {
      upserts.set(`${this.snapshotRoot}/${date}/${path}`, { sha: meta.sha });
    }

    const result = await this.github.commitChanges({
      message: `chore(waline-data): snapshot ${date} (${files.size} files)`,
      upserts,
      head,
    });

    this.logger.info?.(`[snapshot] 已创建快照 ${date}，包含 ${files.size} 个文件`);

    return { date, files: files.size, skipped: false, headSha: result.headSha };
  }

  /** 按 SNAPSHOT_KEEP_DAYS 保留最近若干天，删除更早的快照。 */
  async pruneSnapshots() {
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
      const rest = path.slice(this.snapshotRoot.length + 1);
      const [date] = rest.split('/');

      if (expired.includes(date)) {
        deletes.push(path);
      }
    }

    await this.github.commitChanges({
      message: `chore(waline-data): prune snapshots older than ${this.keepDays} days`,
      deletes,
      head,
    });

    this.logger.info?.(`[snapshot] 已清理 ${expired.length} 个过期快照：${expired.join(', ')}`);

    return { removed: expired };
  }

  /**
   * 用指定日期的快照覆盖当前数据目录。
   *
   * 覆盖 = 快照里的文件全部写回原路径 + 当前多出来的文件全部删除，
   * 因此恢复后的状态与该快照完全一致（而不是"混合"）。
   */
  async restore(date) {
    const head = await this.github.getBranchHead();
    const snapshot = await this.snapshotFiles(date);

    if (snapshot.size === 0) {
      throw new Error(`快照 ${date} 不存在或不包含任何文件`);
    }
    const current = await this.dataFiles();
    const upserts = new Map();

    for (const [path, meta] of snapshot) {
      upserts.set(path, { sha: meta.sha });
    }

    const deletes = [...current.keys()].filter((path) => !snapshot.has(path));

    const result = await this.github.commitChanges({
      message: `chore(waline-data): restore snapshot ${date}`,
      upserts,
      deletes,
      head,
    });

    // 内存视图必须作废，否则会继续对外提供恢复前的数据
    this.cache.reset();
    await this.cache.refresh({ force: true });

    this.logger.warn?.(
      `[snapshot] 已从 ${date} 恢复：写回 ${upserts.size} 个文件，删除 ${deletes.length} 个文件`,
    );

    return { date, restored: upserts.size, deleted: deletes.length, headSha: result.headSha };
  }

  /**
   * 每日快照。
   *
   * 这里用"请求驱动"的惰性触发（每天首个经过 SNAPSHOT_HOUR 之后的请求触发一次），
   * 而不是依赖平台定时任务：Netlify/Vercel 的免费计划对 cron 支持不一，
   * 惰性触发在任意部署形态下都成立。需要更精确的时点可以：
   *   - 用平台的 Scheduled Function 调 POST /waline-data/snapshot
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

    this.lastRunDate = today;
    const created = await this.createSnapshot(today);
    const pruned = await this.pruneSnapshots();

    return { skipped: false, created, pruned };
  }
}

module.exports = { SnapshotManager, localDateString, SNAPSHOT_DIRNAME };
