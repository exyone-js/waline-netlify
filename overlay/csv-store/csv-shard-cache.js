'use strict';

/**
 * 多 CSV 分片的内存缓存与全局索引。
 *
 * 它取代了旧的"每次查询都下载一个全量 CSV，再在 JS 里逐行过滤"的做法：
 *
 *   旧：select() → Contents API 下载 Comment.csv（可能几 MB）→ 解析 → O(n) 过滤
 *   新：select() → 读内存索引筛出候选 ID → 只对候选行做条件匹配与排序
 *
 * ---------------------------------------------------------------------------
 * 两层状态：清单（权威）与内容（按需加载）
 * ---------------------------------------------------------------------------
 *   entries  Map<path, {sha,rowCount,…}>   manifest 里的全量分片清单，权威
 *   shards   Map<path, {sha, rows}>        真正加载进内存的分片内容
 *   loadedFamilies / allLoaded             记录"哪些族已经加载过"
 *
 * 分片族（family）由分片 key 唯一决定：
 *   Comment/Counter：sha1(url)     → 一篇文章一个族
 *   Users          ：objectId 前缀  → 一个前缀一个族
 * 因此"按 url 查评论"这类查询可以先算出目标族，只加载这一个族的分片，
 * 而不用把整个数据集读进内存。冷启动从"下载全部分片"降为"下载命中族"。
 *
 * 只有带 url / objectId 这类能定位到族的条件才能缩小加载范围；
 * 无法定位时（后台列表、模糊搜索、按 pid/rid 删评论）退化为全量加载——
 * 宁可多读，也不能在没加载全的情况下给出不完整的结果。
 *
 * 索引与"行"的关系：
 *   byId:   Map<objectId, { shardPath, row }>          主键直达，O(1)
 *   byField: Map<字段, Map<值, Set<objectId>>>         等值/IN 查询的候选集
 *
 * 注意 byId 存的是"行对象引用"而不是行号：行号在删除、合并之后会立刻失效，
 * 引用则始终指向当前对象，省掉一整类"索引指向错行"的隐蔽 bug。
 * 索引是增量维护的（分片级 unindex/index），只有 compact / 回滚这类
 * 整表重写才做一次全量重建。
 */

const { sha1, toCell, DATE_FIELDS } = require('./shard-manager');

const TABLES = ['Comment', 'Users', 'Counter'];

/** 空集合常量：避免在热路径里反复 new Set() 造成 GC 压力。 */
const EMPTY_SET = new Set();

/**
 * 这些表的数值列改用"远端值 + 本地增量"合并，而不是"本地优先"。
 *
 * 原因：Counter 的阅读量是并发自增（Waline 传的是
 * `(counter) => ({ time: counter.time + 1 })`）。两个实例基于同一个基线各加 1，
 * 谁后提交谁覆盖——"本地优先"会让先提交的那个 +1 凭空消失，
 * 表现就是阅读量涨得比实际少。
 *
 * 记下"本实例施加的增量"，合并时以远端值为基再加上增量，两个 +1 就都留下了。
 * 评论表不存在这种语义（行是整行写入的），保持本地优先。
 */
const DELTA_MERGE_TABLES = new Set(['Counter']);

/** CSV 里数字是字符串；空串必须算"非数字"，否则 Number('') === 0 会参与比较。 */
const numericOf = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : Number.NaN;
  }
  if (typeof value !== 'string') {
    return Number.NaN;
  }
  const text = value.trim();

  return text === '' ? Number.NaN : Number(text);
};

// ---------------------------------------------------------------------------
// 条件查询引擎（对齐 Waline / ThinkJS 的 where 子集语义）
// ---------------------------------------------------------------------------

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** 把 ''/null/undefined 统一视为"空"，与 CSV 落盘后的表现一致。 */
const isEmptyValue = (value) => value === '' || value === null || value === undefined;

/**
 * 比较两个值的大小。日期字段/日期字面量按时间戳比较。
 *
 * 上游实现直接用 `item[k] >= where[k][1]`，当右侧是 Date 对象时，
 * 字符串与 Date 比较会被强制转成数字得到 NaN，条件恒为 false ——
 * 这就是"评论频率限制（IPQPS）从未生效"的原因。这里做显式的时间归一化。
 */
const compareValues = (left, right) => {
  const leftDate = left instanceof Date;
  const rightDate = right instanceof Date;

  if (leftDate || rightDate) {
    const leftTime = leftDate ? left.getTime() : Date.parse(left);
    const rightTime = rightDate ? right.getTime() : Date.parse(right);

    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
      return leftTime === rightTime ? 0 : leftTime > rightTime ? 1 : -1;
    }
  }

  const a = isEmptyValue(left) ? '' : String(left);
  const b = isEmptyValue(right) ? '' : String(right);

  return a === b ? 0 : a > b ? 1 : -1;
};

/** LIKE 语义：`%x%` 包含、`%x` 结尾、`x%` 开头、无 `%` 则等值。 */
const buildLikeMatcher = (pattern) => {
  const text = String(pattern);
  const first = text.startsWith('%');
  const last = text.endsWith('%') && text.length > 1;

  if (first && last) {
    const regex = new RegExp(escapeRegex(text.slice(1, -1)), 'u');

    return (value) => regex.test(String(value ?? ''));
  }
  if (first) {
    const suffix = text.slice(1);

    return (value) => String(value ?? '').endsWith(suffix);
  }
  if (last) {
    const prefix = text.slice(0, -1);

    return (value) => String(value ?? '').startsWith(prefix);
  }

  return (value) => String(value ?? '') === text;
};

const asSet = (values) => new Set(values.map((value) => (value === null || value === undefined ? '' : String(value))));

