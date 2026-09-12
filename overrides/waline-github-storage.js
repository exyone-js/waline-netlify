'use strict';

/**
 * 运行时修正 @waline/vercel 的 GitHub 存储适配器（不修改 node_modules）。
 *
 * 上游 src/service/storage/github.js 存在以下问题：
 *   1. get() 不校验 HTTP 状态：数据文件尚不存在时 GitHub 返回 404，响应体没有
 *      content 字段，Buffer.from(undefined) 会抛 TypeError —— 首次评论必然崩溃；
 *   2. set() 不校验写入结果：GitHub 返回 4xx/5xx 时异常被静默吞掉，表现为
 *      "评论提交成功，但刷新后消失"；
 *   3. GITHUB_REPO 未做归一化：粘贴成完整 URL、带 .git 或首尾空白时，请求会命中
 *      错误地址而返回 404；
 *   4. 主键字段名不一致（致命）：内存数据用 `id`，而 CSV 表头列是 `objectId`。
 *      写盘时 fast-csv 按表头取值，对象上没有 objectId 键 → 主键列恒为空；
 *      读回后 select() 解构 `id` 又得到 undefined。后果：
 *        - 评论 objectId 全空，前端无法挂载、无法管理；
 *        - 登录成功后 jwt.sign(undefined) 抛 "payload is required"，无法登录。
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

/**
 * 归一化 GITHUB_REPO：环境变量常被粘贴成完整 URL 或带 .git / 首尾空白，
 * 这些都会让请求拼出错误地址并返回 404。
 */
const normalizeRepo = (repo) =>
  String(repo ?? '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');

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

/** 仓库是否可访问：GitHub 对无权访问的仓库同样返回 404，需额外区分。 */
async function repoAccessible(git) {
  const res = await fetch(`${API}/${git.repo}`, { headers: authHeaders(git.token) });

  return res.status !== 404;
}

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
 * 失败时抛出可定位的错误，避免评论被静默丢弃。
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
    if (res.status === 404 && !(await repoAccessible(git))) {
      throw httpError(
        404,
        `无法访问 GitHub 仓库 "${git.repo}"：请确认 GITHUB_REPO 为 owner/repo 形式，且 token 已授权访问该仓库`,
      );
    }
    if (res.status === 404) {
      throw httpError(
        404,
        `GitHub 写入失败：仓库 "${git.repo}" 可访问，但文件 "${filename}" 或默认分支不存在；若仓库为空，请先创建一次提交后重试`,
      );
    }

    const detail = data.message || res.statusText || 'unknown';

    throw httpError(res.status, `GitHub write failed (${res.status}): ${detail}`);
  }

  return data;
}

/** 用修正后的实现替换实例上的 get / set，并归一化仓库地址与 token。 */
function wrapGithub(git) {
  if (!git || git.__walineFixed) {
    return git;
  }

  git.__walineFixed = true;
  git.repo = normalizeRepo(git.repo);
  git.token = String(git.token ?? '').trim();
  git.get = (filename) => readFile(git, filename);
  git.set = (filename, content, options) => writeFile(git, filename, content, options);

  return git;
}

/**
 * 生成主键。与上游 add() 保持同一算法（Math.random base36），保证风格一致；
 * 仅用于修复历史脏数据（objectId 列为空的旧行）。
 */
const genId = () => Math.random().toString(36).slice(2, 15);

/**
 * 修正 GitHub CSV 存储实例的主键读写（问题 4）。
 *
 * - collection()：fast-csv 读回的行以 `objectId` 为键，而内部逻辑统一用 `id`
 *   （select/update/delete/add 均解构或写入 id）。读回后统一映射为 id；
 *   对历史遗留的空主键行补一个 id，避免再次写盘时仍为空、且使该行可被管理。
 * - save()：写盘前把内部的 `id` 映射回 CSV 列 `objectId`，fast-csv 才会把主键
 *   写进 objectId 列（否则该列恒为空）。
 */
function wrapStorage(Storage) {
  const proto = Storage.prototype;
  const { collection, save } = proto;

  proto.collection = async function patchedCollection(tableName) {
    const rows = await collection.call(this, tableName);

    rows.forEach((row) => {
      if (row.id === undefined) {
        // fast-csv 用表头命名，主键在 objectId；空值（历史脏数据）则补齐
        row.id = row.objectId === undefined || row.objectId === '' ? genId() : row.objectId;
      }
    });

    return rows;
  };

  proto.save = async function patchedSave(tableName, data, sha) {
    // 内部 id -> CSV objectId；不修改原数组元素，避免污染调用方持有的对象
    const mapped = data.map(({ id, objectId, ...rest }) => ({
      objectId: id ?? objectId ?? '',
      ...rest,
    }));

    return save.call(this, tableName, mapped, sha);
  };
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

  wrapStorage(GithubStorage);

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
