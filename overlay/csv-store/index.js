'use strict';

/**
 * 应用入口：把多 CSV 分片存储注入 Waline，并提供运维接口。
 *
 * 注入方式（Waline 官方扩展点，不改动任何上层业务逻辑）：
 *   Waline({ model: customModel })
 * Waline 内部会 `think.config('customModel', model)`，随后 `getModel(name)` 优先
 * 使用它。注意 `getModel` 是"直接调用"而不是 `new`，所以这里导出的是工厂函数
 * 而不是 class —— 官方文档里 `model: class CustomModel {}` 的写法会因
 * "Class constructor cannot be invoked without 'new'" 直接抛错。
 *
 * 中间件（plugins.middlewares）负责两件事：
 *   1. 响应返回前 await 一次 flush()，保证"响应 200"等于"已经落盘"。
 *      serverless 实例在响应后被冻结，只靠定时器刷盘会丢数据。
 *   2. /csv-store/* 运维接口（快照、恢复、分片合并），仅管理员可用。
 */

const { createHmac, timingSafeEqual } = require('node:crypto');

const { GithubClient } = require('./github-client');
const { ShardManager } = require('./shard-manager');
const { CsvShardCache, TABLES } = require('./csv-shard-cache');
const { ShardWriteQueue } = require('./shard-write-queue');
const { CsvModel } = require('./csv-model');
const { SnapshotManager } = require('./snapshot');

/** 读取整数型环境变量；空字符串视为未设置。 */
const intEnv = (name, fallback, env = process.env) => {
  const raw = env[name];

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number.parseInt(String(raw), 10);

  if (Number.isNaN(value)) {
    throw new Error(`环境变量 ${name} 必须是整数，当前值：${raw}`);
  }

  return value;
};

function loadConfig(env = process.env) {
  return {
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPO,
    branch: env.GITHUB_BRANCH || 'main',
    // 仅用于测试/自建代理；默认走 GitHub 官方 API
    apiBase: env.GITHUB_API_BASE || 'https://api.github.com',

    storeDir: env.CSV_STORE_DIR || 'data',
    shardMaxRows: intEnv('SHARD_MAX_ROWS', 2000, env),
    hashLen: intEnv('SHARD_HASH_LEN', 2, env),

    flushInterval: intEnv('FLUSH_INTERVAL', 30000, env),
    maxBatch: intEnv('MAX_BATCH_SIZE', 50, env),
    maxRetries: intEnv('MAX_RETRIES', 3, env),

    cacheTtl: intEnv('CSV_CACHE_TTL', 60000, env),
    dedupWindowSeconds: intEnv('DEDUP_WINDOW_SECONDS', 60, env),

    snapshotKeepDays: intEnv('SNAPSHOT_KEEP_DAYS', 30, env),
    snapshotHour: intEnv('SNAPSHOT_HOUR', 3, env),
  };
}

/**
 * 组装一整套存储组件。抽成独立函数是为了让集成测试能用内存版 GitHub
 * 直接构造一份，而不必去 mock 模块加载。
 */
function createStore(config, { fetchImpl, logger = console } = {}) {
  const github = new GithubClient({
    token: config.token,
    repo: config.repo,
    branch: config.branch,
    apiBase: config.apiBase,
    fetchImpl,
    logger,
    maxRetries: 2,
  });
  const manager = new ShardManager({
    storeDir: config.storeDir,
    shardMaxRows: config.shardMaxRows,
    hashLen: config.hashLen,
  });
  const cache = new CsvShardCache({
    github,
    manager,
    logger,
    cacheTtl: config.cacheTtl,
  });
  const queue = new ShardWriteQueue({
    cache,
    github,
    manager,
    logger,
    flushInterval: config.flushInterval,
    maxBatch: config.maxBatch,
    maxRetries: config.maxRetries,
  });
  const snapshot = new SnapshotManager({
    github,
    manager,
    cache,
    logger,
    keepDays: config.snapshotKeepDays,
    snapshotHour: config.snapshotHour,
    maxRetries: config.maxRetries,
  });

  return { config, logger, github, manager, cache, queue, snapshot };
}

let store = null;

/** 进程内单例：分片缓存/索引必须在同一实例内共享，否则索引毫无意义。 */
function getStore() {
  if (!store) {
    store = createStore(loadConfig());
    store.queue.start();
  }

  return store;
}