/** 解析单个字段条件，产出若干行断言函数。 */
const parseFieldFilters = (field, condition) => {
  if (condition === undefined) {
    return [(row) => isEmptyValue(row[field])];
  }
  if (condition instanceof Date) {
    const expected = condition.toISOString();

    return [(row) => String(row[field] ?? '') === expected];
  }
  if (condition === null || typeof condition !== 'object') {
    return [(row) => String(row[field] ?? '') === String(condition)];
  }
  if (!Array.isArray(condition) || condition.length === 0 || !condition[0]) {
    return [];
  }

  const operator = String(condition[0]).toUpperCase();
  const operand = condition[1];

  switch (operator) {
    case 'IN': {
      const pool = asSet(Array.isArray(operand) ? operand : [operand]);

      return [(row) => pool.has(String(row[field] ?? ''))];
    }
    case 'NOT IN': {
      const pool = asSet(Array.isArray(operand) ? operand : [operand]);

      return [(row) => !pool.has(String(row[field] ?? ''))];
    }
    case 'LIKE': {
      const matches = buildLikeMatcher(operand);

      return [(row) => matches(row[field])];
    }
    case '!=':
      return [(row) => String(row[field] ?? '') !== String(operand)];
    case '>':
      return [(row) => compareValues(row[field], operand) > 0];
    default:
      return [];
  }
};

/**
 * 编译 where 为行断言函数。
 *
 * `_complex` 的行为刻意与上游保持一致：外层的普通条件会同时作用于
 * `_complex` 的每一个分支，因此
 *   { status: ['NOT IN', [...]], _complex: { user_id, mail, _logic: 'or' } }
 * 等价于 status NOT IN (...) AND (user_id = ? OR mail = ?)。
 */
const compileWhere = (where) => {
  if (!where || typeof where !== 'object' || Object.keys(where).length === 0) {
    return () => true;
  }

  const outerFilters = [];

  for (const [field, condition] of Object.entries(where)) {
    if (field === '_complex') {
      continue;
    }
    outerFilters.push(...parseFieldFilters(field, condition));
  }

  const complex = where._complex;

  if (!complex || typeof complex !== 'object') {
    return (row) => outerFilters.every((filter) => filter(row));
  }

  const branches = [];

  for (const [field, condition] of Object.entries(complex)) {
    if (field === '_logic') {
      continue;
    }
    branches.push([...outerFilters, ...parseFieldFilters(field, condition)]);
  }

  const isOr = String(complex._logic ?? 'and').toLowerCase() === 'or';
  const combine = isOr ? 'some' : 'every';

  return (row) => branches[combine]((branch) => branch.every((filter) => filter(row)));
};

/**
 * 排序：等价于上游 storage/order.js 的 normalizeOrder + compareByOrder。
 * 自行实现而不是 require 包的内部路径，是为了避免依赖 @waline/vercel 的
 * 内部文件布局（它并非公开导出，升级时可能搬走）。
 */
const normalizeOrder = (order, desc, mapField = (field) => field) => {
  const entries = order ?? (desc ? [{ field: desc, direction: 'desc' }] : []);

  return entries.map(({ field, direction = 'asc', nulls }) => {
    const normalizedDirection = String(direction).toLowerCase();
    const normalizedNulls = nulls ? String(nulls).toLowerCase() : undefined;

    if (normalizedDirection !== 'asc' && normalizedDirection !== 'desc') {
      throw new TypeError(`Invalid order direction: ${direction}`);
    }
    if (normalizedNulls && normalizedNulls !== 'first' && normalizedNulls !== 'last') {
      throw new TypeError(`Invalid null order: ${nulls}`);
    }

    return { field: mapField(field), direction: normalizedDirection, nulls: normalizedNulls };
  });
};

const compareByOrder = (order) => (left, right) => {
  for (const { field, direction, nulls } of order) {
    const leftRaw = left[field];
    const rightRaw = right[field];
    const leftEmpty = isEmptyValue(leftRaw);
    const rightEmpty = isEmptyValue(rightRaw);

    if (leftEmpty || rightEmpty) {
      if (leftEmpty && rightEmpty) {
        continue;
      }
      // 与上游一致：未声明 nulls 时空值排在最后
      const emptyFirst = nulls === 'first' ? -1 : 1;

      return leftEmpty ? emptyFirst : -emptyFirst;
    }

    let result;
    const leftTime = DATE_FIELDS.has(field) ? Date.parse(leftRaw) : Number.NaN;
    const rightTime = DATE_FIELDS.has(field) ? Date.parse(rightRaw) : Number.NaN;

    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
      result = leftTime === rightTime ? 0 : leftTime > rightTime ? 1 : -1;
    } else {
      const a = String(leftRaw);
      const b = String(rightRaw);

      result = a === b ? 0 : a > b ? 1 : -1;
    }

    if (result !== 0) {
      return direction === 'desc' ? -result : result;
    }
  }

  return 0;
};

class CsvShardCache {
  constructor({
    github,
    manager,
    logger = console,
    cacheTtl = 60000,
    parallelism = 6,
  } = {}) {
    this.github = github;
    this.manager = manager;
    this.logger = logger;
    this.cacheTtl = cacheTtl;
    this.parallelism = parallelism;
    this.ready = false;
    this.lastRefresh = 0;
    this.manifestSha = {};
    /** path → { table, deleted: Set<objectId>, deltas: Map<objectId, Map<field, number>>|null }，存在即表示该分片待提交。 */
    this.pending = new Map();
    /** path → { table, existed, sha, rows }：最后一次提交成功时的内容，用于失败回滚。 */
    this.baselines = new Map();
    this.tables = {};

    for (const table of TABLES) {
      this.tables[table] = CsvShardCache.emptyTable();
    }
  }

  static emptyTable() {
    return {
      /** 权威清单：manifest 里的全部分片（无论是否已加载内容） */
      entries: new Map(),
      /** 已加载内容的分片 */
      shards: new Map(),
      byId: new Map(),
      byField: new Map(),
      /** 族前缀 → 分片路径集合（entries 的投影，供"新增记录的落点选择"使用） */
      families: new Map(),
      /** 已整体加载过的族 */
      loadedFamilies: new Set(),
      /** 是否已加载该表的全部分片 */
      allLoaded: false,
    };
  }

