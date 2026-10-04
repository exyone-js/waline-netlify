'use strict';

/**
 * 可靠性专项：这些用例针对的都是"看起来能跑、但在并发或限流下会静默丢数据/报错"的场景，
 * 每一个都对应一次真实的失效模式：
 *
 *   1. 在途提交期间到达的写入（flush 复用在途 promise → 响应 200 但没落盘）
 *   2. MAX_BATCH_SIZE 失效（分批不生效 + 批次外表漏写 manifest）
 *   3. 计数器并发自增（"本地优先"合并静默丢掉另一个实例的 +1）
 *   4. GitHub 次级限流返回 403（不重试 → 莫名其妙的 500）
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { gitBlobSha } = require('../csv-store/github-client');
const { createHarness, commentData } = require('./helpers');

test('在途提交之后写入的数据，不会被"复用在途 promise"丢掉', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const queue = harness.store.queue;

  await comment.add(commentData({ url: '/seed', comment: 'seed' }));
  await queue.flush();

  // 精确复现竞态：让在途的 runFlush 跑完自己的循环后停住，等价于真实场景里
  // "runFlush 刚做完最后一次 isDirty 检查、promise 还没回到调用方"的那段窗口。
  // 旧实现在这个窗口里会把在途 promise 直接返回给第二个请求 —— 于是第二个
  // 请求带着"响应 200 但数据还在内存里"结束，实例一冻结就丢了。
  const realRunFlush = queue.runFlush.bind(queue);
  let release = () => {};
  let markRunDone = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runDone = new Promise((resolve) => {
    markRunDone = resolve;
  });

  queue.runFlush = async () => {
    const result = await realRunFlush();

    // 到这里：runFlush 已经做完最后一次 isDirty 检查、不会再回头看 pending 了
    markRunDone();
    await gate;

    return result;
  };

  await comment.add(commentData({ url: '/first', comment: 'first' }));
  const first = queue.flush(); // A 的提交：在途

  await runDone;
  await comment.add(commentData({ url: '/late', comment: 'late' })); // B 的写入落在窗口内
  const late = queue.flush(); // B 自己的 flush：此刻在途 promise 还没落地

  release();
  await Promise.all([first, late]);

  assert.equal(harness.store.cache.pending.size, 0, '两次 flush 都返回后不应还有未落盘的分片');

  const { model } = await harness.coldStart();
  const comments = (await model('Comment').select({}, { limit: 100 })).map((row) => row.comment).sort();

  assert.deepEqual(comments, ['first', 'late', 'seed'], '在途提交之后写入的评论不能丢');
});

test('MAX_BATCH_SIZE 真正分批，且每张表的 manifest 都与分片内容一致', async (t) => {
  const harness = await createHarness({ maxBatch: 1 });

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const counter = harness.model('Counter');

  await comment.add(commentData({ url: '/a', comment: 'a' }));
  await comment.add(commentData({ url: '/b', comment: 'b' }));
  await counter.add({ url: '/a', time: 1 });

  assert.equal(harness.store.cache.pending.size, 3, '三个分片待提交');

  await harness.store.queue.flush();

  assert.equal(harness.store.queue.stats.commits, 3, 'maxBatch=1 时应分成三次提交');

  // 之前 commitOnce 会顺手提交"批次外"的分片，却只重写批次内那张表的 manifest，
  // 于是仓库里留下"分片内容与 manifest 不符"的中间态
  for (const table of ['Comment', 'Counter']) {
    const manifestPath = harness.store.manager.manifestPath(table);
    const entries = harness.store.manager.parseManifest(harness.mock.readText(manifestPath) ?? '');

    assert.equal(entries.size > 0, true, `${table} 的 manifest 不能为空`);

    for (const [path, entry] of entries) {
      const content = harness.mock.readText(path);

      assert.equal(content !== null, true, `${path} 必须真实存在`);
      assert.equal(entry.sha, gitBlobSha(content), `manifest 记录的 ${path} 的 sha 必须等于实际内容`);
    }
  }

  const { model } = await harness.coldStart();

  assert.equal(await model('Comment').count({}), 2);
  assert.equal(await model('Counter').count({}), 1);
});

test('只加载了部分分片就提交，manifest 仍包含全部分片', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  for (let index = 0; index < 4; index += 1) {
    await comment.add(commentData({ url: `/p${index}`, comment: `c-${index}` }));
  }
  await harness.store.queue.flush();

  const before = harness.store.manager.parseManifest(harness.mock.readText('data/comments/_manifest.csv'));

  assert.equal(before.size, 4);

  // 冷启动后只查 /p0（只加载一个族），然后往 /p3 写一条并提交
  const { store, model } = await harness.coldStart();

  await model('Comment').select({ url: '/p0' });
  await model('Comment').add(commentData({ url: '/p3', comment: 'late' }));
  await store.queue.flush();
  store.queue.stop();

  // 关键点：manifest 是"权威清单"的投影，不能因为分片没加载就被漏掉
  const after = harness.store.manager.parseManifest(harness.mock.readText('data/comments/_manifest.csv'));

  assert.equal(after.size, 4, '未加载的分片也必须留在 manifest 里');

  for (const [path, entry] of after) {
    assert.equal(entry.sha, gitBlobSha(harness.mock.readText(path)), `${path} 的 sha 必须与实际内容一致`);
  }

  const { model: fresh } = await harness.coldStart();

  assert.equal(await fresh('Comment').count({}), 5, '全部评论都必须还在');
  assert.equal(await fresh('Comment').count({ url: '/p3' }), 2);
  assert.equal(await fresh('Comment').count({ url: '/p1' }), 1);
});

test('两个实例并发自增阅读量：两次 +1 都留下', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const counterA = harness.model('Counter');

  await counterA.add({ url: '/view', time: 1 });
  await harness.store.queue.flush();

  const second = await harness.coldStart();
  const counterB = second.model('Counter');

  // A、B 都基于同一个 time=1 各自 +1（Waline 的计数器就是这么写的）
  await counterA.update((row) => ({ time: (Number(row.time) || 0) + 1 }), { url: '/view' });
  await harness.store.queue.flush();

  await counterB.update((row) => ({ time: (Number(row.time) || 0) + 1 }), { url: '/view' });
  await second.store.queue.flush();
  second.store.queue.stop();

  const { model } = await harness.coldStart();
  const [row] = await model('Counter').select({ url: '/view' });

  assert.equal(Number(row.time), 3, '两个 +1 都必须生效（本地优先合并会丢掉一个，只剩 2）');
});

test('次级限流：403 + rate limit 文案要重试，而不是直接抛给业务', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  await harness.model('Comment').add(commentData({ comment: 'throttled' }));
  harness.mock.failNext('/git/blobs', 403, 1, 'API rate limit exceeded for user ID 1');

  await harness.store.queue.flush();

  assert.equal(harness.store.queue.stats.rollbacks, 0);
  assert.equal(harness.mock.headCommit !== null, true);

  const { model } = await harness.coldStart();

  assert.equal(await model('Comment').count({}), 1);
});

test('鉴权类 403 不能当成限流去重试', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  await harness.model('Comment').add(commentData({ comment: 'forbidden' }));
  harness.mock.failNext('/git/blobs', 403, 5, 'Resource not accessible by integration');

  await assert.rejects(() => harness.store.queue.flush(), /Resource not accessible/u);
});

test('限流响应带 Retry-After 时按它等待', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  await harness.model('Comment').add(commentData({ comment: 'retry-after' }));
  harness.mock.setResponseHeaders('/git/blobs', { 'retry-after': '1' });
  harness.mock.failNext('/git/blobs', 403, 1, 'You have exceeded a secondary rate limit');

  const started = Date.now();

  await harness.store.queue.flush();

  assert.equal(Date.now() - started >= 1000, true, '应当遵循 Retry-After 等待，而不是立刻重试');
  assert.equal(harness.store.queue.stats.rollbacks, 0);

  const { model } = await harness.coldStart();

  assert.equal(await model('Comment').count({}), 1);
});
