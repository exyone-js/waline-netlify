'use strict';

/**
 * 分片策略、分片定位、manifest 维护与分片级 CSV 编解码。
 *
 * 为什么把"表结构 + 分片规则 + CSV 编解码"放在一起：
 * 这三者共同定义了"存储格式"这一唯一的真相来源（single source of truth）。
 * 缓存、写入队列、快照都只是这套格式的使用者，不各自复制一份规则。
 *
 * ---------------------------------------------------------------------------
 * 分片规则（稳定可预测，纯由 key 决定，不依赖任何运行时状态）
 * ---------------------------------------------------------------------------
 *   Comment: <base>/comments/<sha1(url)[0:2]>/<sha1(url)[0:4]>.csv
 *   Counter: <base>/counters/<sha1(url)[0:2]>/<sha1(url)[0:4]>.csv
 *   Users  : <base>/users/<objectId[0:2]>/<objectId[0:2]>.csv
 *
 * 为什么 Comment/Counter 用 url 哈希的 4 位前缀做文件名：
 *   同一篇文章的评论必然落在同一个分片族里，按文章查询只需读取一个分片，
 *   局部写入也只影响一个分片，不会像单文件方案那样"改一条评论重写全表"。
 *   文件名前缀长度 = SHARD_HASH_LEN + 2，可通过环境变量调整（前缀越长分片越多越小）。
 *
 * 为什么 Users 只用 2 位前缀且"目录名 = 文件名"：
 *   Users 的分片 key 是 objectId，一个 key 只对应一行。若照搬 4 位前缀，
 *   10 万用户会产生约 10 万个一行的小文件，仓库体积与管理成本都会失控。
 *   用 2 位前缀把分片数收敛到有限个桶（十六进制 256 个 / 这里用 objectId 原字符集），
 *   每个分片容纳成百上千行，既均匀又有界。
 *
 * 分片裂变：分片族内任一文件行数达到 SHARD_MAX_ROWS 后，新记录写入
 *   `<prefix>-1.csv`、`<prefix>-2.csv` …，保证单个 CSV 不会无限增长。
 * 分片合并：族内总行数回落到阈值以内时，可压缩回基础分片（见 planMerge）。
 */

const { createHash } = require('node:crypto');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

/** 表 → 存储子目录。 */
const TABLE_DIR = {
  Comment: 'comments',
  Users: 'users',
  Counter: 'counters',
};

/**
 * 每张表的规范列。
 *
 * 注意：这里必须与 Waline 上层业务实际读写的字段完全一致（见
 * @waline/vercel/src/service/storage/github.js 的 CSV_HEADERS 与各 controller
 * 的 select/update 字段）。内部主键统一用 `objectId`——不再像上游那样在
 * `id` 与 `objectId` 之间来回映射，那是"主键写不进 CSV"这类历史故障的根源。
 *
 * 规范列只是"保底列"：控制器还会用到 sticky / like / 2fa / 自定义计数器类型
 * 等动态列，这些列会以"规范列 ∪ 实际出现的动态列"的形式写入分片表头，
 * 从而既稳定又不丢字段（上游用 fast-csv 的 headers:true，会把首个写入行
 * 之外的额外字段整列丢弃）。
 */
const TABLE_COLUMNS = {
  Comment: [
    'objectId',
    'user_id',
    'comment',
    'insertedAt',
    'ip',
    'link',
    'mail',
    'nick',
    'pid',
    'rid',
    'status',
    'ua',
    'url',
    'createdAt',
    'updatedAt',
  ],
  Counter: ['objectId', 'time', 'url', 'createdAt', 'updatedAt'],
  Users: [
    'objectId',
    'display_name',
    'email',
    'password',
    'type',
    'url',
    'avatar',
    'label',
    'github',
    'twitter',
    'facebook',
    'google',
    'weibo',
    'qq',
    'oidc',
    'createdAt',
    'updatedAt',
  ],
};

/** 需要按时间语义比较的字段：排序与范围过滤都要把字符串还原成时间戳。 */
const DATE_FIELDS = new Set(['insertedAt', 'createdAt', 'updatedAt']);