/** 仅测试用：丢弃单例，避免用例之间互相污染。 */
function resetStore() {
  if (store) {
    store.queue.stop();
    store = null;
  }
}

/**
 * 生成"表名 → 模型实例"的工厂。
 *
 * Waline 的 getModel 是"直接调用"而不是 `new`，所以这里导出的是工厂函数
 * 而不是 class —— 官方文档里 `model: class CustomModel {}` 的写法会因
 * "Class constructor cannot be invoked without 'new'" 直接抛错。
 *
 * 返回 null 表示"不认识这张表"，交给 Waline 回退到内建存储。
 */
function createModelFactory(store) {
  return (tableName) => {
    if (!TABLES.includes(tableName)) {
      return null;
    }

    return new CsvModel(tableName, {
      cache: store.cache,
      queue: store.queue,
      manager: store.manager,
      logger: store.logger,
      dedupWindowSeconds: store.config.dedupWindowSeconds,
    });
  };
}

/** 进程内单例模型工厂：分片缓存/索引必须在同一实例内共享，否则索引毫无意义。 */
function customModel(tableName) {
  return createModelFactory(getStore())(tableName);
}

// ---------------------------------------------------------------------------
// 管理员鉴权
// ---------------------------------------------------------------------------

/**
 * 最小可用的 HS256 JWT 校验。
 *
 * 为什么不用 require('jsonwebtoken')：那是 @waline/vercel 的内部依赖，
 * 从我们的模块里 require 它依赖 node_modules 的提升布局，在打包/外置
 * 组合下不一定可解析。这里只需要"验签 + 过期"，用 node:crypto 20 行即可，
 * 且与 Waline 的签发方式（jwt.sign(userId, jwtKey)，payload 是裸字符串）兼容。
 */
function verifyHs256(token, secret) {
  const parts = String(token).split('.');

  if (parts.length !== 3 || !secret) {
    return null;
  }
  const [header, payload, signature] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  let actual;

  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  let claims;

  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    // jsonwebtoken 对"非对象 payload"不套 JSON 引号，段里直接就是裸字符串
    // （Waline 签发的是 jwt.sign(objectId, jwtKey)，objectId 是字符串）
    claims = Buffer.from(payload, 'base64url').toString('utf8');
  }

  if (claims && typeof claims === 'object' && claims.exp && Date.now() >= claims.exp * 1000) {
    return null;
  }

  // Waline 的 payload 是裸字符串（objectId），兼容对象形式的写法
  if (typeof claims === 'string') {
    return claims || null;
  }

  return claims?.objectId ?? claims?.id ?? claims?.userId ?? null;
}

/** 判断当前请求是否由管理员发起（与 Waline 的登录/权限语义一致）。 */
async function isAdministrator(ctx, cache) {
  // 只认 Authorization 头：token 出现在 URL 里会被代理日志、浏览器历史留下
  const token = ctx.get('authorization').replace(/^Bearer /iu, '');

  if (!token) {
    return false;
  }
  // 优先取 Waline 运行时注入的 jwtKey（think 是 thinkjs 的全局对象），
  // 退化时使用与 @waline/vercel 的 config.js 完全相同的取值规则
  const jwtKey =
    globalThis.think?.config?.('jwtKey') || process.env.JWT_TOKEN || process.env.GITHUB_TOKEN;
  const objectId = verifyHs256(token, jwtKey);

  if (!objectId) {
    return false;
  }
  await cache.ensureFresh();

  return (await cache.getRow('Users', objectId))?.row?.type === 'administrator';
}

// ---------------------------------------------------------------------------
// 运维接口
// ---------------------------------------------------------------------------

const ADMIN_ROUTE = /\/csv-store\/(?<action>[a-z]+)\/?$/u;

/** 确认型操作必须显式传 confirm，避免一次误点/爬虫就清掉历史。 */
const isConfirmed = (value) => ['1', 'true', 'yes'].includes(String(value ?? '').trim().toLowerCase());

