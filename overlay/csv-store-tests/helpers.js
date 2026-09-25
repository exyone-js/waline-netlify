'use strict';

/**
 * 集成测试脚手架：一份内存版 GitHub + 一整套真实的分片存储组件。
 *
 * 刻意不 mock 我们的任何模块，只把"GitHub 这个外部依赖"换成内存实现，
 * 这样测到的行为与线上一致。
 */

const { MockGitHub } = require('./mock-github');
const { loadConfig, createStore, createModelFactory } = require('../csv-store');

/** 无人值守的 logger：避免测试输出被日志淹没。 */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function createHarness(overrides = {}, mockOptions = {}) {
  const mock = new MockGitHub(mockOptions);

  await mock.start();

  const config = {
    ...loadConfig({}),
    token: 'test-token',
    repo: 'owner/repo',
    branch: 'main',
    apiBase: mock.apiBase,
    // 去重默认关闭，避免用例之间因"内容相同 + 时间窗口"互相干扰；
    // 去重行为由专门的用例显式打开验证。
    dedupWindowSeconds: 0,
    ...overrides,
  };
  const store = createStore(config, { logger: silentLogger });
  const model = createModelFactory(store);

  return {
    mock,
    store,
    config,
    model,
    /** 模拟冷启动：丢掉全部进程内状态，从仓库重新加载 */
    async coldStart() {
      const fresh = createStore(config, { logger: silentLogger });

      return { store: fresh, model: createModelFactory(fresh) };
    },
    async dispose() {
      store.queue.stop();
      await mock.stop();
    },
  };
}

/** 统计 mock 收到的 API 调用。 */
const apiCalls = (mock) => mock.requestLog.length;

const apiCallsMatching = (mock, pattern) =>
  mock.requestLog.filter((entry) => `${entry.method} ${entry.path}`.includes(pattern)).length;

/** 构造一条评论数据（字段与 controller 实际写入的一致）。 */
const commentData = (overrides = {}) => ({
  user_id: '',
  comment: 'hello world',
  insertedAt: new Date('2026-09-25T10:00:00.000Z'),
  ip: '127.0.0.1',
  link: 'https://example.com',
  mail: 'a@example.com',
  nick: 'Alice',
  pid: '',
  rid: '',
  status: 'approved',
  ua: 'Mozilla/5.0',
  url: '/post-1',
  ...overrides,
});

const userData = (overrides = {}) => ({
  display_name: 'Alice',
  email: 'a@example.com',
  password: 'hash',
  type: 'guest',
  url: 'https://example.com',
  avatar: '',
  label: '',
  ...overrides,
});

module.exports = { createHarness, silentLogger, apiCalls, apiCallsMatching, commentData, userData };