/** 参与内存索引的字段（用于把查询候选集从"全表"缩小到"命中桶"）。 */
const INDEXED_FIELDS = {
  Comment: ['url', 'status', 'user_id'],
  Users: ['email'],
  Counter: ['url'],
};

/** 分片 key 字段。 */
const SHARD_KEY_FIELD = {
  Comment: 'url',
  Users: 'objectId',
  Counter: 'url',
};

const MANIFEST_HEADER = ['shard_path', 'row_count', 'sha', 'updated_at', 'min_key', 'max_key'];

const sha1 = (value) => createHash('sha1').update(String(value), 'utf8').digest('hex');

/** 把任意值规范成 CSV 可承载的字符串。 */
const toCell = (value) => {
  if (value === undefined || value === null) {
    return '';
  }
  if (value instanceof Date) {
    // 统一存 ISO 8601：字典序 == 时间序，字符串比较（>= / >）与 new Date() 都成立
    return value.toISOString();
  }
  if (typeof value === 'object') {
    // CSV 无法承载结构，退化成 JSON 而不是 "[object Object]" 这种不可逆的字符串
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return value;
  }

  return String(value);
};

class ShardManager {
  /**
   * @param {object} options
   * @param {string} options.storeDir  数据根目录（仓库根相对路径，默认 data）
   * @param {number} options.shardMaxRows 单分片行数上限
   * @param {number} options.hashLen   目录哈希前缀长度
   */
  constructor({ storeDir = 'data', shardMaxRows = 2000, hashLen = 2 } = {}) {
    this.storeDir = String(storeDir).replace(/^\/+|\/+$/gu, '');
    this.shardMaxRows = shardMaxRows;
    this.hashLen = hashLen;
    this.snapshotDir = `${this.storeDir}/_snapshots`;
  }

  tableDir(table) {
    const dir = TABLE_DIR[table];

    if (!dir) {
      throw new Error(`未知的数据表 "${table}"，仅支持 Comment / Users / Counter`);
    }

    return dir;
  }

  columns(table) {
    return TABLE_COLUMNS[table];
  }

  indexedFields(table) {
    return INDEXED_FIELDS[table];
  }

  shardKeyField(table) {
    return SHARD_KEY_FIELD[table];
  }

  minKeyOf(table, row) {
    return toCell(row[SHARD_KEY_FIELD[table]]);
  }

  /** 分片族前缀（不含 .csv 与裂变后缀），是"同 key 同族"的判定依据。 */
  shardPrefix(table, key) {
    const dir = this.tableDir(table);

    if (table === 'Users') {
      const part = String(key).slice(0, this.hashLen);

      return `${this.storeDir}/${dir}/${part}/${part}`;
    }

    const hash = sha1(key);
    const bucket = hash.slice(0, this.hashLen);
    const filePrefix = hash.slice(0, this.hashLen + 2);

    return `${this.storeDir}/${dir}/${bucket}/${filePrefix}`;
  }

  /** 分片文件的仓库根相对路径；suffix 为 ''（基础分片）或 '-1' / '-2' …（裂变分片）。 */
  shardPath(table, key, suffix = '') {
    return `${this.shardPrefix(table, key)}${suffix}.csv`;
  }

  manifestPath(table) {
    return `${this.storeDir}/${this.tableDir(table)}/_manifest.csv`;
  }

  /**
   * 解析分片路径。返回 null 表示该路径不是规范分片
   * （例如 _manifest.csv、_snapshots 下的副本）。
   */
  parseShardPath(repoPath) {
    if (!repoPath.startsWith(`${this.storeDir}/`) || repoPath.endsWith('_manifest.csv')) {
      return null;
    }
    const rest = repoPath.slice(this.storeDir.length + 1);
    const segments = rest.split('/');

    if (segments.length !== 3 || !segments[2].endsWith('.csv')) {
      return null;
    }
    const name = segments[2].slice(0, -'.csv'.length);
    const matched = /^(?<body>.+?)(?<suffix>-\d+)?$/u.exec(name);

    if (!matched) {
      return null;
    }
    const table = Object.keys(TABLE_DIR).find((name_) => TABLE_DIR[name_] === segments[0]);

    if (!table) {
      return null;
    }

    return {
      table,
      suffix: matched.groups.suffix ?? '',
      prefix: `${this.storeDir}/${segments[0]}/${segments[1]}/${matched.groups.body}`,
    };
  }

