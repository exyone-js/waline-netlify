'use strict';

/**
 * `@mdit/plugin-emoji` 的 CJS 垫片。
 *
 * 为什么需要它：`@waline/vercel@1.43.4` 的 markdown 服务是在**模块加载期同步 require**
 * 这个包的 —— `src/service/markdown/index.js` 第一行就是
 *
 *   const { fullEmoji } = require('@mdit/plugin-emoji');
 *
 * 而 `@mdit/plugin-emoji` 只有 ESM 构建（`type: module`，exports 只给 `default`
 * 指向 `dist/index.js`，1.0.0 ~ 1.2.2 全部如此）。在未开启 `require(esm)` 的运行时
 * （AWS Lambda 的 Node 24 就是）这行会直接抛 `ERR_REQUIRE_ESM`，函数在冷启动阶段
 * 就挂了，整站不可用。注意 waline 对其它 `@mdit/*` 包都用了 `await import()`，
 * 只有这一处是同步 require，属于上游遗漏。
 *
 * 这里用它的前身 `markdown-it-emoji`（同一套实现方法，提供 CJS 构建：exports 里
 * `require` → `dist/index.cjs.js`）补上同名的三个导出。也就是说：
 * **这正是升级前 waline@1.41.6 用的那套 emoji 实现**（它当时写的是
 * `require('markdown-it-emoji').full`），渲染行为与升级前完全一致。
 */

const { bare, full, light } = require('markdown-it-emoji');

module.exports = {
  bareEmoji: bare,
  fullEmoji: full,
  lightEmoji: light,
};