  /** 该表是否需要把 pending 中的删除计入提交（分片合并/冲突处理时会用到）。 */
  pendingEntry(path, table) {
    let entry = this.pending.get(path);

    if (!entry) {
      entry = { table, deleted: new Set(), deltas: null };
      this.pending.set(path, entry);
      // 第一次变脏时采基线：此刻分片内容仍是"上一次提交成功后的状态"
      this.captureBaseline(path, table);
    }

    return entry;
  }

  /**
   * 记录分片的回滚基线。
   *
   * 必须在"改动落到内存之前"调用，而不是在 flush 时——flush 时新数据早已进内存，
   * 拿到的"基线"会包含自己刚写的内容，回滚就变成了空操作。
   */
  captureBaseline(path, table) {
    if (this.baselines.has(path)) {
      return;
    }
    const state = this.tables[table];
    const shard = state.shards.get(path);
    const meta = state.entries.get(path);

    this.baselines.set(path, {
      table,
      // sha 非空表示这个分片在远端真实存在过；为空表示本次请求刚创建
      existed: Boolean(meta?.sha ?? shard?.sha),
      sha: shard?.sha ?? meta?.sha ?? null,
      rows: shard ? shard.rows.map((row) => ({ ...row })) : [],
    });
  }

  isDirty() {
    return this.pending.size > 0;
  }

  // --------------------------------------------------------------------------
  // 加载：清单刷新 + 按族按需加载
  // --------------------------------------------------------------------------

  async ensureFresh(maxAgeMs = this.cacheTtl) {
    if (this.ready && Date.now() - this.lastRefresh < maxAgeMs) {
      return;
    }

    await this.refresh();
  }

  /**
   * 拉取 manifest，只重新下载 SHA 发生变化的分片。
   *
   * 这是"提升索引速度"的关键：一次刷新固定是 3 次 Contents API 调用（三张表的
   * manifest），加上真正变化的分片。旧方案每次查询都要下载全量 CSV。
   *
   * @param {object} options
   * @param {boolean} options.force 忽略 manifest 自身 SHA 是否变化，强制逐分片比对
   * @param {string[]} options.tables 只刷新指定表（写入前校验 SHA 时用，省掉无关表的请求）
   * @param {boolean} options.preferRemote 冲突时以远端为准（人工核对/恢复场景），
   *   默认以本地为准（正常写入场景，本地才包含尚未提交的改动）
   */
  async refresh({ force = false, tables = TABLES, preferRemote = false } = {}) {
    const targets = tables.filter((table) => TABLES.includes(table));
    const manifests = await Promise.all(
      targets.map((table) => this.github.getFile(this.manager.manifestPath(table))),
    );

    for (const [index, table] of targets.entries()) {
      const file = manifests[index];
      const sha = file ? file.sha : null;

      if (!force && this.ready && this.manifestSha[table] === sha) {
        continue;
      }

      const entries = file ? this.manager.parseManifest(file.content) : new Map();

      await this.syncTable(table, entries, { preferRemote });
      this.manifestSha[table] = sha;
    }

    this.ready = true;
    this.lastRefresh = Date.now();
  }

  /** 让某张表的内存状态与 manifest 对齐：更新清单、重新下载"已加载范围内"变化的分片。 */
  async syncTable(table, entries, { preferRemote = false } = {}) {
    const state = this.tables[table];
    const next = new Map(entries);

    // 本地新建、尚未提交的分片不在远端 manifest 里，必须补进权威清单，
    // 否则下一次重建 manifest 会把它漏掉（文件在仓库里却读不到）
    for (const [path, pending] of this.pending) {
      if (pending.table !== table || next.has(path)) {
        continue;
      }
      const shard = state.shards.get(path);

      if (shard && shard.rows.length > 0) {
        next.set(path, {
          path,
          rowCount: shard.rows.length,
          sha: shard.sha ?? null,
          updatedAt: null,
          minKey: '',
          maxKey: '',
        });
      }
    }

    const targets = [];
    const removals = [];

    for (const [path, entry] of next) {
      const cached = state.shards.get(path);

      // SHA 相同说明本地内容与远端一致；即使本地有未提交改动也不需要重新下载，
      // 因为待提交分片是"整文件重写"，本地内容就是完整版本。
      if (cached && cached.sha === entry.sha) {
        continue;
      }
      // 只重新下载"已经加载过"的分片；未加载的族留给 ensureFamily 按需加载
      if (this.isLoadedPath(table, path)) {
        targets.push(path);
      }
    }
    for (const path of state.shards.keys()) {
      if (!next.has(path) && !this.pending.has(path)) {
        removals.push(path);
      }
    }

    state.entries = next;
    this.rebuildFamilies(table);

    for (const path of removals) {
      this.unindexShard(table, path);
      state.shards.delete(path);
    }

    if (targets.length > 0) {
      await this.loadShards(table, targets, { preferRemote: false });
    }

    return state;
  }

  /**
   * 下载并合并一批分片。
   *
   * @param {boolean} options.preferRemote true 时用远端内容整体覆盖本地（人工核对/恢复）
   */
  async loadShards(table, paths, { preferRemote = false } = {}) {
    const state = this.tables[table];
    // 调用方负责挑选路径：ensureFamily/ensureAll 只传未加载的，
    // syncTable 则传"已加载但 SHA 变了"的——两者都要真的下载
    const targets = paths;

    for (let start = 0; start < targets.length; start += this.parallelism) {
      const batch = targets.slice(start, start + this.parallelism);
      const files = await Promise.all(batch.map((path) => this.github.getFile(path)));

      for (const [offset, path] of batch.entries()) {
        const file = files[offset];
        const remoteRows = file ? this.manager.parseShard(file.content) : [];

        this.mergeShard(table, path, remoteRows, state.entries.get(path)?.sha ?? null, { preferRemote });
      }
    }
  }

  /** 该分片是否处在"已加载范围"内（已加载的族，或整表已加载）。 */
  isLoadedPath(table, path) {
    const state = this.tables[table];

    if (state.allLoaded) {
      return true;
    }
    const family = this.manager.familyOf(path);

    return Boolean(family && state.loadedFamilies.has(family));
  }