  /** 把分片路径还原成"族"前缀，用于判断两个分片是否同源。 */
  familyOf(repoPath) {
    const parsed = this.parseShardPath(repoPath);

    return parsed ? parsed.prefix : null;
  }

  /** 同一族内的分片排序：基础分片优先，其余按裂变序号升序。 */
  compareShardPath(left, right) {
    const suffixOf = (path) => {
      const parsed = this.parseShardPath(path);

      if (!parsed || parsed.suffix === '') {
        return 0;
      }

      return Number(parsed.suffix.slice(1));
    };

    return suffixOf(left) - suffixOf(right);
  }

  /**
   * 为新记录挑选写入分片。
   *
   * 策略：填满优先——写入族内第一个未达上限的分片；都满了就裂变出新分片。
   * 这让"分片分裂"表现为一次自然的追加，不需要停机重排整族数据。
   *
   * @param {string} table
   * @param {string} key
   * @param {Map<string, number>} familyRowCounts 族内分片路径 → 当前行数
   */
  resolveWriteShard(table, key, familyRowCounts) {
    const paths = [...familyRowCounts.keys()].sort((a, b) => this.compareShardPath(a, b));

    for (const path of paths) {
      if (familyRowCounts.get(path) < this.shardMaxRows) {
        return path;
      }
    }

    const base = this.shardPath(table, key);

    if (paths.length === 0) {
      return base;
    }

    const maxSuffix = paths.reduce((max, path) => {
      const parsed = this.parseShardPath(path);

      return Math.max(max, parsed && parsed.suffix ? Number(parsed.suffix.slice(1)) : 0);
    }, 0);

    return `${this.shardPrefix(table, key)}-${maxSuffix + 1}.csv`;
  }

  /**
   * 合并规划：族内总行数不超过阈值时，把裂变分片压缩回基础分片。
   *
   * 与"填满优先"的裂变策略配套：删除大量评论后，碎片会重新收敛，
   * 避免一次裂变之后再也不会合并、仓库里长期堆着小文件。
   *
   * @param {string} familyPrefix 分片族前缀（由 shardPrefix() 得到）
   * @param {Map<string, number>} familyRowCounts 族内分片路径 → 当前行数
   * @returns {{target: string, sources: string[]}|null} 无需合并时返回 null
   */
  planMerge(familyPrefix, familyRowCounts) {
    const paths = [...familyRowCounts.keys()].sort((a, b) => this.compareShardPath(a, b));

    if (paths.length <= 1) {
      return null;
    }
    const total = paths.reduce((sum, path) => sum + familyRowCounts.get(path), 0);

    if (total > this.shardMaxRows) {
      return null;
    }

    return { target: `${familyPrefix}.csv`, sources: paths };
  }

  // --------------------------------------------------------------------------
  // 行规范化
  // --------------------------------------------------------------------------

  /**
   * 把外部传入的对象规范成"可存可取"的行：补齐规范列、统一类型。
   *
   * 补齐规范列的好处：同一张表任意分片的行结构一致，CSV 表头稳定可预测，
   * 且 `{ rid: undefined }` 这类"该列为空"的查询在内存与落盘后语义完全一致。
   *
   * @param {object} options
   * @param {boolean} options.defaults 是否补 createdAt / updatedAt。
   *   只有"新增"才补（等价于数据库默认值）；从 CSV 读回的行绝不能补，
   *   否则会给历史数据凭空捏造时间戳。
   */
  normalizeRow(table, raw, { defaults = false } = {}) {
    const row = {};
    const now = new Date().toISOString();

    for (const column of TABLE_COLUMNS[table]) {
      row[column] = '';
    }
    for (const [key, value] of Object.entries(raw ?? {})) {
      row[key] = toCell(value);
    }
    if (defaults) {
      if (!row.createdAt) {
        row.createdAt = now;
      }
      if (!row.updatedAt) {
        row.updatedAt = now;
      }
    }

    return row;
  }

