'use strict';

/**
 * 分片写入队列：合并写入 + 批量 Git 提交 + SHA 冲突检测与重试。
 *
 * 为什么需要队列（而不是"改一条评论就 PUT 一次 CSV"）：
 *   1. 同一个请求里对同一分片的多次变更只重写一次 CSV（合并写入）；
 *      同一条记录的多次 update 只保留最终状态——因为变更是就地应用到内存行的。
 *   2. 一次 Git Data API 提交可以带上多个分片，N 个分片从 N 次提交降到 1 次，
 *      而且天然原子：GitHub 要么整体接受，要么整体拒绝。
 *   3. 提交前的 SHA 校验 + 冲突时"只重新拉取变化分片并合并"，让高并发下的
 *      写入不会互相静默覆盖。
 *
 * Serverless 适配（关键）：
 *   Netlify/Lambda 的函数实例在响应返回后会被冻结，定时器不可靠。因此除了
 *   FLUSH_INTERVAL 定时刷盘（面向 VPS/Docker 常驻场景），中间件还会在每次请求
 *   返回前 await 一次 flush()，保证"响应 200 就一定已经落盘"。
 */

const { setTimeout: sleep } = require('node:timers/promises');
const { ShaConflictError, gitBlobSha } = require('./github-client');

class ShardWriteError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ShardWriteError';
    this.cause = cause;
  }
}

class ShardWriteQueue {
  /**
   * @param {object} options
   * @param {import('./csv-shard-cache').CsvShardCache} options.cache
   * @param {import('./github-client').GithubClient} options.github
   * @param {import('./shard-manager').ShardManager} options.manager
   * @param {number} options.flushInterval 定时刷盘间隔（毫秒）
   * @param {number} options.maxBatch 单次提交最多包含的分片数
   * @param {number} options.maxRetries 单次 flush 的最大尝试次数
   */
  constructor({
    cache,
    github,
    manager,
    logger = console,
    flushInterval = 30000,
    maxBatch = 50,
    maxRetries = 3,
  } = {}) {
    this.cache = cache;
    this.github = github;
    this.manager = manager;
    this.logger = logger;
    this.flushInterval = flushInterval;
    this.maxBatch = maxBatch;
    this.maxRetries = maxRetries;
    this.timer = null;
    this.flushing = null;
    /** 统计：用于性能报告，量化"合并写入"省掉了多少次提交。 */
    this.stats = { flushes: 0, commits: 0, retries: 0, conflicts: 0, rollbacks: 0, failures: 0 };
  }