  /** 加载指定的族（幂等：已加载过就直接返回）。 */
  async ensureFamily(table, prefix) {
    const state = this.tables[table];

    if (state.allLoaded || state.loadedFamilies.has(prefix)) {
      return;
    }
    const paths = [...(state.families.get(prefix) ?? EMPTY_SET)].filter((path) => !state.shards.has(path));

    await this.loadShards(table, paths);
    state.loadedFamilies.add(prefix);
  }

  /** 加载多族：常见于 url IN (…) 这类跨文章的查询。 */
  async ensureFamilies(table, prefixes) {
    const list = [...prefixes];

    for (let start = 0; start < list.length; start += this.parallelism) {
      await Promise.all(list.slice(start, start + this.parallelism).map((prefix) => this.ensureFamily(table, prefix)));
    }
  }

  /** 加载整张表：无法把查询收敛到某个族时使用。 */
  async ensureAll(table) {
    const state = this.tables[table];

    if (state.allLoaded) {
      return;
    }
    await this.loadShards(table, [...state.entries.keys()].filter((path) => !state.shards.has(path)));
    state.allLoaded = true;
  }

  /**
   * 判断 where 能否收敛到若干分片族。
   *
   * 只有"分片 key 上的等值 / IN"能定位族；`_complex` 单独出现时，
   * 只有它的每个分支都作用在分片 key 上才安全（外层条件作用于每个分支，
   * 所以外层命中分片 key 就已经足够）。
   *
   * @returns {{complete: boolean, prefixes: Set<string>|null}}
   *   complete=false 表示必须整表加载，否则结果可能不完整。
   */
  scopeFor(table, where) {
    const keyField = this.manager.shardKeyField(table);
    const prefixesOf = (condition) => {
      if (Array.isArray(condition)) {
        const operator = String(condition[0] ?? '').toUpperCase();

        if (operator === 'IN' && Array.isArray(condition[1])) {
          return new Set(condition[1].map((value) => this.manager.shardPrefix(table, toCell(value))));
        }

        return null;
      }
      if (condition !== null && typeof condition === 'object') {
        return condition instanceof Date
          ? new Set([this.manager.shardPrefix(table, toCell(condition))])
          : null;
      }

      // undefined 表示"该列为空"，同样落在 key='' 的那个族里
      return new Set([this.manager.shardPrefix(table, condition === undefined ? '' : toCell(condition))]);
    };

    if (where && typeof where === 'object') {
      if (Object.prototype.hasOwnProperty.call(where, keyField)) {
        const prefixes = prefixesOf(where[keyField]);

        return prefixes ? { complete: true, prefixes } : { complete: false, prefixes: null };
      }

      const complex = where._complex;

      if (complex && typeof complex === 'object') {
        const union = new Set();
        let complete = true;

        for (const [field, condition] of Object.entries(complex)) {
          if (field === '_logic') {
            continue;
          }
          if (field !== keyField) {
            complete = false;
            break;
          }
          const prefixes = prefixesOf(condition);

          if (!prefixes) {
            complete = false;
            break;
          }
          for (const prefix of prefixes) {
            union.add(prefix);
          }
        }

        if (complete && union.size > 0) {
          return { complete: true, prefixes: union };
        }
      }
    }

    return { complete: false, prefixes: null };
  }

  /** 为一次查询准备加载范围。返回 null 表示整表已加载。 */
  async ensureScope(table, where) {
    const scope = this.scopeFor(table, where);

    if (!scope.complete) {
      await this.ensureAll(table);

      return null;
    }
    await this.ensureFamilies(table, scope.prefixes);

    return scope.prefixes;
  }

  /**
   * 以仓库的真实文件列表为准重建索引，并把被改动的分片标记为待提交
   * （下一次 flush 会顺带把 manifest 修正回来）。
   *
   * 为什么需要它：正常读路径只信任 manifest 记录的分片 SHA —— 这样才能用
   * 1 次请求判断"哪些分片变了"。如果有人直接改了仓库里的 CSV（这正是把数据
   * 放在仓库里的意义之一），manifest 就落后了，需要显式触发一次全量核对。
   *
   * 这是全量核对，因此会把整张表加载进来。
   *
   * @returns {{changed: number, tables: string[]}}
   */
  async syncFromTree() {
    const files = await this.github.listTree(`${this.manager.storeDir}/`);
    const changedTables = new Set();
    let changed = 0;

    for (const table of TABLES) {
      const entries = new Map();

      for (const [path, meta] of files) {
        if (this.manager.parseShardPath(path)?.table === table) {
          entries.set(path, { path, sha: meta.sha, rowCount: 0, updatedAt: null, minKey: '', maxKey: '' });
        }
      }

      const before = new Map([...this.tables[table].shards].map(([path, shard]) => [path, shard.sha]));
      // 以仓库为准整体重来：先清空内存，再标记"整表已加载"让 syncTable 全量下载
      this.tables[table] = CsvShardCache.emptyTable();
      this.tables[table].allLoaded = true;
      await this.syncTable(table, entries, { preferRemote: true });

      for (const [path, shard] of this.tables[table].shards) {
        if (before.get(path) !== shard.sha) {
          this.pendingEntry(path, table);
          changed += 1;
          changedTables.add(table);
        }
      }
      this.manifestSha[table] = null;
    }

    this.ready = true;
    this.lastRefresh = Date.now();

    return { changed, tables: [...changedTables] };
  }

  // --------------------------------------------------------------------------
  // 索引：分片级增量维护
  // --------------------------------------------------------------------------

  /** 重建某张表的全部索引。只在整表重写（compact / 回滚 / 冷重置）后调用。 */
  rebuildIndexes(table) {
    const state = this.tables[table];
    const indexedFields = this.manager.indexedFields(table);

    state.byId = new Map();
    state.byField = new Map();

    for (const field of indexedFields) {
      state.byField.set(field, new Map());
    }

    for (const [shardPath, shard] of state.shards) {
      for (const row of shard.rows) {
        const objectId = row.objectId ?? '';

        if (!objectId) {
          continue;
        }

        state.byId.set(objectId, { shardPath, row });
        this.indexRow(state, table, row);
      }
    }
  }

