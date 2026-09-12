// 必须在 require('@waline/vercel') 之前设置：Waline 的 markdown 解析器在框架
// 加载阶段（controller 模块求值时）就按环境变量创建，运行后再传配置已来不及。
// 使用 GitHub CSV 存储、无需数学公式，关闭 mathjax/katex 以避免加载其 ESM 依赖。
// 用 ??= 仅作默认值，不覆盖在 Netlify 环境变量中显式配置的 MARKDOWN_TEX。
process.env.MARKDOWN_TEX ??= 'false';
// GITHUB_PATH 为 CSV 数据文件在仓库中的存放目录；Waline 未提供默认值，
// 缺省时内部 path.join(undefined, ...) 会抛 "path argument must be of type string"。
process.env.GITHUB_PATH ??= 'data';

const http = require('http');
const Waline = require('@waline/vercel');
const serverless = require('serverless-http');

const app = Waline({
  env: 'netlify',
  async postSave(comment) {
    // do what ever you want after save comment
  },
});

module.exports.handler = serverless(http.createServer(app));