  start() {
    if (this.timer || this.flushInterval <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        this.logger.error?.('[shard-write-queue] 定时刷盘失败：', err);
      });
    }, this.flushInterval);
    // 常驻进程里不该因为一个后台定时器阻止退出；serverless 里也不会依赖它
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 写入一条变更操作。
   *
   * operation: { type: 'add' | 'update' | 'delete', table, row | objectId | patch }
   *
   * 注意：这里"应用到内存"是立即完成的（写后读一致），落盘则推迟到 flush。
   * 所以 add() 之后紧接的 select() 一定能看到新数据，不会出现"提交成功但刷新消失"。
   */
  enqueue(operation) {
    const { type, table } = operation;

    switch (type) {
      case 'add':
        return this.cache.applyAdd(table, operation.row);
      case 'update':
        return this.cache.applyUpdate(table, operation.objectId, operation.patch);
      case 'delete':
        return this.cache.applyDelete(table, operation.objectId);
      default:
        throw new Error(`未知的写入操作类型：${type}`);
    }
  }

  /** 并发调用只执行一次真正的刷盘。 */
  async flush() {
    if (!this.cache.isDirty()) {
      return { skipped: true, shards: 0 };
    }
    if (this.flushing) {
      return this.flushing;
    }

    this.flushing = this.runFlush().finally(() => {
      this.flushing = null;
    });

    return this.flushing;
  }

  async runFlush() {
    const committed = { skipped: false, shards: 0, retries: 0 };

    // 分片数超过 maxBatch 时分多轮提交，避免单次提交过大
    while (this.cache.isDirty()) {
      const paths = [...this.cache.pending.keys()].slice(0, this.maxBatch);

      await this.commitPaths(paths);
      committed.shards += paths.length;

      if (this.cache.pending.size === 0) {
        break;
      }
    }

    this.stats.flushes += 1;

    return committed;
  }

  /**
   * 提交指定的分片。
   *
   * 每次尝试的顺序固定为：读 head → 刷新 manifest（只下载 SHA 变化的分片并按
   * "本地优先"合并）→ 提交但把 head 一并传给 GitHub 客户端。
   *
   * 这个顺序不能调换：只有"先读 head 再读数据"，配合 force=false 的 ref 更新，
   * 才能保证在读取数据之后发生的任何并发提交都会让我们的非快进更新被拒，
   * 从而进入重试而不是静默覆盖别人的数据。
   */
  async commitPaths(paths) {
    const baselines = this.cache.snapshotShards(paths);
    const touchedTables = [
      ...new Set(paths.map((path) => this.cache.pending.get(path)?.table).filter(Boolean)),
    ];
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const head = await this.github.getBranchHead();

        await this.cache.refresh({ force: true, tables: touchedTables });

        return await this.commitOnce(touchedTables, head);
      } catch (err) {
        lastError = err;

        if (err instanceof ShaConflictError) {
          this.stats.conflicts += 1;
          this.stats.retries += 1;
          this.logger.warn?.(
            `[shard-write-queue] 检测到写冲突（第 ${attempt}/${this.maxRetries} 次）：${err.message}，重新拉取变化分片后重试`,
          );
          // 冲突时不需要回滚：下一轮的 refresh 会把远端新数据合并进来，
          // 本地未提交的变更仍在内存里，合并规则保证本地版本优先。
          continue;
        }

        this.stats.retries += 1;
        this.logger.warn?.(
          `[shard-write-queue] 提交失败（第 ${attempt}/${this.maxRetries} 次）：${err.message}`,
        );
        if (attempt < this.maxRetries) {
          await sleep(400 * 2 ** (attempt - 1));
        }
      }
    }

    // 重试耗尽：回滚内存视图，让进程内状态与远端保持一致，
    // 并把错误抛给调用方（中间件会把它变成 5xx，而不是假装写入成功）。
    this.cache.restoreShards(baselines);
    this.cache.discardPending(paths);
    this.stats.rollbacks += 1;
    this.stats.failures += 1;
    throw new ShardWriteError(
      `分片提交失败（已重试 ${this.maxRetries} 次，内存变更已回滚）：${lastError?.message}`,
      lastError,
    );
  }

  async commitOnce(touchedTables, head) {
    const upserts = new Map();
    const shardShas = new Map();
    const deletes = [];

    for (const [path, entry] of this.cache.pending) {
      const shard = this.cache.tables[entry.table].shards.get(path);
      const rows = shard ? shard.rows : [];

      if (rows.length === 0) {
        // 分片被清空 → 从仓库删除该文件，而不是留一个只有表头的空文件
        deletes.push(path);
        continue;
      }

      const content = this.manager.serializeShard(
        entry.table,
        rows,
        this.manager.buildColumns(entry.table, rows),
      );

      upserts.set(path, content);
      shardShas.set(path, gitBlobSha(content));
    }

    // manifest 是分片状态的投影：从当前内存状态整体重建，
    // 因此永远不会出现"manifest 与分片内容不一致"的中间态。
    const deletedPaths = new Set(deletes);

    for (const table of touchedTables) {
      upserts.set(
        this.manager.manifestPath(table),
        this.manager.serializeManifest(this.manifestEntriesOf(table, shardShas, deletedPaths)),
      );
    }

    const result = await this.github.commitChanges({
      message: this.buildCommitMessage(touchedTables, upserts.size),
      upserts,
      deletes,
      head,
    });

    this.cache.markClean(shardShas);
    this.cache.markDeleted(deletes);
    this.stats.commits += 1;

    return {
      skipped: false,
      shards: [...upserts.keys()].filter((path) => !path.endsWith('_manifest.csv')).length + deletes.length,
      headSha: result.headSha,
    };
  }

  /**
   * 用当前内存状态重建某张表的 manifest 条目。
   *
   * 已清空待删除的分片直接跳过；本轮待写入的分片用本地算出的 git blob SHA，
   * 未变更的分片沿用缓存里已知的 SHA。
   */
  manifestEntriesOf(table, shardShas, deletedPaths) {
    const entries = new Map();

    for (const [path, shard] of this.cache.tables[table].shards) {
      if (deletedPaths.has(path)) {
        continue;
      }
      const sha = shardShas.get(path) ?? shard.sha ?? null;

      entries.set(path, this.manager.manifestEntry(table, path, shard.rows, sha));
    }

    return entries;
  }

  buildCommitMessage(tables, fileCount) {
    const names = tables.map((table) => this.manager.tableDir(table)).join('/');

    return `chore(waline-data): update ${names} (${fileCount} files)`;
  }
}

module.exports = { ShardWriteQueue, ShardWriteError };