  /** 把一整个分片的行登记进索引。 */
  indexShard(table, path) {
    const state = this.tables[table];
    const shard = state.shards.get(path);

    if (!shard) {
      return;
    }
    for (const row of shard.rows) {
      const objectId = row.objectId ?? '';

      if (!objectId) {
        continue;
      }
      state.byId.set(objectId, { shardPath: path, row });
      this.indexRow(state, table, row);
    }
  }

  /** 把一整个分片的行从索引里摘掉（内容被替换或分片被删除前调用）。 */
  unindexShard(table, path) {
    const state = this.tables[table];
    const shard = state.shards.get(path);

    if (!shard) {
      return;
    }
    for (const row of shard.rows) {
      this.unindexRow(state, table, row);
    }
  }

  /** 把一行登记进各字段的倒排桶（byId 由调用方维护，因为只有调用方知道行号归属）。 */
  indexRow(state, table, row) {
    const objectId = row.objectId ?? '';

    for (const field of this.manager.indexedFields(table)) {
      const value = row[field] ?? '';
      let bucket = state.byField.get(field);

      // 懒初始化：新建的表状态里还没有该字段的桶（rebuildIndexes 可能尚未跑过）
      if (!bucket) {
        bucket = new Map();
        state.byField.set(field, bucket);
      }
      if (!bucket.has(value)) {
        bucket.set(value, new Set());
      }
      bucket.get(value).add(objectId);
    }
  }

  unindexRow(state, table, row) {
    const objectId = row.objectId ?? '';

    for (const field of this.manager.indexedFields(table)) {
      const value = row[field] ?? '';
      const bucket = state.byField.get(field);

      bucket?.get(value)?.delete(objectId);
    }
    state.byId.delete(objectId);
  }

  /** 族索引是清单的投影：清单变了就重建（O(分片数)，只在刷新时发生）。 */
  rebuildFamilies(table) {
    const state = this.tables[table];
    const families = new Map();

    for (const path of state.entries.keys()) {
      const family = this.manager.familyOf(path);

      if (!family) {
        continue;
      }
      if (!families.has(family)) {
        families.set(family, new Set());
      }
      families.get(family).add(path);
    }

    state.families = families;
  }

  /**
   * 把远端分片内容并入本地。
   *
   * 合并规则（默认本地优先，因为本地是本实例对外的权威视图）：
   *   1. 本地已存在的 objectId → 保留本地版本（含本实例尚未提交的修改）；
   *      计数类表（Counter）例外：数值列按"远端值 + 本地增量"合并
   *   2. 本地已删除的 objectId → 尊重删除，不复活
   *   3. 其余远端行 → 追加（这些是别的实例写入、本实例还没见过的数据）
   *
   * preferRemote 为真时改用"远端整体覆盖本地"：这是人工核对场景（rebuild），
   * 语义是"以仓库里的文件为准"，此时本地可能正是过期的那个副本。
   */
  mergeShard(table, path, remoteRows, sha, { preferRemote = false } = {}) {
    const state = this.tables[table];
    let shard = state.shards.get(path);

    if (!shard) {
      shard = { rows: [], sha: null };
      state.shards.set(path, shard);
      if (!state.entries.has(path)) {
        state.entries.set(path, { path, rowCount: 0, sha: null, updatedAt: null, minKey: '', maxKey: '' });
      }
      const family = this.manager.familyOf(path);

      if (family) {
        if (!state.families.has(family)) {
          state.families.set(family, new Set());
        }
        state.families.get(family).add(path);
      }
    }

    if (preferRemote) {
      this.unindexShard(table, path);
      shard.rows = remoteRows.map((row) => this.manager.normalizeRow(table, row));
      shard.sha = sha;
      this.pending.delete(path);
      this.indexShard(table, path);

      return shard;
    }

    const pending = this.pending.get(path);
    const localById = new Map(shard.rows.map((row) => [row.objectId ?? '', row]));

    for (const remote of remoteRows) {
      const objectId = remote.objectId ?? '';

      if (!objectId) {
        continue;
      }
      const local = localById.get(objectId);

      if (local) {
        // 同一行两边都有：默认保留本地版本；计数类表改用"远端值 + 本地增量"
        if (DELTA_MERGE_TABLES.has(table)) {
          this.applyRemoteDelta(local, remote, pending?.deltas?.get(objectId));
        }
        continue;
      }
      if (pending?.deleted.has(objectId)) {
        continue;
      }
      const row = this.manager.normalizeRow(table, remote);

      shard.rows.push(row);
      localById.set(objectId, row);
      state.byId.set(objectId, { shardPath: path, row });
      this.indexRow(state, table, row);
    }

    shard.sha = sha;

    return shard;
  }

  /**
   * 去重指纹：mail + url + 内容哈希。
   *
   * 刻意不建全局倒排索引：10 万条评论下这样一份 Map<hash, Set> 实测要占 20MB 以上
   * （占总量近四分之一），而去重只在新增评论时用到，按 url 命中桶现算一遍
   * （一篇文章几十条）成本可以忽略。
   */
  dedupHash(row) {
    if (!row || !row.comment) {
      return '';
    }

    return sha1(`${row.mail ?? ''}\u0000${row.url ?? ''}\u0000${row.comment ?? ''}`);
  }

  // --------------------------------------------------------------------------
  // 查询
  // --------------------------------------------------------------------------

  *iterateRows(table) {
    for (const shard of this.tables[table].shards.values()) {
      yield* shard.rows;
    }
  }

  /** 只遍历指定族里的已加载分片。 */
  *iterateFamilyRows(table, prefixes) {
    const state = this.tables[table];

    for (const prefix of prefixes) {
      for (const path of state.families.get(prefix) ?? EMPTY_SET) {
        const shard = state.shards.get(path);

        if (shard) {
          yield* shard.rows;
        }
      }
    }
  }

