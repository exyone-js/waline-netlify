'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac } = require('node:crypto');

const { gitBlobSha } = require('../storage/github-client');
const { ShardManager } = require('../storage/shard-manager');
const { compileWhere, compareValues } = require('../storage/csv-shard-cache');
const { verifyHs256 } = require('../storage/index');

const manager = new ShardManager({ storeDir: 'waline-data', shardMaxRows: 3, hashLen: 2 });

test('gitBlobSha 与 git 的 blob 哈希一致', () => {
  // echo -n hello | git hash-object --stdin
  assert.equal(gitBlobSha('hello'), 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  // 空 blob 的哈希是 git 里众所周知的常量
  assert.equal(gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  // 多字节字符必须按字节数而不是字符数计算
  assert.equal(gitBlobSha('中文'), gitBlobSha(Buffer.from('中文', 'utf8')));
});

test('分片路径稳定可预测', () => {
  const path = manager.shardPath('Comment', '/post-1');

  assert.match(path, /^waline-data\/comments\/[0-9a-f]{2}\/[0-9a-f]{4}\.csv$/u);
  // 同一个 url 一定落在同一个分片
  assert.equal(path, manager.shardPath('Comment', '/post-1'));
  assert.equal(manager.shardPath('Counter', '/post-1'), `waline-data/counters${path.slice('waline-data/comments'.length)}`);

  const userShard = manager.shardPath('Users', 'a1b2c3');

  assert.equal(userShard, `waline-data/users/a1/a1.csv`);
});

test('分片路径可以被反向解析，非分片路径返回 null', () => {
  const path = manager.shardPath('Comment', '/post-1');
  const parsed = manager.parseShardPath(path);

  assert.equal(parsed.table, 'Comment');
  assert.equal(parsed.suffix, '');
  assert.equal(manager.familyOf(path), parsed.prefix);

  const split = manager.parseShardPath(`${parsed.prefix}-2.csv`);

  assert.equal(split.suffix, '-2');
  assert.equal(split.prefix, parsed.prefix);
  assert.equal(manager.parseShardPath('waline-data/comments/_manifest.csv'), null);
  assert.equal(manager.parseShardPath('waline-data/_snapshots/2026-09-25/comments/ab/abcd.csv'), null);
});

test('CSV 表头 = 规范列在前 + 动态列按字母序追加', () => {
  const columns = manager.buildColumns('Comment', [
    { objectId: 'a', url: '/x', sticky: '1' },
    { objectId: 'b', url: '/y', like: '3', sticky: '0' },
  ]);

  assert.deepEqual(columns.slice(0, 3), ['objectId', 'user_id', 'comment']);
  assert.deepEqual(columns.slice(-2), ['like', 'sticky']);
});

test('CSV 编解码能正确处理逗号、引号、换行与 UTF-8', () => {
  const rows = [
    manager.normalizeRow('Comment', {
      objectId: 'a1',
      comment: '带,逗号 "引号" 和\n换行 的中文',
      url: '/p',
    }),
  ];
  const text = manager.serializeShard('Comment', rows, manager.buildColumns('Comment', rows));
  const parsed = manager.parseShard(text);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].comment, rows[0].comment);
  assert.equal(parsed[0].objectId, 'a1');
  // 每个分片都必须带表头
  assert.equal(text.split('\n')[0].startsWith('objectId,'), true);
  assert.equal(text.includes('\r'), false);
});

test('manifest 可序列化并按 storeDir 相对路径往返', () => {
  const entries = new Map();
  const path = manager.shardPath('Comment', '/post-1');

  entries.set(path, manager.manifestEntry('Comment', path, [{ objectId: 'a', url: '/post-1' }], 'sha1'));

  const text = manager.serializeManifest(entries);

  assert.equal(text.split('\n')[0], 'shard_path,row_count,sha,updated_at,min_key,max_key');

  const parsed = manager.parseManifest(text);

  assert.equal(parsed.size, 1);
  assert.equal(parsed.get(path).rowCount, 1);
  assert.equal(parsed.get(path).sha, 'sha1');
  assert.equal(parsed.get(path).minKey, '/post-1');
});

test('写入分片路由：填满优先，溢出后裂变', () => {
  const prefix = manager.shardPrefix('Comment', '/post-1');
  const base = `${prefix}.csv`;
  const split1 = `${prefix}-1.csv`;

  assert.equal(manager.resolveWriteShard('Comment', '/post-1', new Map()), base);
  assert.equal(manager.resolveWriteShard('Comment', '/post-1', new Map([[base, 0]])), base);
  assert.equal(manager.resolveWriteShard('Comment', '/post-1', new Map([[base, 3]])), split1);
  assert.equal(
    manager.resolveWriteShard(
      'Comment',
      '/post-1',
      new Map([
        [base, 3],
        [split1, 1],
      ]),
    ),
    split1,
  );
  assert.equal(
    manager.resolveWriteShard(
      'Comment',
      '/post-1',
      new Map([
        [base, 3],
        [split1, 3],
      ]),
    ),
    `${prefix}-2.csv`,
  );
});

