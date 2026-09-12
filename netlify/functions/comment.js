const http = require('http');
const Waline = require('@waline/vercel');
const serverless = require('serverless-http');

const app = Waline({
  env: 'netlify',
  // 使用 GitHub CSV 存储，无需数学公式渲染，关闭 mathjax/katex 以精简函数体积
  markdown: {
    plugin: {
      tex: false,
    },
  },
  async postSave(comment) {
    // do what ever you want after save comment
  },
});

module.exports.handler = serverless(http.createServer(app));