  /**
   * 按主键取一行。
   *
   * Users 的分片 key 就是 objectId，因此可以直接定位到族；其它表的 objectId
   * 与分片位置无关，只能整表加载后查（调用方应当尽量用带 url 的条件查询）。
   */
  async getRow(table, objectId) {
    const state = this.tables[table];

    if (this.manager.shardKeyField(table) === 'objectId') {
      await this.ensureFamily(table, this.manager.shardPrefix(table, objectId ?? ''));

      return state.byId.get(objectId) ?? null;
    }
    await this.ensureAll(table);

    return state.byId.get(objectId) ?? null;
  }

  shardPathOf(table, objectId) {
    return this.tables[table].byId.get(objectId)?.shardPath ?? null;
  }

  /**
   * 用索引把候选集从"全表"缩小到"命中桶"。
   * 返回 null 表示没有可用索引（只能全表扫描），返回空集表示确定没有匹配行。
   */
  narrowCandidates(table, where) {
    if (!where || typeof where !== 'object') {
      return null;
    }
    const state = this.tables[table];
    const indexedFields = this.manager.indexedFields(table);
    let result = null;
    const intersect = (ids) => {
      if (result === null) {
        result = ids;

        return;
      }
      const next = new Set();

      for (const id of result) {
        if (ids.has(id)) {
          next.add(id);
        }
      }
      result = next;
    };

    const collect = (field, condition, lookup) => {
      if (condition === undefined || condition === null) {
        return;
      }
      if (!Array.isArray(condition)) {
        // 用 toCell 而不是 String()：条件值是 Date 时必须落成 ISO 字符串，
        // 否则拿本地化时间去查桶，候选集为空、查询静默返回空结果
        intersect(lookup(toCell(condition)));

        return;
      }
      const operator = String(condition[0] ?? '').toUpperCase();

      if (operator === 'IN' && Array.isArray(condition[1])) {
        const union = new Set();

        for (const value of condition[1]) {
          for (const id of lookup(String(value)) ?? EMPTY_SET) {
            union.add(id);
          }
        }
        intersect(union);
      }
      // 其它操作符（!= / NOT IN / LIKE / >）无法用等值索引安全缩小范围，跳过
    };

    for (const [field, condition] of Object.entries(where)) {
      if (field === '_complex') {
        continue;
      }
      if (field === 'objectId') {
        collect(field, condition, (value) => (state.byId.has(value) ? new Set([value]) : EMPTY_SET));
        continue;
      }
      if (!indexedFields.includes(field)) {
        continue;
      }
      collect(field, condition, (value) => state.byField.get(field)?.get(value) ?? EMPTY_SET);
    }

    return result;
  }

  /**
   * 返回命中 where 的行引用（不投影、不分页），供 update / delete 使用。
   *
   * 会先把查询所需的分片族加载好：能收敛到族的查询只加载命中族，
   * 收敛不了（后台列表、按 pid/rid 删除等）则整表加载，保证结果完整。
   */
  async filterRows(table, where) {
    const prefixes = await this.ensureScope(table, where);
    const matcher = compileWhere(where);
    const candidates = this.narrowCandidates(table, where);
    const state = this.tables[table];
    const matched = [];

    if (candidates === null) {
      const rows = prefixes === null ? this.iterateRows(table) : this.iterateFamilyRows(table, prefixes);

      for (const row of rows) {
        if (matcher(row)) {
          matched.push(row);
        }
      }

      return matched;
    }

    for (const objectId of candidates) {
      const entry = state.byId.get(objectId);

      if (entry && matcher(entry.row)) {
        matched.push(entry.row);
      }
    }

    return matched;
  }

  /** 应用 where 与投影，并按 { order | desc, limit, offset, field } 返回结果。 */
  async select(table, where, { desc, field, limit, offset, order } = {}) {
    const matched = await this.filterRows(table, where);
    const normalizedOrder = normalizeOrder(order, desc, (orderField) =>
      orderField === 'id' ? 'objectId' : orderField,
    );

    if (normalizedOrder.length > 0) {
      matched.sort(compareByOrder(normalizedOrder));
    }

    const start = offset ?? 0;
    const sliced = matched.slice(start, limit ? start + limit : undefined);

    return sliced.map((row) => this.projectRow(row, field));
  }

  async count(table, where = {}, { group } = {}) {
    const rows = await this.filterRows(table, where);

    if (!group) {
      return rows.length;
    }

    const counts = new Map();

    for (const row of rows) {
      const key = group.map((field) => row[field] ?? '').join(',');
      let bucket = counts.get(key);

      if (!bucket) {
        bucket = { count: 0 };

        for (const field of group) {
          bucket[field] = row[field] ?? '';
        }
        counts.set(key, bucket);
      }
      bucket.count += 1;
    }

    return [...counts.values()];
  }

  /**
   * 投影。`id` 是 Waline 上游内部的别名（logic/base.js 会传 field: ['id', ...]），
   * 统一映射到 objectId；objectId 永远保留，因为控制器大量依赖它。
   *
   * 返回的一定是新对象：控制器（如 formatCmt）会对结果做 delete / 覆盖写，
   * 直接返回缓存中的行会污染缓存。
   */
  projectRow(row, field) {
    if (!field || field.length === 0) {
      return { ...row };
    }

    const projection = {};

    for (const name of field) {
      const key = name === 'id' ? 'objectId' : name;

      if (key in row) {
        projection[key] = row[key];
      }
    }
    projection.objectId = row.objectId ?? '';

    return projection;
  }

  // --------------------------------------------------------------------------
  // 变更（内存权威视图，落盘由写入队列负责）
  // --------------------------------------------------------------------------

