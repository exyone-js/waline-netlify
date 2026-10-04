'use strict';

/**
 * 快照：创建、列出、保留策略与恢复。
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHarness, commentData } = require('./helpers');

const blobUploads = (mock) =>
  mock.requestLog.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/git/blobs')).length;

/** 从 head 沿父提交回溯，得到"当前可达的历史长度"（mock 不会删除历史对象）。 */
const historyDepth = (mock) => {
  let depth = 0;
  let sha = mock.headCommit;

  while (sha) {
    depth += 1;
    sha = mock.commits.get(sha)?.parents?.[0] ?? null;
  }

  return depth;
};

test('快照是一份引用清单：只上传清单本身，数据零上传', async (t) => {
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
  assert.equal(blobUploads(harness.mock), 1, '只应上传快照清单这一个 blob');

  const manifestPath = 'data/_snapshots/2026-09-24.csv';
  const listed = await harness.store.snapshot.snapshotFiles('2026-09-24');

  assert.deepEqual([...listed.keys()].sort(), [...before.keys()].sort());
  for (const [path, meta] of before) {
    assert.equal(listed.get(path)?.sha, meta.sha, `清单里 ${path} 必须引用原 blob`);
  }

  // 仓库里只多了一个文件：文件数不再随分片数 × 保留天数放大
  assert.equal(harness.mock.listFiles().size, before.size + 1);
  assert.notEqual(harness.mock.headCommit, headBefore);
  assert.deepEqual(await harness.store.snapshot.listSnapshots(), ['2026-09-24']);
  assert.equal(harness.mock.readText(manifestPath).split('\n')[0], 'path,sha');
});

test('旧格式的目录快照仍然可以恢复（向后兼容）', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ url: '/legacy', comment: 'legacy-me' }));
  await harness.store.queue.flush();

  // 手工造一份"旧格式"快照：_snapshots/<date>/ 下按原路径复制一份
  const files = harness.mock.listFiles();
  const legacy = new Map();

  for (const [path, meta] of files) {
    legacy.set(`data/_snapshots/2026-01-01/${path}`, harness.mock.blobs.get(meta.sha));
  }
  harness.mock.externalCommit(legacy);

  assert.deepEqual(await harness.store.snapshot.listSnapshots(), ['2026-01-01']);

  // 抹掉当前数据，再从旧快照恢复
  await comment.add(commentData({ url: '/newer', comment: 'newer-me' }));
  await harness.store.queue.flush();
  assert.equal(await comment.count({}), 2);

  const restored = await harness.store.snapshot.restore('2026-01-01');

  assert.equal(restored.restored > 0, true);
  assert.equal(await comment.count({}), 1, '旧快照应完整恢复，新写入的被覆盖');
  assert.equal(await comment.count({ url: '/legacy' }), 1);
});

test('重置仓库：历史提交被丢弃，只保留当前数据', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ url: '/a', comment: 'a' }));
  await harness.store.queue.flush();
  await harness.store.snapshot.createSnapshot('2026-09-24');

  // 制造一批历史提交（也顺便把快照目录树塞进去）
  for (let index = 0; index < 5; index += 1) {
    await comment.add(commentData({ url: '/a', comment: `noise-${index}` }));
    await harness.store.queue.flush();
  }

  assert.equal(historyDepth(harness.mock) > 5, true);

  const result = await harness.store.snapshot.resetRepository();

  assert.equal(result.reset, true);

  // 重置后：可达历史只剩一个提交，且它没有父提交
  assert.equal(historyDepth(harness.mock), 1, '历史提交应被整体丢弃');
  assert.deepEqual(harness.mock.commits.get(harness.mock.headCommit).parents, [], '重置提交不应带父提交');

  // 快照目录树被一并清掉，但数据本身完好
  assert.deepEqual(await harness.store.snapshot.listSnapshots(), []);
  assert.equal(await comment.count({}), 6, '重置不能丢数据');

  const { model } = await harness.coldStart();

  assert.equal(await model('Comment').count({}), 6);
  assert.equal(await model('Comment').count({ url: '/a' }), 6);
});

test('重置仓库：keepSnapshots 可以留住快照', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  await harness.model('Comment').add(commentData({ url: '/a', comment: 'a' }));
  await harness.store.queue.flush();
  await harness.store.snapshot.createSnapshot('2026-09-24');

  await harness.store.snapshot.resetRepository({ keepSnapshots: true });

  assert.deepEqual(await harness.store.snapshot.listSnapshots(), ['2026-09-24']);
  assert.equal(historyDepth(harness.mock), 1);
});

test('恢复的日期格式非法时直接报错', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  await assert.rejects(() => harness.store.snapshot.restore('../../etc'), /YYYY-MM-DD/u);
  await assert.rejects(() => harness.store.snapshot.restore(''), /YYYY-MM-DD/u);
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
