'use strict';

/**
 * 适配器 CRUD 集成测试：完全按 Waline controller 的调用方式驱动 CsvModel，
 * 数据经过真实的 HTTP 往返、真实的分片文件与 manifest。
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHarness, commentData, userData } = require('./helpers');

test('add：写后立即读得到，flush 后冷启动仍在', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const created = await comment.add(commentData({ comment: 'first' }));

  assert.ok(created.objectId, 'add 必须返回 objectId');
  assert.equal(typeof created.objectId, 'string');

  // 尚未 flush，但同一个进程内必须已经可见（避免"提交成功却刷新消失"）
  const visible = await comment.select({ url: '/post-1' });

  assert.equal(visible.length, 1);
  assert.equal(visible[0].objectId, created.objectId);

  await harness.store.queue.flush();
  assert.equal(harness.mock.headCommit !== null, true, 'flush 后必须产生提交');

  const { model } = await harness.coldStart();
  const reloaded = await model('Comment').select({ url: '/post-1' });

  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].objectId, created.objectId);
  assert.equal(reloaded[0].comment, 'first');
  assert.equal(reloaded[0].insertedAt, '2026-09-25T10:00:00.000Z');
  assert.equal(reloaded[0].status, 'approved');
});

test('select / count / count(group)：按 url 与状态过滤', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ url: '/a', comment: '#1' }));
  await comment.add(commentData({ url: '/a', comment: '#2', status: 'waiting' }));
  await comment.add(commentData({ url: '/b', comment: '#3' }));
  await harness.store.queue.flush();

  assert.equal(await comment.count({ url: '/a' }), 2);
  assert.equal(await comment.count({ url: ['IN', ['/a', '/b']] }), 3);
  assert.equal(await comment.count({ status: ['NOT IN', ['waiting', 'spam']] }), 2);
  assert.equal(await comment.count({}), 3);
  assert.equal(await comment.count({ url: '/nope' }), 0);

  const grouped = await comment.count({}, { group: ['url'] });

  assert.deepEqual(
    grouped.sort((a, b) => (a.url < b.url ? -1 : 1)),
    [
      { count: 2, url: '/a' },
      { count: 1, url: '/b' },
    ],
  );
});

test('select：rid=undefined 只取根评论，rid IN 取子评论（分页逻辑）', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const root = await comment.add(commentData({ comment: 'root' }));

  await comment.add(commentData({ comment: 'child-1', rid: root.objectId, pid: root.objectId }));
  await comment.add(commentData({ comment: 'child-2', rid: root.objectId, pid: root.objectId }));

  const roots = await comment.select({ url: '/post-1', rid: undefined });

  assert.equal(roots.length, 1);
  assert.equal(roots[0].objectId, root.objectId);

  const children = await comment.select({ url: '/post-1', rid: ['IN', [root.objectId]] });

  assert.equal(children.length, 2);
  assert.equal(await comment.count({ url: '/post-1', rid: undefined }), 1);
});

test('select：field 投影保留 objectId，且兼容上游的 id 别名', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  await comment.add(commentData({ comment: 'hello' }));

  const [projected] = await comment.select({ url: '/post-1' }, { field: ['comment', 'status'] });

  assert.deepEqual(Object.keys(projected).sort(), ['comment', 'objectId', 'status']);

  const [withAlias] = await comment.select({ url: '/post-1' }, { field: ['id', 'email'] });

  assert.equal(typeof withAlias.objectId, 'string');
  assert.equal('email' in withAlias, false);
});

test('select：order / desc / limit / offset 与 sticky 空值排序', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');

  for (const [index, sticky] of [
    ['1', '1'],
    ['2', ''],
    ['3', '1'],
    ['4', ''],
    ['5', ''],
  ]) {
    await comment.add(
      commentData({
        comment: `c${index}`,
        sticky: sticky || undefined,
        insertedAt: new Date(`2026-09-2${index}T10:00:00.000Z`),
      }),
    );
  }

  const ordered = await comment.select(
    { url: '/post-1' },
    {
      limit: 2,
      offset: 0,
      order: [
        { field: 'sticky', direction: 'desc', nulls: 'last' },
        { field: 'insertedAt', direction: 'desc' },
      ],
    },
  );

  // sticky=1 的两条按时间倒序在前，然后才是空的
  assert.deepEqual(ordered.map((row) => row.comment), ['c3', 'c1']);

  const secondPage = await comment.select(
    { url: '/post-1' },
    {
      limit: 2,
      offset: 2,
      order: [
        { field: 'sticky', direction: 'desc', nulls: 'last' },
        { field: 'insertedAt', direction: 'desc' },
      ],
    },
  );

  assert.deepEqual(secondPage.map((row) => row.comment), ['c5', 'c4']);

  const byDesc = await comment.select({ url: '/post-1' }, { desc: 'insertedAt', limit: 1 });

  assert.equal(byDesc[0].comment, 'c5');

  await assert.rejects(() => comment.select({}, { order: [{ field: 'comment', direction: 'up' }] }), TypeError);
});

test('update：对象补丁、函数补丁、函数返回对象三种写法', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const created = await comment.add(commentData({ comment: 'before' }));

  const [byObject] = await comment.update({ comment: 'after-object' }, { objectId: created.objectId });

  assert.equal(byObject.comment, 'after-object');
  assert.equal(byObject.objectId, created.objectId);

  // 函数返回补丁（article.js 的计数器自增写法）
  const [byReturned] = await comment.update(
    (row) => ({ comment: `after-${row.comment}` }),
    { objectId: created.objectId },
  );

  assert.equal(byReturned.comment, 'after-after-object');

  // 函数就地修改（上游允许的写法）
  await comment.update(
    (row) => {
      row.comment = 'after-mutation';
    },
    { objectId: created.objectId },
  );

  const [final] = await comment.select({ objectId: created.objectId });

  assert.equal(final.comment, 'after-mutation');

  // 主键不可被补丁覆盖
  await comment.update({ objectId: 'hacked', comment: 'x' }, { objectId: created.objectId });
  assert.equal((await comment.select({ objectId: 'hacked' })).length, 0);
});

test('delete：按条件删除，且能清空整张表并删除分片文件', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const root = await comment.add(commentData({ comment: 'root' }));

  await comment.add(commentData({ comment: 'child', rid: root.objectId, pid: root.objectId }));

  // 级联删除（controller 的 deleteAction 用 _complex + or）
  await comment.delete({
    _complex: { _logic: 'or', objectId: root.objectId, pid: root.objectId, rid: root.objectId },
  });

  assert.equal(await comment.count({}), 0);

  await comment.add(commentData({ comment: 'again' }));
  await harness.store.queue.flush();

  const shardFiles = () =>
    [...harness.mock.listFiles().keys()].filter(
      (path) => path.startsWith('waline-data/comments/') && path.endsWith('.csv') && !path.endsWith('_manifest.csv'),
    );

  assert.equal(shardFiles().length, 1);

  // db.js 的"重置数据"按钮：delete({})
  await comment.delete({});
  await harness.store.queue.flush();

  assert.equal(await comment.count({}), 0);
  assert.deepEqual(shardFiles(), [], '清空后分片文件应从仓库删除');
  assert.equal(harness.mock.readText(harness.store.manager.manifestPath('Comment')).trim(), 'shard_path,row_count,sha,updated_at,min_key,max_key');
});

test('Users：email 查询、objectId 过滤、类型封禁', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const users = harness.model('Users');
  const admin = await users.add(userData({ email: 'admin@x.com', type: 'administrator', display_name: 'Admin' }));
  const guest = await users.add(userData({ email: 'guest@x.com', display_name: 'Guest' }));

  assert.equal(await users.count(), 2);

  const [byEmail] = await users.select({ email: 'guest@x.com' });

  assert.equal(byEmail.objectId, guest.objectId);

  const byIds = await users.select({ objectId: ['IN', [admin.objectId, guest.objectId, 'missing']] });

  assert.equal(byIds.length, 2);

  // logic/base.js 的登录校验：objectId + type != banned
  const [login] = await users.select({ objectId: guest.objectId, type: ['!=', 'banned'] }, {
    field: ['id', 'email', 'url', 'display_name', 'type', 'avatar', '2fa', 'label'],
  });

  assert.equal(login.objectId, guest.objectId);
  // 2fa 不是 Users 的规范列（与上游 CSV_HEADERS 一致），在该列尚未出现时不存在
  assert.ok(!login['2fa']);
  assert.equal(login.display_name, 'Guest');

  await users.update({ type: 'banned' }, { objectId: guest.objectId });

  assert.equal((await users.select({ objectId: guest.objectId, type: ['!=', 'banned'] })).length, 0);
  assert.equal((await users.select({ objectId: guest.objectId, type: 'banned' })).length, 1);

  // 按 createdAt 倒序取用户列表（管理后台）
  const list = await users.select({}, { desc: 'createdAt', limit: 1 });

  assert.equal(list.length, 1);
  assert.ok(list[0].createdAt, '新增用户必须补上 createdAt，否则后台排序无意义');

  const deleted = guest.objectId;

  await users.delete({ objectId: deleted });
  assert.equal(await users.count(), 1);
});

test('Counter：新增计数、自增、批量查询（article.js 的完整流程）', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  const counter = harness.model('Counter');
  const first = await counter.add({ url: '/a', time: 1 }, { access: { read: true, write: true } });

  assert.ok(first.objectId);

  // 第二次访问：update 走函数补丁
  const resp = await counter.select({ url: '/a' });
  const ret = await counter.update(
    (row) => ({ time: (Number(row.time) || 0) + 1, updatedAt: new Date() }),
    { objectId: ['IN', resp.map((row) => row.objectId)] },
  );

  assert.equal(ret[0].time, '2');

  const second = await counter.add({ url: '/b', time: 1 });

  assert.ok(second.objectId);

  const all = await counter.select({ url: ['IN', ['/a', '/b', '/c']] });

  assert.equal(all.length, 2);

  await harness.store.queue.flush();

  const { model } = await harness.coldStart();
  const reloaded = await model('Counter').select({ url: '/a' });

  assert.equal(reloaded[0].time, '2');
});

test('add 会为 Comment / Users / Counter 落盘动态列（sticky / like / 2fa）', async (t) => {
  const harness = await createHarness();

  t.after(() => harness.dispose());

  await harness.model('Comment').add(commentData({ comment: 'x', sticky: true, like: 3 }));
  await harness.model('Users').add(userData({ '2fa': 'secret', twitter: 'alice' }));
  await harness.store.queue.flush();

  const { model } = await harness.coldStart();
  const [comment] = await model('Comment').select({ url: '/post-1' });
  const [user] = await model('Users').select({ email: 'a@example.com' });

  // 上游用 fast-csv 的 headers:true 会把首个写入行之外的动态列整列丢掉，
  // 这里必须完整保留
  assert.equal(comment.sticky, 'true');
  assert.equal(comment.like, '3');
  assert.equal(user['2fa'], 'secret');
  assert.equal(user.twitter, 'alice');
});

test('去重窗口：窗口内相同内容直接返回既有记录', async (t) => {
  const harness = await createHarness({ dedupWindowSeconds: 60 });

  t.after(() => harness.dispose());

  const comment = harness.model('Comment');
  const payload = commentData({ comment: 'same content', insertedAt: new Date() });
  const first = await comment.add(payload);
  const second = await comment.add(payload);

  assert.equal(second.objectId, first.objectId);
  assert.equal(await comment.count({}), 1);

  // 内容不同则正常新增
  const third = await comment.add({ ...payload, comment: 'other content' });

  assert.notEqual(third.objectId, first.objectId);
  assert.equal(await comment.count({}), 2);
});