  /** 为分片族统计行数，供"填满优先 / 触发裂变"的写入路由使用。 */
  familyRowCounts(table, prefix) {
    const state = this.tables[table];
    const counts = new Map();

    for (const path of state.families.get(prefix) ?? EMPTY_SET) {
      const shard = state.shards.get(path);

      if (shard) {
        counts.set(path, shard.rows.length);
        continue;
      }
      // 族内分片在 ensureFamily 之后应当都已加载；这里兜底用清单里的行数
      const meta = state.entries.get(path);

      if (meta) {
        counts.set(path, meta.rowCount);
      }
    }

    return counts;
  }

  /** 确保分片在缓存中存在（写入新分片、或从 manifest 新发现的分片）。 */
  ensureShard(table, path) {
    const state = this.tables[table];
    let shard = state.shards.get(path);

    if (!shard) {
      shard = { rows: [], sha: null };
      state.shards.set(path, shard);
      if (!state.entries.has(path)) {
        state.entries.set(path, { path, rowCount: 0, sha: null, updatedAt: null, minKey: '', maxKey: '' });
      }
      const family = this.manager.familyOf(path);

      if (family) {
        if (!state.families.has(family)) {
          state.families.set(family, new Set());
        }
        state.families.get(family).add(path);
      }
    }

    return shard;
  }

  /** 新增一行，返回其落点分片路径。 */
  async applyAdd(table, row) {
    const keyField = this.manager.shardKeyField(table);
    const key = row[keyField] ?? '';
    const prefix = this.manager.shardPrefix(table, key);

    // 写入前必须加载目标族：落点选择要读族内各分片的行数
    await this.ensureFamily(table, prefix);

    const path = this.manager.resolveWriteShard(table, key, this.familyRowCounts(table, prefix));
    const shard = this.ensureShard(table, path);

    // 顺序很关键：先标脏（采集回滚基线），再动 shard.rows
    this.pendingEntry(path, table);

    shard.rows.push(row);

    const state = this.tables[table];

    state.byId.set(row.objectId, { shardPath: path, row });
    this.indexRow(state, table, row);

    return path;
  }

