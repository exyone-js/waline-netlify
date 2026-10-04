'use strict';

/**
 * Waline 存储适配器：`CustomModel` 的实现。
 *
 * 它是"薄适配层"——只负责把 Waline 的调用约定翻译成对缓存 + 写入队列的操作，
 * 真正的事情（索引、查询、提交、冲突处理）由下面三个组件负责：
 *
 *   CsvShardCache   多 CSV 分片的内存视图 + 全局索引 + where/order/limit 语义
 *   ShardWriteQueue 合并写入 + 批量 Git 提交 + SHA 冲突重试
 *   ShardManager    分片命名、manifest、CSV 编解码
 *
 * 与上游 @waline/vercel/src/service/storage/github.js 的语义对齐点（很重要，
 * 这些细节决定上层业务是否能正常工作）：
 *   - select 的返回值一定要"带 objectId"，且必须是新对象（controller 里的
 *     formatCmt 会对结果做 delete / 覆盖写）。
 *   - field 投影必须额外保留 objectId；上游还会把请求里的 'id' 当作主键别名。
 *   - update 的 data 可以是对象，也可以是函数（计数器自增就走这条路径）；
 *     函数返回的对象也会被应用（上游丢弃了返回值，导致 GitHub 存储下
 *     "阅读量永远不增长"）。
 *   - where 里的 undefined 表示"该列为空"，LIKE 支持 %x / x% / %x%。
 */

/** 与上游 add() 相同的 base36 主键风格，保证新老数据的 ID 形态一致。 */
const genId = () => Math.random().toString(36).slice(2, 15);

class CsvModel {
  constructor(tableName, { cache, queue, manager, logger = console, dedupWindowSeconds = 60 } = {}) {
    this.tableName = tableName;
    this.cache = cache;
    this.queue = queue;
    this.manager = manager;
    this.logger = logger;
    this.dedupWindowSeconds = dedupWindowSeconds;
  }

  async select(where, { desc, field, limit, offset, order } = {}) {
    await this.cache.ensureFresh();

    return this.cache.select(this.tableName, where, { desc, field, limit, offset, order });
  }

  async count(where = {}, options = {}) {
    await this.cache.ensureFresh();

    return this.cache.count(this.tableName, where, options);
  }

  /** 取一行。Users 可按主键定位分片族，其它表需要整表加载。 */
  async get(objectId) {
    await this.cache.ensureFresh();

    return this.cache.getRow(this.tableName, objectId);
  }

  /**
   * 新增一行。
   *
   * 写入是"内存立即生效 + 落盘延迟到 flush"，因此返回的对象可以直接用于
   * 后续渲染（controller 会拿它当返回值响应给前端），不会出现
   * "提交成功但刷新后消失"。
   */
  async add(data = {}) {
    await this.cache.ensureFresh();

    const duplicate = await this.findRecentDuplicate(data);

    if (duplicate) {
      // 幂等：短时间内重复提交同样内容（例如刷新页面重发）直接返回既有记录
      this.logger.debug?.('[csv-model] 命中重复提交去重窗口，返回既有记录');
      return { ...duplicate };
    }

    const row = this.manager.normalizeRow(
      this.tableName,
      { ...data, objectId: genId() },
      { defaults: true },
    );

    await this.queue.enqueue({ type: 'add', table: this.tableName, row });

    return { ...row };
  }

  /**
   * 更新匹配的行，返回更新后的记录数组（上游语义：返回被更新的行）。
   *
   * 注意 `data` 可能是函数：计数器自增通过
   *   update((counter) => ({ time: (counter.time || 0) + 1 }), { objectId: [...] })
   * 传入。这里既支持"函数就地修改数组元素"，也支持"函数返回补丁对象"。
   */
  async update(data, where) {
    await this.cache.ensureFresh();

    const rows = await this.cache.filterRows(this.tableName, where);
    const updated = [];

    for (const row of rows) {
      const applied = {};
      const result = typeof data === 'function' ? data(row) : data;

      if (result && typeof result === 'object') {
        Object.assign(applied, result);
      }
      // 主键不参与更新（上游同样会先 delete data.objectId）
      delete applied.objectId;

      const next = this.cache.applyUpdate(this.tableName, row.objectId, applied);

      if (next) {
        updated.push({ ...next });
      }
    }

    return updated;
  }

  async delete(where) {
    await this.cache.ensureFresh();

    // filterRows 返回的是新数组，因此循环中从分片里摘除元素不会影响遍历
    for (const row of await this.cache.filterRows(this.tableName, where)) {
      await this.queue.enqueue({ type: 'delete', table: this.tableName, objectId: row.objectId });
    }
  }

  /**
   * 去重检测：mail + url + 内容哈希相同，且落在窗口内。
   *
   * 之所以还要在适配器层做一次：Waline 自身的重复校验发生在 controller 层，
   * 一旦请求在返回前被重试（刷新、客户端重发、网络重放），仍可能重复落库。
   *
   * 只在"同一 url 的候选行"上算指纹，而不是维护一张全表指纹索引：
   * 后者在 10 万条评论下要吃掉 20MB 以上的常驻内存，而这段逻辑一天也跑不了几次。
   * 时间无法解析时不拦截——宁可多一条重复评论，也不要误杀正常评论。
   */
  async findRecentDuplicate(data) {
    if (this.tableName !== 'Comment' || this.dedupWindowSeconds <= 0) {
      return null;
    }

    const hash = this.cache.dedupHash(data);

    if (!hash) {
      return null;
    }
    const cutoff = Date.now() - this.dedupWindowSeconds * 1000;

    for (const row of await this.cache.filterRows('Comment', { url: data.url ?? '' })) {
      if (this.cache.dedupHash(row) !== hash) {
        continue;
      }
      const insertedAt = Date.parse(row.insertedAt ?? '');

      if (Number.isNaN(insertedAt)) {
        return null;
      }
      if (insertedAt >= cutoff) {
        return row;
      }
    }

    return null;
  }
}

module.exports = { CsvModel, genId };
