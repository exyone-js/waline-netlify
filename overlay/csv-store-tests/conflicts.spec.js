'use strict';

/**
 * 并发写入、批量提交、冲突检测与回滚。
 *
 * 这些用例是"高并发下不丢数据"这条承诺的主要证据，所以都是端到端的：
 * 真的构造另一个写者、真的让 ref 更新失败、真的检查仓库最终内容。
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { gitBlobSha } = require('../csv-store/github-client');
const { createHarness, commentData } = require('./helpers');

/**
 * 模拟"另一个实例"向同一个分片追加一行。
 *
 * 必须同时改分片和 manifest —— 我们自己的写入就是原子地一起提交这两个文件，
 * 只有这样才能真实还原并发场景（manifest 是我们判断"哪片变了"的唯一依据）。
 */
function externalAppendFiles(mock, manager, table, shardPath, row) {
  const rows = manager.parseShard(mock.readText(shardPath) ?? '');

  rows.push(manager.normalizeRow(table, row, { defaults: true }));

  const content = manager.serializeShard(table, rows, manager.buildColumns(table, rows));
  const manifestPath = manager.manifestPath(table);
  const entries = manager.parseManifest(mock.readText(manifestPath) ?? '');

  entries.set(shardPath, manager.manifestEntry(table, shardPath, rows, gitBlobSha(content)));

  return [
    [shardPath, content],
    [manifestPath, manager.serializeManifest(entries)],
  ];
}

test('一个请求里的多次写入合并成一次提交', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const created = await comment.add(commentData({ url: '/a', comment: 'a1' }));

  await comment.add(commentData({ url: '/a', comment: 'a2' }));
  await comment.add(commentData({ url: '/b', comment: 'b1' }));
  await comment.update({ status: 'waiting' }, { objectId: created.objectId });
  await comment.delete({ url: '/b' });

  await harness.store.queue.flush();

  assert.equal(harness.mock.commits.size, 1, '整个请求只应产生一个提交');
  assert.equal(harness.store.queue.stats.commits, 1);
  assert.equal(await comment.count({ url: '/a' }), 2);
  assert.equal(await comment.count({ url: '/b' }), 0);
  assert.equal((await comment.select({ objectId: created.objectId }))[0].status, 'waiting');
});

test('写冲突：另一个实例同时在改同一分片，重试后双方数据都在', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ url: '/shared', comment: 'mine' }));
  await harness.store.queue.flush();

  const shardPath = [...harness.mock.listFiles().keys()].find((path) => path.includes('/comments/'));

  await comment.add(commentData({ url: '/shared', comment: 'mine-2' }));

  // 在我们的 ref 更新落地之前，插入一次"别人的提交"：head 前移 → 非快进更新被拒
  harness.mock.hooks.refPatch = (mock) => {
    mock.externalCommit(
      externalAppendFiles(mock, harness.store.manager, 'Comment', shardPath, {
        objectId: 'remote-row',
        url: '/shared',
        comment: 'theirs',
        status: 'approved',
        insertedAt: new Date('2026-09-25T11:00:00.000Z'),
      }),
    );
  };

  await harness.store.queue.flush();

  assert.equal(harness.store.queue.stats.conflicts, 1, '应当经历一次真实的写冲突');
  assert.equal(harness.store.queue.stats.rollbacks, 0, '冲突不应触发回滚');

  const { model } = await harness.coldStart();
  const rows = await model('Comment').select({ url: '/shared' }, { limit: 100 });

  assert.deepEqual(
    rows.map((row) => row.comment).sort(),
    ['mine', 'mine-2', 'theirs'],
    '本实例与远端实例的写入都必须保留',
  );
});

test('两个独立实例并发写不同分片：全部落盘，无一丢失', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const second = await harness.coldStart();
  const first = harness.model('Comment');
  const other = second.model('Comment');

  await first.add(commentData({ url: '/instance-a', comment: 'from-a' }));
  await other.add(commentData({ url: '/instance-b', comment: 'from-b' }));

  // 同时提交：必然有一个先落地，另一个必须靠冲突重试追上
  await Promise.all([harness.store.queue.flush(), second.store.queue.flush()]);
  second.store.queue.stop();

  const { model } = await harness.coldStart();
  const comment = model('Comment');

  assert.equal(await comment.count({}), 2);
  assert.equal(await comment.count({ url: '/instance-a' }), 1);
  assert.equal(await comment.count({ url: '/instance-b' }), 1);
});

test('重试耗尽后回滚内存并抛错，远端保持不变', async (t) => {
  const harness = await createHarness({ maxRetries: 2 });

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ comment: 'will-fail' }));
  // 让提交这一步持续失败（模拟 GitHub 长时间不可用）
  harness.mock.failNext('/git/commits', 500, 50);

  await assert.rejects(() => harness.store.queue.flush(), /分片提交失败/u);

  assert.equal(harness.store.queue.stats.rollbacks, 1);
  assert.equal(harness.mock.headCommit, null, '远端不应产生任何提交');
  assert.equal(await comment.count({}), 0, '失败后内存必须回滚，不能让业务以为写成功了');
});

test('瞬时 5xx 在客户端内部自动重试后成功', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ comment: 'flaky' }));
  harness.mock.failNext('/git/blobs', 500, 1);

  await harness.store.queue.flush();

  assert.equal(harness.store.queue.stats.rollbacks, 0);
  assert.equal(harness.mock.headCommit !== null, true);

  const { model } = await harness.coldStart();

  assert.equal(await model('Comment').count({}), 1);
});
