'use strict';

/**
 * 改造前的基线实现：单文件 CSV 存储。
 *
 * 这是对 @waline/vercel/src/service/storage/github.js 数据访问方式的原版复刻：
 *   读：Contents API 下载整个 Comment.csv → 解析 → 在 JS 里逐行过滤 → 排序 → 分页
 *   写：Contents API 下载整个文件 → 改内存数组 → 整个文件 PUT 回去
 *
 * 唯一的差别是它修正了上游"动态列被丢弃"的 CSV 表头问题（否则 `sticky`/`like`
 * 会被整列丢掉，那是正确性缺陷而不是性能特征，留着只会干扰对比）。
 * 条件查询语义直接复用新实现的 compileWhere，保证两边"查的是同一件事"。
 */

const { compileWhere } = require('../csv-store/csv-shard-cache');

const CSV_HEADERS = {
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
};

const parseCsv = (text, columns) => {
  const { parse } = require('csv-parse/sync');

  if (!text || !text.trim()) {
    return { rows: [], columns };
  }
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });

  return { rows, columns: rows.length > 0 ? Object.keys(rows[0]) : columns };
};

const writeCsv = (rows, columns) => {
  const { stringify } = require('csv-stringify/sync');

  return stringify(rows, { header: true, columns, record_delimiter: '\n', quoted: false });
};

class LegacySingleCsvStorage {
  constructor({ apiBase, repo, tableName = 'Comment', token = 'benchmark', branch = 'main', basePath = 'data' }) {
    this.apiBase = apiBase.replace(/\/+$/u, '');
    this.repo = repo;
    this.tableName = tableName;
    this.token = token;
    this.branch = branch;
    this.basePath = basePath;
  }

  filePath(tableName) {
    return `${this.basePath}/${tableName}.csv`;
  }

  headers() {
    return { accept: 'application/vnd.github.v3+json', authorization: `token ${this.token}`, 'user-agent': 'Waline' };
  }

  /** 旧方案最核心的特征：每次操作都要把整个数据文件拉下来。 */
  async readFile(tableName) {
    const res = await fetch(
      `${this.apiBase}/repos/${this.repo}/contents/${this.filePath(tableName)}?ref=${this.branch}`,
      { headers: this.headers() },
    );

    if (res.status === 404) {
      return { rows: [], columns: CSV_HEADERS[tableName] ?? [], sha: null };
    }
    const data = await res.json();

    if (!res.ok) {
      throw new Error(`legacy read failed: ${res.status} ${data.message}`);
    }

    // 超过 1MB 的文件 Contents API 不返回 content，必须改走 Blob API。
    // 这一步上游同样要做（否则大数据量下会读到空文件），属于旧方案的真实成本。
    const text =
      data.encoding === 'base64' && data.content
        ? Buffer.from(data.content, 'base64').toString('utf8')
        : await fetch(`${this.apiBase}/repos/${this.repo}/git/blobs/${data.sha}`, { headers: this.headers() })
            .then((blobRes) => blobRes.json())
            .then((blob) => Buffer.from(blob.content, 'base64').toString('utf8'));

    return { ...parseCsv(text, CSV_HEADERS[tableName]), sha: data.sha };
  }

  async writeFile(tableName, rows, columns, sha) {
    const res = await fetch(`${this.apiBase}/repos/${this.repo}/contents/${this.filePath(tableName)}`, {
      method: 'PUT',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(sha ? { sha } : {}),
        message: 'feat(waline): update comment data',
        content: Buffer.from(writeCsv(rows, columns), 'utf8').toString('base64'),
      }),
    });

    if (!res.ok) {
      throw new Error(`legacy write failed: ${res.status}`);
    }
  }

  async select(where, { desc, limit, offset, order } = {}) {
    const { rows } = await this.readFile(this.tableName);
    const matcher = compileWhere(where);
    let matched = rows.filter((row) => matcher(row));

    const normalizedOrder =
      order ?? (desc ? [{ field: desc, direction: 'desc' }] : []);

    if (normalizedOrder.length > 0) {
      matched = matched.sort((left, right) => {
        for (const { field, direction } of normalizedOrder) {
          const a = left[field] ?? '';
          const b = right[field] ?? '';
          const result = a === b ? 0 : a > b ? 1 : -1;

          if (result !== 0) {
            return direction === 'desc' ? -result : result;
          }
        }

        return 0;
      });
    }

    const start = offset ?? 0;

    return matched.slice(start, limit ? start + limit : undefined).map((row) => ({ ...row }));
  }

  async count(where = {}, { group } = {}) {
    const { rows } = await this.readFile(this.tableName);
    const matcher = compileWhere(where);
    const matched = rows.filter((row) => matcher(row));

    if (!group) {
      return matched.length;
    }

    const counts = new Map();

    for (const row of matched) {
      const key = group.map((field) => row[field] ?? '').join(',');
      const bucket = counts.get(key) ?? { count: 0, ...Object.fromEntries(group.map((f) => [f, row[f] ?? ''])) };

      bucket.count += 1;
      counts.set(key, bucket);
    }

    return [...counts.values()];
  }

  async add(data) {
    const { rows, columns, sha } = await this.readFile(this.tableName);
    const objectId = Math.random().toString(36).slice(2, 15);

    rows.push({ ...Object.fromEntries(columns.map((column) => [column, ''])), ...data, objectId });
    await this.writeFile(this.tableName, rows, columns, sha);

    return { ...data, objectId };
  }

  async update(data, where) {
    const { rows, columns, sha } = await this.readFile(this.tableName);
    const matcher = compileWhere(where);
    const list = rows.filter((row) => matcher(row));

    for (const row of list) {
      Object.assign(row, typeof data === 'function' ? data(row) ?? {} : data);
    }
    await this.writeFile(this.tableName, rows, columns, sha);

    return list;
  }

  async delete(where) {
    const { rows, columns, sha } = await this.readFile(this.tableName);
    const matcher = compileWhere(where);

    await this.writeFile(this.tableName, rows.filter((row) => !matcher(row)), columns, sha);
  }
}

module.exports = { LegacySingleCsvStorage, CSV_HEADERS };
