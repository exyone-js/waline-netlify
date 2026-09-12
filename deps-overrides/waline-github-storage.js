'use strict';

/**
 * 运行时修正 @waline/vercel 的 GitHub 存储适配器（不修改 node_modules）。
 *
 * 上游 src/service/storage/github.js 有两个缺陷：
 *   1. get() 不校验 HTTP 状态：数据文件尚不存在时 GitHub 返回 404，响应体没有
 *      content 字段，Buffer.from(undefined) 会抛 TypeError —— 首次评论必然崩溃；
 *   2. set() 不校验写入结果：GitHub 返回 4xx/5xx 时异常被静默吞掉，表现为
 *      "评论提交成功，但刷新后消失"。
 *
 * 为什么在运行时修正，而不是构建期打补丁：Netlify 等 CI 会复用依赖缓存，可能
 * 安装到旧版本的包，构建期的源码补丁（patch-package 或字符串替换）会因此失败。
 * 这里改为通过原型访问器包裹适配器内部的 Github 实例，与包版本、构建缓存、
 * 换行符均无关。
 *
 * 用法：在调用 Waline({...}) 之前调用一次 applyGithubStorageFix()。
 */

const path = require('node:path');

const API = 'https://api.github.com/repos';

const authHeaders = (token) => ({
  accept: 'application/vnd.github.v3+json',
  authorization: `token ${token}`,
  'user-agent': 'Waline',
});

const httpError = (status, message) => {
  const error = new Error(message || `GitHub API error: ${status}`);

  error.statusCode = status;
  return error;
};

/**
 * 读取数据文件。
 * 文件不存在时抛出 statusCode=404，由上游 collection() 当作空数据处理。
 */
async function readFile(git, filename) {
  const url = `${API}/${path.join(git.repo, 'contents', filename)}`;
  const res = await fetch(url, { headers: authHeaders(git.token) });
  const data = await res.json().catch(() => ({}));

  if (res.status === 404) {
    throw httpError(404, data.message || 'NOT FOUND');
  }
  if (!res.ok) {
    throw httpError(res.status, data.message);
  }
  // 文件超过 1MB 时 Content API 不返回 content，改走 blob API
  if (data.content === undefined) {
    return git.getLargeFile(filename);
  }

  return {
    data: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

/**
 * 写入数据文件。
 * 失败时抛出 GitHub 返回的真实原因，避免评论被静默丢弃。
 */
async function writeFile(git, filename, content, { sha } = {}) {
  const body = {
    message: 'feat(waline): update comment data',
    content: Buffer.from(content, 'utf-8').toString('base64'),
  };

  // sha 仅在更新已存在文件时提供；创建新文件时携带会被 GitHub 拒绝
  if (sha) {
    body.sha = sha;
  }

  const url = `${API}/${path.join(git.repo, 'contents', filename)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: authHeaders(git.token),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = data.message || res.statusText || 'unknown';

    throw httpError(res.status, `GitHub write failed (${res.status}): ${detail}`);
  }

  return data;
}

/** 用修正后的实现替换实例上的 get / set。 */
function wrapGithub(git) {
  if (!git || git.__walineFixed) {
    return git;
  }
  git.__walineFixed = true;
  git.get = (filename) => readFile(git, filename);
  git.set = (filename, content, options) => writeFile(git, filename, content, options);

  return git;
}

/**
 * 应用修正。通过原型访问器拦截构造函数中的 `this.git = new Github(...)`。
 * thinkjs 的 loader 使用原生 require 加载该模块，与本文件拿到的是同一个类对象，
 * 因此对原型的改动会作用于它创建的所有实例。
 */
function applyGithubStorageFix() {
  const GithubStorage = require('@waline/vercel/src/service/storage/github.js');

  if (GithubStorage.__walineFixed) {
    return;
  }
  GithubStorage.__walineFixed = true;

  Object.defineProperty(GithubStorage.prototype, 'git', {
    configurable: true,
    get() {
      return this.__git;
    },
    set(value) {
      this.__git = wrapGithub(value);
    },
  });
}

module.exports = { applyGithubStorageFix };