async function handleAdminRequest(ctx, action) {
  const { cache, queue, snapshot, manager, github, logger } = getStore();

  if (!(await isAdministrator(ctx, cache))) {
    ctx.status = 401;
    ctx.body = { errno: 1, errmsg: '需要管理员身份' };

    return;
  }

  try {
    switch (`${action}:${ctx.method}`) {
      case 'snapshot:POST': {
        const created = await snapshot.createSnapshot();
        const pruned = await snapshot.pruneSnapshots();

        ctx.body = { errno: 0, data: { created, pruned } };

        return;
      }
      case 'snapshot:GET':
        ctx.body = { errno: 0, data: { snapshots: await snapshot.listSnapshots() } };

        return;
      case 'restore:POST': {
        const date = ctx.request.body?.date || ctx.query?.date;

        ctx.body = { errno: 0, data: await snapshot.restore(date) };

        return;
      }
      case 'compact:POST': {
        const result = {};

        for (const table of TABLES) {
          result[manager.tableDir(table)] = await cache.compact(table);
        }
        await queue.flush();

        ctx.body = { errno: 0, data: result };

        return;
      }
      case 'rebuild:POST': {
        // 核对仓库真实文件并修正 manifest：用于人工编辑过分片之后的重新同步。
        // 先把本地未提交的变更落盘，避免随后的"远端覆盖"把它们冲掉。
        await queue.flush();

        const result = await cache.syncFromTree();

        await queue.flush();
        ctx.body = { errno: 0, data: result };

        return;
      }
      case 'flush:POST':
        ctx.body = { errno: 0, data: await queue.flush() };

        return;
      case 'reset:POST': {
        // 不可逆：丢弃全部历史提交，只保留当前数据（+ 可选保留快照）
        const confirm = ctx.request.body?.confirm ?? ctx.query?.confirm;

        if (!isConfirmed(confirm)) {
          ctx.status = 400;
          ctx.body = { errno: 1, errmsg: '重置会丢弃全部历史提交，请显式传 confirm=1' };

          return;
        }
        await queue.flush();
        ctx.body = {
          errno: 0,
          data: await snapshot.resetRepository({
            keepSnapshots: isConfirmed(ctx.request.body?.keepSnapshots ?? ctx.query?.keepSnapshots),
          }),
        };

        return;
      }
      case 'stats:GET': {
        const tables = {};

        for (const table of TABLES) {
          tables[table] = cache.tables[table].shards.size;
        }
        ctx.body = {
          errno: 0,
          data: {
            queue: queue.stats,
            githubRequests: github.requestCount,
            shards: tables,
            pending: cache.pending.size,
            lastRefresh: cache.lastRefresh,
          },
        };

        return;
      }
      default:
        ctx.status = 404;
        ctx.body = { errno: 1, errmsg: `不支持的运维操作：${action} ${ctx.method}` };
    }
  } catch (err) {
    logger.error?.(`[csv-store] 运维操作 ${action} 失败：`, err);
    ctx.status = 500;
    ctx.body = { errno: 1, errmsg: err.message };
  }
}

/**
 * Waline 插件：注入中间件。
 *
 * 顺序很关键——运维接口必须在 Waline 路由之前拦下，否则会先吃到 404；
 * 而 flush 必须在业务处理之后、响应发出之前完成。
 */
const csvStorePlugin = {
  middlewares: [
    async (ctx, next) => {
      const matched = ADMIN_ROUTE.exec(ctx.path);

      if (matched) {
        await handleAdminRequest(ctx, matched.groups.action);

        return;
      }

      let businessError = null;

      try {
        await next();
      } catch (err) {
        businessError = err;
      }

      try {
        await getStore().queue.flush();
      } catch (err) {
        if (businessError) {
          console.error('[csv-store] 业务异常且落盘失败：', err);
        } else {
          // 写入没落盘就绝不能回 200，否则用户会以为评论保存成功
          console.error('[csv-store] 评论落盘失败：', err);
          ctx.status = 500;
          ctx.body = { errno: 1, errmsg: '评论存储提交失败，请稍后重试' };

          return;
        }
      }

      if (businessError) {
        throw businessError;
      }

      try {
        await getStore().snapshot.maybeRunDaily();
      } catch (err) {
        // 快照失败不应影响正常请求
        console.error('[csv-store] 每日快照失败：', err);
      }
    },
  ],
};

module.exports = {
  customModel,
  createModelFactory,
  csvStorePlugin,
  loadConfig,
  createStore,
  getStore,
  resetStore,
  verifyHs256,
  TABLES,
};
