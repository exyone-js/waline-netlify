/**
 * Waline 评论服务的 Netlify Function 入口。
 *
 * 部署形态：GitHub 仓库 + 多 CSV 分片存储（waline-data/ 目录），
 * 追求最轻量（不启用数学公式等重依赖），同时保证高并发下的写入可靠性。
 */

// 下列环境变量必须在 require('@waline/vercel') 之前设置：Waline 的 markdown 解析器
// 在框架加载阶段（controller 模块求值时）就按环境变量创建，之后再传配置已来不及。
// 统一使用 ??= 只提供默认值，不覆盖在 Netlify 环境变量中显式配置的值。

// 不需要数学公式：关闭 mathjax/katex，避免加载其 ESM 依赖。
process.env.MARKDOWN_TEX ??= 'false';

const http = require('node:http');

const Waline = require('@waline/vercel');
const serverless = require('serverless-http');

const { customModel, walineDataPlugin } = require('../../overlay/storage');

// model 覆盖底层存储适配器（多 CSV 分片）；plugins 负责"响应前落盘"与运维接口。
// 两者都是 Waline 的官方扩展点，不涉及任何上层业务逻辑的改动。
const app = Waline({
  env: 'netlify',
  model: customModel,
  plugins: [walineDataPlugin],
});

module.exports.handler = serverless(http.createServer(app));