test('分片合并规划：只有总行数回落到阈值内才合并', () => {
  assert.equal(manager.planMerge(manager.shardPrefix('Comment', '/p'), new Map()), null);

  const prefix = manager.shardPrefix('Comment', '/p');

  assert.equal(manager.planMerge(prefix, new Map([[`${prefix}.csv`, 1]])), null);

  const plan = manager.planMerge(
    prefix,
    new Map([
      [`${prefix}.csv`, 1],
      [`${prefix}-1.csv`, 1],
    ]),
  );

  assert.equal(plan.target, `${prefix}.csv`);
  assert.deepEqual(plan.sources, [`${prefix}.csv`, `${prefix}-1.csv`]);

  assert.equal(
    manager.planMerge(
      prefix,
      new Map([
        [`${prefix}.csv`, 3],
        [`${prefix}-1.csv`, 3],
      ]),
    ),
    null,
  );
});

test('where 语义：等值 / 空值 / != / > / IN / NOT IN / LIKE', () => {
  const row = { nick: 'Alice', status: 'approved', time: '5', insertedAt: '2026-09-25T10:00:00.000Z' };

  assert.equal(compileWhere({ nick: 'Alice' })(row), true);
  assert.equal(compileWhere({ nick: 'Bob' })(row), false);
  assert.equal(compileWhere({ rid: undefined })(row), true);
  assert.equal(compileWhere({ nick: undefined })(row), false);
  assert.equal(compileWhere({ status: ['!=', 'spam'] })(row), true);
  assert.equal(compileWhere({ status: ['!=', 'approved'] })(row), false);
  assert.equal(compileWhere({ status: ['IN', ['approved', 'waiting']] })(row), true);
  assert.equal(compileWhere({ status: ['NOT IN', ['waiting', 'spam']] })(row), true);
  assert.equal(compileWhere({ nick: ['LIKE', '%lic%'] })(row), true);
  assert.equal(compileWhere({ nick: ['LIKE', 'Ali%'] })(row), true);
  assert.equal(compileWhere({ nick: ['LIKE', '%ice'] })(row), true);
  assert.equal(compileWhere({ nick: ['LIKE', '%zzz%'] })(row), false);
  assert.equal(compileWhere({ nick: ['LIKE', '%A(lic)%'] })(row), false);
  assert.equal(compileWhere({})(row), true);
});

test('where 语义：日期范围比较按时间戳，而不是字符串和 Date 硬比', () => {
  const cutoff = new Date('2026-09-25T09:00:00.000Z');

  assert.equal(compileWhere({ insertedAt: ['>', cutoff] })({ insertedAt: '2026-09-25T10:00:00.000Z' }), true);
  assert.equal(compileWhere({ insertedAt: ['>', cutoff] })({ insertedAt: '2026-09-25T08:00:00.000Z' }), false);
  assert.equal(compileWhere({ insertedAt: ['>', cutoff] })({ insertedAt: '' }), false);
  assert.equal(compareValues('2026-09-25T10:00:00.000Z', cutoff), 1);
});

test('where 语义：_logic=or 与 _complex 与上游一致', () => {
  const rows = [
    { url: '/a', status: 'approved', user_id: 'u1', mail: 'a@x.com' },
    { url: '/a', status: 'spam', user_id: 'u2', mail: 'b@x.com' },
    { url: '/b', status: 'approved', user_id: 'u2', mail: 'b@x.com' },
  ];
  const where = {
    url: '/a',
    _complex: { _logic: 'or', status: ['NOT IN', ['waiting', 'spam']], user_id: 'u1' },
  };
  const matcher = compileWhere(where);

  // 外层条件对所有分支都生效：url='/a' AND (status 正常 OR user_id='u1')
  assert.deepEqual(rows.map(matcher), [true, false, false]);

  const orMatcher = compileWhere({ url: '/a', user_id: 'u2', _logic: 'OR' });

  // 上游只在 _complex 里处理 _logic；顶层 _logic 会被当成普通字段 → 恒不匹配
  assert.deepEqual(rows.map(orMatcher), [false, false, false]);
});

test('verifyHs256：接受 Waline 签发的裸字符串 payload，拒绝篡改与过期', () => {
  const key = 'secret';
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const sign = (payload) => {
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const body = encode(payload);
    const signature = createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');

    return `${header}.${body}.${signature}`;
  };
  // jsonwebtoken 对字符串 payload 不会套 JSON 引号，payload 段里就是裸字符串，
  // Waline 的 jwt.sign(objectId, jwtKey) 走的就是这条路径
  const signRaw = (raw) => {
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const body = Buffer.from(raw, 'utf8').toString('base64url');
    const signature = createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');

    return `${header}.${body}.${signature}`;
  };

  assert.equal(verifyHs256(sign('user-1'), key), 'user-1');
  assert.equal(verifyHs256(signRaw('user-raw'), key), 'user-raw', '裸字符串 payload 也必须被接受');
  assert.equal(verifyHs256(sign({ objectId: 'user-2' }), key), 'user-2');
  assert.equal(verifyHs256(sign({ objectId: 'user-3', exp: Math.floor(Date.now() / 1000) - 10 }), key), null);
  assert.equal(verifyHs256(sign('user-1'), 'other-key'), null);
  assert.equal(verifyHs256('not-a-token', key), null);
  assert.equal(verifyHs256(sign('user-1'), ''), null);
});