  /**
   * 就地修改一行。返回修改后的行，找不到则返回 null。
   *
   * 之所以要"就地修改"而不是替换行对象：byId 里存的是行引用，
   * 就地改可以保证任何已持有该引用的索引视图立即生效。
   */
  applyUpdate(table, objectId, patch) {
    const entry = this.tables[table].byId.get(objectId);

    if (!entry) {
      return null;
    }
    const state = this.tables[table];
    const pending = this.pendingEntry(entry.shardPath, table);
    const trackDelta = DELTA_MERGE_TABLES.has(table);
    const deltaFields = trackDelta ? Object.keys(patch ?? {}) : [];
    // 增量必须在改动之前取值：我们要的是"本次更新施加了多少"，不是最终值
    const before = trackDelta ? deltaFields.map((key) => entry.row[key]) : null;

    this.unindexRow(state, table, entry.row);

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'objectId') {
        continue;
      }
      // 用 toCell 而不是 String()：Date 必须落成 ISO，否则 updatedAt 会写成
      // "Thu Sep 25 2026 …" 这种本地化字符串，与既有数据格式不一致
      entry.row[key] = toCell(value);
    }
    entry.row.updatedAt = new Date().toISOString();

    if (trackDelta) {
      deltaFields.forEach((key, index) => {
        const from = numericOf(before[index]);
        const to = numericOf(entry.row[key]);

        if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
          this.recordDelta(pending, objectId, key, to - from);
        }
      });
    }

    state.byId.set(objectId, entry);
    this.indexRow(state, table, entry.row);

    return entry.row;
  }

  /** 累计某行某字段的增量：同一行的多次自增要相加，而不是互相覆盖。 */
  recordDelta(pending, objectId, field, delta) {
    if (!pending.deltas) {
      pending.deltas = new Map();
    }
    let fields = pending.deltas.get(objectId);

    if (!fields) {
      fields = new Map();
      pending.deltas.set(objectId, fields);
    }
    fields.set(field, (fields.get(field) ?? 0) + delta);
  }

  /**
   * 用远端行刷新本地行的数值列：结果 = 远端值 + 本实例施加的增量。
   *
   * 没有增量时（纯读取刷新）等价于"远端优先"，这正是计数器该有的语义：
   * 计数只会由增量推进，不存在"本地有个更权威的绝对值"。
   */
  applyRemoteDelta(localRow, remoteRow, deltas) {
    for (const [key, value] of Object.entries(remoteRow)) {
      if (key === 'objectId') {
        continue;
      }
      const remoteNumber = numericOf(value);

      if (!Number.isFinite(remoteNumber)) {
        continue;
      }
      localRow[key] = toCell(remoteNumber + (deltas?.get(key) ?? 0));
    }

    // 非数值列（url 等）保持本地优先；时间戳取较新的那个，方便排障
    if (
      remoteRow.updatedAt &&
      (!localRow.updatedAt || compareValues(remoteRow.updatedAt, localRow.updatedAt) > 0)
    ) {
      localRow.updatedAt = toCell(remoteRow.updatedAt);
    }
  }

  /** 删除一行。返回其所在分片路径。 */
  applyDelete(table, objectId) {
    const entry = this.tables[table].byId.get(objectId);

    if (!entry) {
      return null;
    }
    const state = this.tables[table];
    const shard = state.shards.get(entry.shardPath);

    const pending = this.pendingEntry(entry.shardPath, table);

    this.unindexRow(state, table, entry.row);

    if (shard) {
      const index = shard.rows.indexOf(entry.row);

      if (index !== -1) {
        shard.rows.splice(index, 1);
      }
    }

    // 记下删除的 objectId：与远端分片合并时靠它区分"我们删的"与"别人新增的"
    pending.deleted.add(objectId);

    return entry.shardPath;
  }

  // --------------------------------------------------------------------------
  // 分片合并（compaction）
  // --------------------------------------------------------------------------

  /** 按"族"归组：族前缀 → (分片路径 → 行数)。 */
  familiesOf(table) {
    const families = new Map();

    for (const [family, paths] of this.tables[table].families) {
      const counts = new Map();

      for (const path of paths) {
        const shard = this.tables[table].shards.get(path);

        if (shard) {
          counts.set(path, shard.rows.length);
        }
      }
      if (counts.size > 0) {
        families.set(family, counts);
      }
    }

    return families;
  }

  /**
   * 把"行数已回落到阈值以内"的分片族压缩回基础分片。
   *
   * 只做整族搬迁，不做跨族搬运：这样一次合并永远是"写一个文件 + 删若干文件"，
   * 落在一次 Git 提交里是原子的，也不影响其他族。
   *
   * 需要整表加载：合并要读到族内全部行。
   *
   * @returns {{merged: number, removed: number}} 合并的族数与删除的分片数
   */
  async compact(table) {
    await this.ensureAll(table);

    const state = this.tables[table];
    let merged = 0;
    let removed = 0;

    for (const [family, counts] of this.familiesOf(table)) {
      const plan = this.manager.planMerge(family, counts);

      if (!plan) {
        continue;
      }
      const rows = [];

      for (const path of plan.sources) {
        const shard = state.shards.get(path);

        if (shard) {
          rows.push(...shard.rows.map((row) => ({ ...row })));
        }
      }

      const target = this.ensureShard(table, plan.target);

      // 先标脏（采基线、记录待提交），再整体替换内容
      this.pendingEntry(plan.target, table);
      this.unindexShard(table, plan.target);
      target.rows = rows;
      this.indexShard(table, plan.target);

      for (const path of plan.sources) {
        if (path === plan.target) {
          continue;
        }
        const shard = state.shards.get(path);

        if (shard) {
          // 先清空，写入队列看到空分片就会去仓库删掉它
          for (const row of shard.rows) {
            this.pendingEntry(path, table).deleted.add(row.objectId);
          }
          this.unindexShard(table, path);
          shard.rows = [];
          this.pendingEntry(path, table);
          removed += 1;
        }
      }
      merged += 1;
    }

    if (merged > 0) {
      this.rebuildIndexes(table);
    }

    return { merged, removed };
  }

  // --------------------------------------------------------------------------
  // 提交辅助
  // --------------------------------------------------------------------------

  /** 取出待提交分片的回滚基线（在分片首次变脏时已经采好）。 */
  snapshotShards(paths) {
    const baselines = new Map();

    for (const path of paths) {
      const entry = this.pending.get(path);
      const baseline = this.baselines.get(path);

      if (entry && baseline) {
        baselines.set(path, baseline);
      }
    }

    return baselines;
  }

  /**
   * 用基线恢复分片（提交最终失败时回滚内存视图）。
   *
   * rows 与 sha 必须一起恢复：只恢复 rows 会让本地 SHA 停留在"别人写过的版本"上，
   * 下一次刷新就会因为 SHA 对得上而跳过下载，那些别人的行就再也回不到内存里了。
   */
  restoreShards(baselines) {
    for (const [path, baseline] of baselines) {
      const state = this.tables[baseline.table];

      if (baseline.existed) {
        const shard = this.ensureShard(baseline.table, path);

        this.unindexShard(baseline.table, path);
        shard.rows = baseline.rows.map((row) => ({ ...row }));
        shard.sha = baseline.sha;
        const meta = state.entries.get(path);

        if (meta) {
          meta.sha = baseline.sha;
          meta.rowCount = shard.rows.length;
        } else {
          state.entries.set(path, {
            path,
            rowCount: shard.rows.length,
            sha: baseline.sha,
            updatedAt: null,
            minKey: '',
            maxKey: '',
          });
        }
        this.indexShard(baseline.table, path);
      } else {
        // 本次请求刚创建的分片：回滚后它不应该存在
        this.unindexShard(baseline.table, path);
        state.shards.delete(path);
        state.entries.delete(path);
        const family = this.manager.familyOf(path);

        if (family) {
          state.families.get(family)?.delete(path);
        }
      }
    }
  }

  /**
   * 标记提交成功。
   *
   * shardShas 由写入队列在提交前用 git blob 算法在本地算好（GitHub 的
   * blob SHA 就是 sha1("blob <len>\0<content>")）。这样下一次刷新 manifest 时
   * SHA 天然对得上，不会把我们刚写进去的分片再下载一遍——否则"刷新"反而成了
   * 新的流量浪费源。
   */
  markClean(shardShas) {
    const touched = new Set();

    for (const [path, sha] of shardShas) {
      const entry = this.pending.get(path);

      this.pending.delete(path);
      this.baselines.delete(path);

      if (!entry) {
        continue;
      }
      const state = this.tables[entry.table];
      const shard = state.shards.get(path);
      const meta = state.entries.get(path);

      if (shard) {
        shard.sha = sha;
      }
      if (meta) {
        meta.sha = sha;
        meta.rowCount = shard ? shard.rows.length : meta.rowCount;
        meta.updatedAt = new Date().toISOString();
      }
      touched.add(entry.table);
    }

    return touched;
  }

  /** 提交成功后移除已清空的分片（远端文件也已删除）。 */
  markDeleted(paths) {
    for (const path of paths) {
      const entry = this.pending.get(path);

      this.pending.delete(path);
      this.baselines.delete(path);

      if (!entry) {
        continue;
      }
      const state = this.tables[entry.table];

      this.unindexShard(entry.table, path);
      state.shards.delete(path);
      state.entries.delete(path);
      const family = this.manager.familyOf(path);

      if (family) {
        state.families.get(family)?.delete(path);
      }
    }
  }

  /** 提交失败后丢弃待提交标记，回到"以远端为准"的干净状态。 */
  discardPending(paths) {
    for (const path of paths) {
      this.pending.delete(path);
      this.baselines.delete(path);
    }
  }

  /** 仅用于测试与恢复流程：清空全部内存状态。 */
  reset() {
    for (const table of TABLES) {
      this.tables[table] = CsvShardCache.emptyTable();
      this.manifestSha[table] = null;
    }
    this.pending.clear();
    this.baselines.clear();
    this.ready = false;
    this.lastRefresh = 0;
  }
}

module.exports = { CsvShardCache, compileWhere, compareValues, TABLES };
