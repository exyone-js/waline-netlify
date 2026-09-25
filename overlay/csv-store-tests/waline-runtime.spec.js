'use strict';

/**
 * 端到端集成：把真实的 @waline/vercel 跑起来，只把 GitHub 换成内存 mock。
 *
 * 前面的用例都是直接驱动 CsvModel，而这里要验证的是"接线是否正确"：
 *   Waline({ model: customModel, plugins: [csvStorePlugin] })
 * 是否真的被 thinkjs 采纳（model 会被 think.config('customModel') 接住，
 * 并且 getModel 是"直接调用"而不是 new）、插件中间件是否真的在响应前落盘、
 * 真实的 Waline 路由 /api/comment 是否能用我们的存储完成读写。
 *
 * 这一层能发现"单测全绿但上线 500"的问题（工厂函数签名不对、中间件顺序不对、
 * 字段名对不上导致 formatCmt 抛错、响应发出前没落盘等）。
 *
 * 注意：整个文件只创建一次 Application —— thinkjs 的 think 是进程级单例，
 * 同一进程里起两个 App 会互相干扰，所以所有断言都放在同一个用例里。
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');

const { MockGitHub } = require('./mock-github');

test('真实 Waline 运行时 + 自定义分片存储：发评论 → 读列表 → 计数 → 鉴权', async (t) => {
  const mock = new MockGitHub();

  await mock.start();

  // 必须在 require('@waline/vercel') 之前设置：框架在加载阶段就按环境变量建配置
  process.env.MARKDOWN_TEX = 'false';
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPO = 'owner/repo';
  process.env.GITHUB_BRANCH = 'main';
  process.env.GITHUB_API_BASE = mock.apiBase;
  process.env.JWT_TOKEN = 'test-jwt-key';
  process.env.CSV_STORE_DIR = 'data';
  // Waline 内置了 akismet 的默认 key，不关掉就会真的联网做垃圾评论检测
  // （既慢又不确定），这里按官方文档的方式关掉
  process.env.AKISMET_KEY = 'false';

  // eslint-disable-next-line global-require
  const Waline = require('@waline/vercel');
  // eslint-disable-next-line global-require
  const { customModel, csvStorePlugin, resetStore } = require('../csv-store');

  resetStore();

  const server = http.createServer(Waline({ env: 'netlify', model: customModel, plugins: [csvStorePlugin] }));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    resetStore();
    await new Promise((resolve) => server.close(resolve));
    await mock.stop();
  });

  const getJson = async (path) => {
    const res = await fetch(`${base}${path}`);

    assert.equal(res.status, 200, `${path} 应返回 200`);

    return res.json();
  };

  const postJson = async (path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    return { status: res.status, body: await res.json() };
  };

  const commentShards = () =>
    [...mock.listFiles().keys()].filter(
      (path) => path.startsWith('data/comments/') && path.endsWith('.csv') && !path.endsWith('_manifest.csv'),
    );

  // 1. 空库先返回空列表（验证"数据文件尚不存在"这条路径不会炸）
  const empty = await getJson('/api/comment?path=%2Fpost-1&page=1&pageSize=10&sortBy=insertedAt_desc');

  assert.equal(empty.errno, 0);
  assert.deepEqual(empty.data.data, []);
  assert.equal(commentShards().length, 0, '只读请求不应产生任何数据文件');

  // 2. 发一条评论：controller → model.add → 中间件在响应前 flush
  const payload = {
    comment: '来自端到端测试的评论，包含 `markdown` 与中文。',
    nick: '测试用户',
    mail: 'e2e@example.com',
    link: 'https://example.com',
    url: '/post-1',
    ua: 'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  };
  const created = await postJson('/api/comment', payload);

  assert.equal(created.status, 200);
  assert.equal(created.body.errno, 0);
  assert.ok(created.body.data.objectId, '响应里必须带上 objectId');
  assert.equal(created.body.data.nick, '测试用户');
  assert.equal(created.body.data.comment.includes('<p>'), true, 'markdown 应已被渲染');

  // 3. 最关键的一条：响应返回时数据必须已经提交到"GitHub"
  assert.equal(commentShards().length, 1, '响应返回时评论必须已经落盘');

  const shardText = mock.readText(commentShards()[0]);

  assert.equal(shardText.includes('来自端到端测试的评论'), true, '分片里应包含原始 markdown');
  assert.equal(shardText.split('\n')[0].startsWith('objectId,'), true, '分片必须带表头');

  const manifest = mock.readText('data/comments/_manifest.csv');

  assert.equal(manifest.trim().split('\n').length, 2, 'manifest 应记录 1 个分片');
  assert.equal(manifest.includes(',1,'), true, 'manifest 应记录 row_count=1');

  // 4. 读列表：真实的 getCommentList（count ×2 + 根评论 + 子评论 + 用户联查）
  const list = await getJson('/api/comment?path=%2Fpost-1&page=1&pageSize=10&sortBy=insertedAt_desc');

  assert.equal(list.errno, 0);
  assert.equal(list.data.count, 1);
  assert.equal(list.data.totalPages, 1);
  assert.equal(list.data.data.length, 1);
  assert.equal(list.data.data[0].nick, '测试用户');
  assert.equal(list.data.data[0].objectId, created.body.data.objectId);
  assert.equal(typeof list.data.data[0].time, 'number', 'insertedAt 应被格式化成时间戳');
  assert.equal(Array.isArray(list.data.data[0].children), true);

  // 5. 计数接口
  const counts = await getJson('/api/comment?type=count&url=%2Fpost-1');

  assert.equal(counts.errno, 0);
  assert.deepEqual(counts.data, [1]);

  // 6. 最近评论（走 order by insertedAt desc）
  const recent = await getJson('/api/comment?type=recent&count=5');

  assert.equal(recent.errno, 0);
  assert.equal(recent.data.length, 1);

  // 7. 管理后台列表需要管理员身份 —— 顺便验证整条登录链路
  //    （第一个注册的用户会成为 administrator，这是 Waline 自身的规则）
  const adminList = await fetch(`${base}/api/comment?type=list&page=1&pageSize=10`);

  assert.equal(adminList.status, 401, '未登录访问后台列表必须被拒绝');

  const registered = await postJson('/api/user', {
    email: 'admin@example.com',
    password: 'admin-password-123',
    display_name: '管理员',
  });

  assert.equal(registered.body.errno, 0, `注册失败：${JSON.stringify(registered.body)}`);

  const login = await postJson('/api/token', { email: 'admin@example.com', password: 'admin-password-123' });

  assert.equal(login.body.errno, 0, `登录失败：${JSON.stringify(login.body)}`);
  assert.ok(login.body.data.token, '登录必须返回 token（说明 Users 表的主键被正确保存与读回）');
  assert.equal(login.body.data.type, 'administrator');

  const auth = { authorization: `Bearer ${login.body.data.token}` };
  const getAuthorized = async (path) => {
    const res = await fetch(`${base}${path}`, { headers: auth });

    assert.equal(res.status, 200, `${path} 应返回 200`);

    return res.json();
  };

  const adminListAuthorized = await getAuthorized('/api/comment?type=list&page=1&pageSize=10');

  assert.equal(adminListAuthorized.errno, 0);
  assert.equal(adminListAuthorized.data.totalPages, 1);
  assert.equal(adminListAuthorized.data.spamCount, 0);
  assert.equal(adminListAuthorized.data.data.length, 1);
  assert.equal(adminListAuthorized.data.data[0].mail, 'e2e@example.com', '管理员可以看到邮箱');

  // 8. 运维接口：管理员可创建快照，未登录必须被拒绝。
  //    这里同时验证了我们自实现的 HS256 校验能接受 Waline 真实签发的 token。
  const unauth = await postJson('/api/csv-store/snapshot', {});

  assert.equal(unauth.status, 401);
  assert.equal(unauth.body.errno, 1);

  const snapshot = await fetch(`${base}/api/csv-store/snapshot`, { method: 'POST', headers: auth });
  const snapshotBody = await snapshot.json();

  assert.equal(snapshot.status, 200, `创建快照失败：${JSON.stringify(snapshotBody)}`);
  assert.equal(snapshotBody.errno, 0);
  assert.equal(snapshotBody.data.created.files > 0, true, '快照应复制已有数据文件');

  const snapshotList = await getAuthorized('/api/csv-store/snapshot');

  assert.equal(snapshotList.errno, 0);
  assert.equal(snapshotList.data.snapshots.length, 1);

  // 9. 完全相同的重复提交会被 Waline 自身的重复校验拦下。
  //    注意 thinkjs 的 ctx.fail(字符串) 会把 errno 归一成 1000，而不是我们中间件
  //    里自己定义的 1 —— 这里断言"非 0 且提示重复"即可。
  const duplicate = await postJson('/api/comment', payload);

  assert.equal(duplicate.status, 200);
  assert.notEqual(duplicate.body.errno, 0);
  assert.match(duplicate.body.errmsg, /Duplicate/u);

  // 10. IP 频率限制：同一 IP 在 IPQPS 秒内不能连发。
  //     这条检查依赖存储层能正确比较日期 —— 上游 GitHub 存储用
  //     `item[k] >= where[k][1]`，字符串与 Date 比较恒为 false，所以它从未生效过。
  const tooFast = await postJson('/api/comment', { ...payload, comment: '第二次发言' });

  assert.notEqual(tooFast.body.errno, 0, 'IP 频率限制应当生效');

  // 11. 放开频率限制后，验证含正则元字符的关键词搜索不会抛错
  //     （上游把关键词直接拼进 new RegExp，`(括号)` 这类输入会 500）
  process.env.IPQPS = '0';

  const withBraces = await postJson('/api/comment', {
    ...payload,
    comment: '包含 (括号) [方括号] 与 100% 的内容',
  });

  assert.equal(withBraces.body.errno, 0, `带元字符的评论应能提交：${JSON.stringify(withBraces.body)}`);

  const searched = await getAuthorized(
    `/api/comment?type=list&page=1&pageSize=10&keyword=${encodeURIComponent('(括号)')}`,
  );

  assert.equal(searched.errno, 0);
  assert.equal(searched.data.data.length, 1, '含正则元字符的关键词搜索不应抛错');
});
