'use strict';

/**
 * 分片行为测试：路由、裂变、合并、manifest、增量加载与大数据文件回退。
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHarness, commentData, userData, apiCallsMatching } = require('./helpers');

const shardFilesOf = (mock, table) =>
  [...mock.listFiles().keys()].filter(
    (path) => path.startsWith(`waline-data/${table}/`) && path.endsWith('.csv') && !path.endsWith('_manifest.csv'),
  );

/** mock 收到的"分片内容下载"请求（不含 manifest）。 */
const shardDownloadsOf = (mock, table) =>
  mock.requestLog.filter(
    (entry) => entry.path.includes(`/contents/waline-data/${table}/`) && !entry.path.includes('_manifest.csv'),
  );

test('分片路由：同一 url 落同一分片，不同 url 落不同分片', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  for (let index = 0; index < 3; index += 1) {
    await comment.add(commentData({ url: '/same-post', comment: `same-${index}` }));
  }
  await comment.add(commentData({ url: '/other-post', comment: 'other' }));
  await harness.store.queue.flush();

  const files = shardFilesOf(harness.mock, 'comments');

  assert.equal(files.length, 2, '3 条同文章评论 + 1 条其他文章评论应只产生 2 个分片');
  // 每个分片都带表头，且第一列是 objectId
  for (const path of files) {
    assert.match(harness.mock.readText(path).split('\n')[0], /^objectId,/u);
  }

  // manifest 记录行数、SHA 与 key 范围
  const manifest = harness.mock.readText(harness.store.manager.manifestPath('Comment'));
  const lines = manifest.trim().split('\n');

  assert.equal(lines[0], 'shard_path,row_count,sha,updated_at,min_key,max_key');
  assert.equal(lines.length, 3);

  const rows = lines.slice(1).map((line) => line.split(','));

  assert.deepEqual(rows.map((row) => row[1]).sort(), ['1', '3']);
  for (const row of rows) {
    assert.match(row[2], /^[0-9a-f]{40}$/u, 'manifest 必须记录真实的 blob SHA');
    assert.equal(row[4], row[5], '同一 url 的分片 min_key/max_key 相同');
  }
});

test('Users 按 objectId 前两位分片，文件名与目录同名', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const users = harness.model('Users');

  for (let index = 0; index < 30; index += 1) {
    await users.add(userData({ email: `u${index}@x.com` }));
  }
  await harness.store.queue.flush();

  const files = shardFilesOf(harness.mock, 'users');

  assert.ok(files.length > 1);
  for (const path of files) {
    const matched = /^waline-data\/users\/(?<dir>[^/]+)\/(?<name>[^/]+?)(?:-\d+)?\.csv$/u.exec(path);

    assert.ok(matched, `不符合分片命名的文件：${path}`);
    assert.equal(matched.groups.dir, matched.groups.name);
  }
  assert.equal(await users.count(), 30);
});

test('分片裂变：超过 SHARD_MAX_ROWS 后自动拆出新分片，且数据仍可完整读回', async (t) => {
  const harness = await createHarness({ shardMaxRows: 5 });

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  for (let index = 0; index < 12; index += 1) {
    await comment.add(commentData({ url: '/hot-post', comment: `c-${index}` }));
  }
  await harness.store.queue.flush();

  const files = shardFilesOf(harness.mock, 'comments');

  assert.equal(files.length, 3, '12 条评论在每片 5 行的上限下应裂变为 3 个分片');
  for (const path of files) {
    const rowCount = harness.mock.readText(path).trim().split('\n').length - 1;

    assert.ok(rowCount <= 5, `分片 ${path} 行数 ${rowCount} 超过上限`);
  }

  // 裂变之后，同一个 url 的评论分散在多个分片，但查询结果必须完整
  assert.equal(await comment.count({ url: '/hot-post' }), 12);

  const all = await comment.select({ url: '/hot-post' }, { limit: 100 });

  assert.equal(all.length, 12);
  assert.equal(new Set(all.map((row) => row.objectId)).size, 12);

  const { model } = await harness.coldStart();

  assert.equal(await model('Comment').count({ url: '/hot-post' }), 12);
});

