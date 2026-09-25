'use strict';

/**
 * 快照：创建、列出、保留策略与恢复。
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHarness, commentData } = require('./helpers');

const blobUploads = (mock) =>
  mock.requestLog.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/git/blobs')).length;

test('快照复用已有 blob，零内容上传', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  await harness.model('Comment').add(commentData({ url: '/a', comment: 'a' }));
  await harness.store.queue.flush();

  const before = harness.mock.listFiles();
  const headBefore = harness.mock.headCommit;

  harness.mock.requestLog.length = 0;

  const created = await harness.store.snapshot.createSnapshot('2026-09-24');

  assert.equal(created.skipped, false);
  assert.equal(created.files, before.size);
  assert.equal(blobUploads(harness.mock), 0, '快照不应重新上传任何文件内容');

  const after = harness.mock.listFiles();

  for (const [path, meta] of before) {
    const snapshotPath = `data/_snapshots/2026-09-24/${path}`;

    assert.equal(after.get(snapshotPath)?.sha, meta.sha, `快照文件 ${path} 应引用同一个 blob`);
  }

  assert.notEqual(harness.mock.headCommit, headBefore);
  assert.deepEqual(await harness.store.snapshot.listSnapshots(), ['2026-09-24']);
});

test('空仓库不产生空快照', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const created = await harness.store.snapshot.createSnapshot('2026-09-24');

  assert.equal(created.skipped, true);
  assert.equal(harness.mock.headCommit, null);
});

test('恢复：把数据目录整体还原到快照时点，并清掉多出来的文件', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ url: '/keep', comment: 'keep-me' }));
  await harness.store.queue.flush();
  await harness.store.snapshot.createSnapshot('2026-09-24');

  // 快照之后再写入：这一条在恢复后必须消失
  await comment.add(commentData({ url: '/lost', comment: 'lost-me' }));
  await harness.store.queue.flush();

  assert.equal(await comment.count({}), 2);

  const restored = await harness.store.snapshot.restore('2026-09-24');

  assert.equal(restored.restored > 0, true);
  assert.equal(await comment.count({}), 1, '恢复后新写入的评论必须消失');
  assert.equal(await comment.count({ url: '/keep' }), 1);
  assert.equal(await comment.count({ url: '/lost' }), 0);

  // 冷启动再确认一次：磁盘上的数据也确实是快照时点的状态
  const { model } = await harness.coldStart();

  assert.equal(await model('Comment').count({}), 1);
  assert.equal(await model('Comment').count({ url: '/keep' }), 1);
});

test('保留策略：只保留最近 N 天', async (t) => {
  const harness = await createHarness({ snapshotKeepDays: 2 });

  t.after(() => harness.dispose());

  await harness.model('Comment').add(commentData({ url: '/a', comment: 'a' }));
  await harness.store.queue.flush();

  for (const date of ['2026-09-23', '2026-09-24', '2026-09-25']) {
    await harness.store.snapshot.createSnapshot(date);
  }

  assert.deepEqual(await harness.store.snapshot.listSnapshots(), ['2026-09-25', '2026-09-24', '2026-09-23']);

  const pruned = await harness.store.snapshot.pruneSnapshots();

  assert.deepEqual(pruned.removed, ['2026-09-23']);
  assert.deepEqual(await harness.store.snapshot.listSnapshots(), ['2026-09-25', '2026-09-24']);

  // 数据分片本身不能被误删
  assert.equal(await harness.model('Comment').count({}), 1);
});

test('每日快照：到点后当天只自动执行一次', async (t) => {
  const harness = await createHarness({ snapshotHour: 3 });

  t.after(() => harness.dispose());

  await harness.model('Comment').add(commentData({ url: '/a', comment: 'a' }));
  await harness.store.queue.flush();

  const early = await harness.store.snapshot.maybeRunDaily(new Date('2026-09-25T01:00:00'));

  assert.equal(early.skipped, true);
  assert.deepEqual(await harness.store.snapshot.listSnapshots(), []);

  const first = await harness.store.snapshot.maybeRunDaily(new Date('2026-09-25T04:00:00'));

  assert.equal(first.skipped, false);
  assert.deepEqual(await harness.store.snapshot.listSnapshots(), ['2026-09-25']);

  const second = await harness.store.snapshot.maybeRunDaily(new Date('2026-09-25T22:00:00'));

  assert.equal(second.skipped, true);

  // 第二天到点后会再拍一次
  const nextDay = await harness.store.snapshot.maybeRunDaily(new Date('2026-09-26T04:00:00'));

  assert.equal(nextDay.skipped, false);
  assert.deepEqual(await harness.store.snapshot.listSnapshots(), ['2026-09-26', '2026-09-25']);
});

test('SNAPSHOT_KEEP_DAYS=0 时快照功能整体关闭', async (t) => {
  const harness = await createHarness({ snapshotKeepDays: 0 });

  t.after(() => harness.dispose());

  assert.equal((await harness.store.snapshot.maybeRunDaily(new Date('2026-09-25T04:00:00'))).skipped, true);
  assert.deepEqual(await harness.store.snapshot.listSnapshots(), []);
});
