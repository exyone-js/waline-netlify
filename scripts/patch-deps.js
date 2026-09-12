#!/usr/bin/env node
/**
 * 安装依赖后修补第三方包的已知缺陷（替代 patch-package）。
 *
 * 为什么不用 patch-package：
 * 它依赖 unified diff 的行号与上下文，在 CI 复用构建缓存、或跨平台换行符
 * （CRLF/LF）不一致时会失败，而且不是幂等的。这里改为幂等的精确字符串替换：
 * 只依赖稳定的代码片段，可安全重复执行，已打过补丁会自动跳过。
 *
 * 目前修补 @waline/vercel 的 GitHub 存储适配器（src/service/storage/github.js）：
 *   1. get() 未校验 HTTP 状态，数据文件尚不存在(404)时 Buffer.from(undefined) 崩溃；
 *   2. set() 未校验写入结果，GitHub 拒绝写入时异常被吞，评论提示成功但刷新即丢。
 *
 * 片段放在 scripts/snippets/ 下，命名规则：<目标键>__<操作名>.{old,new}。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SNIPPET_DIR = path.join(__dirname, 'snippets');

// 片段文件名前缀 => 依赖内的目标文件
const TARGETS = {
  'waline-github': path.join(
    path.dirname(require.resolve('@waline/vercel/package.json', { paths: [ROOT] })),
    'src',
    'service',
    'storage',
    'github.js',
  ),
};

// 统一换行符，避免 CRLF/LF 差异影响匹配与幂等判断
const normalize = (text) => text.replace(/\r\n/g, '\n');
const read = (file) => normalize(fs.readFileSync(file, 'utf8'));

function applySnippets() {
  const ops = fs
    .readdirSync(SNIPPET_DIR)
    .filter((name) => name.endsWith('.old'))
    .map((name) => name.slice(0, -'.old'.length))
    .sort();

  let patched = 0;
  let skipped = 0;

  for (const op of ops) {
    const [key] = op.split('__');
    const target = TARGETS[key];

    if (!target) {
      throw new Error(`补丁片段 "${op}" 无对应目标（前缀 "${key}" 未在 TARGETS 中注册）`);
    }

    const oldText = read(path.join(SNIPPET_DIR, `${op}.old`));
    const newText = read(path.join(SNIPPET_DIR, `${op}.new`));
    const source = read(target);

    if (source.includes(newText)) {
      skipped += 1;
      continue;
    }

    if (!source.includes(oldText)) {
      throw new Error(
        `无法应用补丁 "${op}"：${target}\n` +
          '  未找到预期片段，可能依赖已升级或被其它方式修改，请检查片段与依赖版本。',
      );
    }

    fs.writeFileSync(target, source.replace(oldText, newText), 'utf8');
    patched += 1;
  }

  return { patched, skipped };
}

try {
  const { patched, skipped } = applySnippets();

  console.log(`[patch-deps] 已应用 ${patched} 处补丁，跳过 ${skipped} 处（已是目标状态）。`);
} catch (error) {
  console.error(`[patch-deps] 修补失败：${error.message}`);
  process.exit(1);
}