test('分片合并：行数回落到阈值内后压缩回基础分片', async (t) => {
  const harness = await createHarness({ shardMaxRows: 5 });

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const ids = [];

  for (let index = 0; index < 12; index += 1) {
    const created = await comment.add(commentData({ url: '/hot-post', comment: `c-${index}` }));

    ids.push(created.objectId);
  }
  await harness.store.queue.flush();

  assert.equal(shardFilesOf(harness.mock, 'comments').length, 3);

  // 只留 4 条（低于上限），随后压缩应把 3 个分片收回 1 个基础分片
  await comment.delete({ objectId: ['IN', ids.slice(0, 8)] });

  const compacted = harness.store.cache.compact('Comment');

  await harness.store.queue.flush();

  assert.equal(compacted.merged, 1);
  assert.equal(shardFilesOf(harness.mock, 'comments').length, 1);
  assert.equal(await comment.count({ url: '/hot-post' }), 4);

  const { model } = await harness.coldStart();

  assert.equal(await model('Comment').count({ url: '/hot-post' }), 4);
  assert.equal(await model('Comment').count({ objectId: ['IN', ids.slice(0, 8)] }), 0);
});

test('刷新是增量的：未变更的分片不会被重新下载', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ url: '/a', comment: 'a' }));
  await harness.store.queue.flush();

  // 刚提交完，本地算出的 blob SHA 应与远端一致 → 强制刷新应一个分片都不下载
  harness.mock.requestLog.length = 0;
  await harness.store.cache.refresh({ force: true });

  assert.equal(harness.mock.requestLog.length, 3, '三张表的 manifest 各一次请求');
  assert.equal(shardDownloadsOf(harness.mock, 'comments').length, 0, '没有分片需要重新下载');

  // 另一个"实例"写入另一篇文章 → 只应下载它改动的那一个分片
  const second = await harness.coldStart();

  await second.model('Comment').add(commentData({ url: '/b', comment: 'b' }));
  await second.store.queue.flush();
  second.store.queue.stop();

  harness.mock.requestLog.length = 0;
  await harness.store.cache.refresh({ force: true });

  assert.equal(shardDownloadsOf(harness.mock, 'comments').length, 1, '只应重新下载发生变化的那个分片');
  assert.equal(await comment.count({}), 2);
});

test('手工改过仓库文件后，rebuild 能核对并同步（manifest 自动修正）', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ url: '/a', comment: 'original' }));
  await harness.store.queue.flush();

  const manager = harness.store.manager;
  const shardPath = shardFilesOf(harness.mock, 'comments')[0];
  const rows = manager.parseShard(harness.mock.readText(shardPath));

  rows[0].comment = 'edited-by-hand';
  // 只改分片、不动 manifest —— 这正是"人在 GitHub 网页上直接编辑"的样子
  harness.mock.externalCommit([[shardPath, manager.serializeShard('Comment', rows, manager.buildColumns('Comment', rows))]]);

  assert.equal((await comment.select({ url: '/a' }))[0].comment, 'original', '普通刷新不会去读未变更的分片');

  const rebuilt = await harness.store.cache.syncFromTree();

  await harness.store.queue.flush();

  assert.equal(rebuilt.changed, 1);
  assert.equal((await comment.select({ url: '/a' }))[0].comment, 'edited-by-hand');

  const manifest = manager.parseManifest(harness.mock.readText(manager.manifestPath('Comment')));

  assert.equal(manifest.get(shardPath).sha, harness.mock.listFiles().get(shardPath).sha, 'manifest 应被修正为真实 SHA');

  const { model } = await harness.coldStart();

  assert.equal((await model('Comment').select({ url: '/a' }))[0].comment, 'edited-by-hand');
});

test('分片超过 1MB 时自动改走 Blob API，数据不丢', async (t) => {
  const harness = await createHarness({}, { contentsMaxBytes: 512 });

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const bigComment = 'x'.repeat(4096);

  await comment.add(commentData({ comment: bigComment }));
  await harness.store.queue.flush();

  const shardPath = shardFilesOf(harness.mock, 'comments')[0];

  assert.ok(harness.mock.readText(shardPath).length > 512, '分片应当超过 Contents API 的内联上限');

  harness.mock.requestLog.length = 0;

  const { model } = await harness.coldStart();
  const [reloaded] = await model('Comment').select({ url: '/post-1' });

  assert.equal(reloaded.comment, bigComment);
  assert.equal(harness.mock.requestLog.some((entry) => entry.path.includes('/git/blobs/')), true, '应走 Blob API');
});
