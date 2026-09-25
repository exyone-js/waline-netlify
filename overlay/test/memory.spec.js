'use strict';

/**
 * 内存预算守卫：10 万条评论的行对象 + 全局索引必须远低于 100MB。
 *
 * 这是方案的核心假设之一（"数据全部驻留内存，所以查询不需要网络"），
 * 因此值得用一条会失败的用例把它钉死：一旦索引结构发生内存膨胀，
 * 这里会先亮红灯，而不是等到线上 OOM。
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const v8 = require('node:v8');
const vm = require('node:vm');

const { MockGitHub } = require('./mock-github');
const { loadConfig, createStore, createModelFactory } = require('../storage');
const { gitBlobSha } = require('../storage/github-client');
const { ShardManager } = require('../storage/shard-manager');

/**
 * 拿到真正的 global.gc。
 *
 * `node --test` 会把用例放到子进程里跑，子进程不会继承 --expose-gc，
 * 所以不能指望启动参数；这里用 v8 的开关 + 新 context 取到 gc，
 * 否则只能测到"包含大量未回收垃圾"的假数据。
 */
const forceGc = (() => {
  try {
    v8.setFlagsFromString('--expose-gc');

    return vm.runInNewContext('gc');
  } catch {
    return null;
  }
})();

const TOTAL = 100000;
const PER_PAGE = 50;
const BUDGET_BYTES = 100 * 1024 * 1024;

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 2000 篇文章 × 50 条评论：接近真实博客的评论分布 */
function buildRows(total) {
  const rows = [];
  const pageCount = Math.ceil(total / PER_PAGE);

  for (let page = 0; page < pageCount && rows.length < total; page += 1) {
    for (let index = 0; index < PER_PAGE && rows.length < total; index += 1) {
      rows.push({
        objectId: `c${page}-${index}`,
        user_id: index % 7 === 0 ? `u${index}` : '',
        comment: `第 ${page} 篇文章的第 ${index} 条评论：这里放一段接近真实长度的中文内容，用于逼近真实的内存占用。`,
        insertedAt: new Date(Date.UTC(2026, 0, 1) + rows.length * 1000).toISOString(),
        ip: '203.0.113.1',
        link: 'https://example.com',
        mail: `user${index % 37}@example.com`,
        nick: `user-${index % 37}`,
        pid: '',
        rid: '',
        status: index % 20 === 0 ? 'waiting' : 'approved',
        ua: 'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        url: `/posts/${page}`,
      });
    }
  }

  return rows;
}

test('10 万条评论的行对象 + 索引小于 100MB', async (t) => {
  const mock = new MockGitHub();

  await mock.start();

  t.after(() => mock.stop());

  const manager = new ShardManager({ storeDir: 'waline-data' });
  const byShard = new Map();

  for (const row of buildRows(TOTAL)) {
    const path = manager.shardPath('Comment', row.url);

    if (!byShard.has(path)) {
      byShard.set(path, []);
    }
    byShard.get(path).push(manager.normalizeRow('Comment', row));
  }

  const files = new Map();
  const manifest = new Map();

  for (const [path, shardRows] of byShard) {
    const content = manager.serializeShard('Comment', shardRows, manager.buildColumns('Comment', shardRows));

    files.set(path, content);
    manifest.set(path, manager.manifestEntry('Comment', path, shardRows, gitBlobSha(content)));
  }
  files.set(manager.manifestPath('Comment'), manager.serializeManifest(manifest));
  mock.externalCommit(files);

  const store = createStore(
    {
      ...loadConfig({}),
      token: 'memory-test',
      repo: 'owner/repo',
      branch: 'main',
      apiBase: mock.apiBase,
      cacheTtl: 3600 * 1000,
    },
    { logger: silentLogger },
  );

  t.after(() => store.queue.stop());

  // 在加载分片之前读数：之后的增量就是"行对象 + 索引"的实际开销。
  // 必须先强制 GC：刷新过程会产生大量一次性的 base64/JSON 中间字符串，
  // 不回收的话测到的是"垃圾峰值"而不是真实常驻占用。
  const used = await measureRetained(() => store.cache.refresh({ force: true }));

  assert.equal(await createModelFactory(store)('Comment').count({}), TOTAL, '数据必须完整加载');

  const mb = (used / 1024 / 1024).toFixed(1);

  process.stdout.write(
    `\n[内存] ${TOTAL.toLocaleString('en-US')} 条评论 / ${byShard.size} 个分片：` +
      `行对象 + 索引常驻约 ${mb} MB（预算 ${BUDGET_BYTES / 1024 / 1024} MB）\n`,
  );

  assert.ok(used < BUDGET_BYTES, `索引内存占用 ${mb} MB 超出预算`);
});

/** 测量任务结束后真正留下的堆内存（先 GC，再读 heapUsed）。 */
async function measureRetained(task) {
  forceGc?.();
  const before = process.memoryUsage().heapUsed;

  await task();

  forceGc?.();
  const after = process.memoryUsage().heapUsed;

  return after - before;
}