  // --------------------------------------------------------------------------
  // CSV 编解码
  // --------------------------------------------------------------------------

  /**
   * 序列化分片。使用 UTF-8 + LF，仅在必要时加引号（RFC 4180 转义交给 csv-stringify）。
   * 每个分片都带表头，便于人肉查看 diff 与用表格软件直接打开核验。
   */
  serializeShard(table, rows, columns) {
    const header = columns ?? this.buildColumns(table, rows);

    if (rows.length === 0) {
      return `${stringify([], { header: true, columns: header, record_delimiter: '\n' })}`;
    }

    return stringify(rows, {
      header: true,
      columns: header,
      record_delimiter: '\n',
      // 不强制给所有字段加引号：diff 更可读、体积更小
      quoted: false,
    });
  }

  /** 列顺序：规范列在前（固定顺序），动态列按字母序追加，保证稳定可预测。 */
  buildColumns(table, rows) {
    const canonical = TABLE_COLUMNS[table];
    const seen = new Set(canonical);
    const extras = new Set();

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          extras.add(key);
        }
      }
    }

    return [...canonical, ...[...extras].sort()];
  }

  /** 解析分片。空文件（或仅剩表头）返回空数组。 */
  parseShard(text) {
    if (!text || !text.trim()) {
      return [];
    }

    return parse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    });
  }

  // --------------------------------------------------------------------------
  // Manifest
  // --------------------------------------------------------------------------

  /**
   * 序列化 manifest。路径按 storeDir 相对形式存储（如 comments/ab/abcd.csv），
   * 这是给人看、给运维排障的元数据，简短比"绝对"更有用。
   */
  serializeManifest(entries) {
    const prefix = `${this.storeDir}/`;
    const records = [...entries.values()]
      .map((entry) => ({
        shard_path: entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path,
        row_count: String(entry.rowCount),
        sha: entry.sha ?? '',
        updated_at: entry.updatedAt ?? new Date().toISOString(),
        min_key: entry.minKey ?? '',
        max_key: entry.maxKey ?? '',
      }))
      .sort((a, b) => (a.shard_path < b.shard_path ? -1 : 1));

    return stringify(records, {
      header: true,
      columns: MANIFEST_HEADER,
      record_delimiter: '\n',
    });
  }

  parseManifest(text) {
    const entries = new Map();

    if (!text || !text.trim()) {
      return entries;
    }

    for (const record of parse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    })) {
      const rel = String(record.shard_path ?? '').trim();

      if (!rel) {
        continue;
      }
      const path = `${this.storeDir}/${rel.replace(/^\/+/u, '')}`;

      entries.set(path, {
        path,
        rowCount: Number(record.row_count) || 0,
        sha: record.sha || null,
        updatedAt: record.updated_at || null,
        minKey: record.min_key ?? '',
        maxKey: record.max_key ?? '',
      });
    }

    return entries;
  }

  /** 依据分片内的行，算出 manifest 的一行元数据。 */
  manifestEntry(table, path, rows, sha) {
    const keyField = SHARD_KEY_FIELD[table];
    const keys = rows.map((row) => toCell(row[keyField])).filter(Boolean).sort((a, b) =>
      a < b ? -1 : 1,
    );

    return {
      path,
      rowCount: rows.length,
      sha: sha ?? null,
      updatedAt: new Date().toISOString(),
      minKey: keys.length > 0 ? keys[0] : '',
      maxKey: keys.length > 0 ? keys[keys.length - 1] : '',
    };
  }
}

module.exports = {
  ShardManager,
  TABLE_COLUMNS,
  TABLE_DIR,
  INDEXED_FIELDS,
  SHARD_KEY_FIELD,
  DATE_FIELDS,
  MANIFEST_HEADER,
  toCell,
  sha1,
};
