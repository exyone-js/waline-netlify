'use strict';

/**
 * 生产运行时的"函数能否加载"守卫。
 *
 * 背景：AWS Lambda（Netlify 的后端）的 Node 24 运行时**没有开启 `require(esm)`**，
 * 而 `@waline/vercel@1.43.4` 在 `src/service/markdown/index.js` 第一行同步 require
 * 了只有 ESM 构建的 `@mdit/plugin-emoji`，于是冷启动直接抛 ERR_REQUIRE_ESM、
 * 整站 502。本地（`require(esm)` 默认开启）却完全正常，所以这个坑在本地开发时
 * 看不到，只有上线才炸。
 *
 * 这里用子进程 + `--no-experimental-require-module` 复刻生产运行时，只做一件事：
 * require 我们真正的函数入口，确认它能加载完成。这样"某个依赖变成纯 ESM / 被同步
 * require"这类改动会在 `npm test` 阶段就被拦下，而不是等上线。
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const REPO_ROOT = path.join(__dirname, '..', '..');

test('禁用 require(esm) 的运行时（生产）下，函数入口必须能加载', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--no-experimental-require-module',
      '-e',
      "require('./netlify/functions/comment.js'); console.log('FUNCTION_LOADED');",
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        // waline 在加载期就会校验存储配置，这里给一份和线上一致的占位值，
        // 否则它会先报 "No valid storage found." 而看不到我们真正要测的加载问题
        GITHUB_TOKEN: 'test-token',
        GITHUB_REPO: 'owner/repo',
        GITHUB_BRANCH: 'main',
      },
    },
  );

  assert.equal(
    result.status,
    0,
    `函数入口在禁用 require(esm) 的运行时下加载失败（线上会表现为冷启动 502）：\n${result.stderr}`,
  );
  assert.match(result.stdout, /FUNCTION_LOADED/u);
  assert.doesNotMatch(result.stderr, /ERR_REQUIRE_ESM/u);
});
