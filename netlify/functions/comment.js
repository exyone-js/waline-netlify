/**
 * Waline 评论服务的 Netlify Function 入口。
 *
 * 部署形态：GitHub 仓库 + CSV 文件存储，追求最轻量（不启用数学公式等重依赖）。
 */

// 下列环境变量必须在 require('@waline/vercel') 之前设置：Waline 的 markdown 解析器
// 在框架加载阶段（controller 模块求值时）就按环境变量创建，之后再传配置已来不及。
// 统一使用 ??= 只提供默认值，不覆盖在 Netlify 环境变量中显式配置的值。

// 不需要数学公式：关闭 mathjax/katex，避免加载其 ESM 依赖。
process.env.MARKDOWN_TEX ??= 'false';

// 评论数据文件在仓库中的存放目录（如 data/Comment.csv）。Waline 未提供默认值，
// 缺省时内部 path.join(undefined, ...) 会抛 "path argument must be of type string"。
process.env.GITHUB_PATH ??= 'data';

const http = require('node:http');

const Waline = require('@waline/vercel');
const serverless = require('serverless-http');

const { applyGithubStorageFix } = require('../../overrides/waline-github-storage');

// 修正上游 GitHub 存储适配器的缺陷（见 overrides/waline-github-storage.js）。
// 需在创建应用之前执行；此时 thinkjs 全局已由 require('@waline/vercel') 初始化。
applyGithubStorageFix();

const app = Waline({ env: 'netlify' });

module.exports.handler = serverless(http.createServer(app));
