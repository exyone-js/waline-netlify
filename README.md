# Waline on Netlify · GitHub 多 CSV 分片存储

把 Waline 评论系统的评论数据以 **CSV 分片文件**的形式存放在 GitHub 仓库里：不引入任何外部
数据库或对象存储，**备份即仓库备份**，数据变更全部留有 git 历史。

本仓库在 [walinejs/netlify-starter](https://github.com/walinejs/netlify-starter) 的基础上，
用一套自定义存储适配器替换了官方 `@waline/vercel` 的"单文件 CSV"实现：

| | 上游单文件方案 | 本仓库多分片方案 |
|---|---|---|
| 数据布局 | `data/Comment.csv` 一个文件 | `data/comments/<xx>/<xxxx>.csv` 多个分片 + `_manifest.csv` |
| 查询 | 下载整个 CSV → JS 逐行过滤 | 按分片族按需加载 + 内存索引，只碰命中分片 |
| 写入 | 重写整个 CSV | 只重写受影响分片，一个请求合并成一次 Git 提交 |
| 并发安全 | 无（后写覆盖先写） | 分片 SHA 校验 + ref 非快进拒绝 + 自动合并重试 |
| 备份 | 无 | 每日快照 + 一键恢复 + 仓库瘦身 |

实测数据见 [overlay/benchmark/REPORT.md](overlay/benchmark/REPORT.md)（`npm run benchmark` 生成）。
5 万条评论（990 个分片）下：单次评论列表查询从 **1141.9 ms / 22.79 MB** 降到
**0.20 ms / 0 B**；冷启动首次查询只需 **4 次 API 调用 / 167.6 KB / 75.8 ms**
（按需加载，与评论总量基本无关）。

## 目录

- [0. 五分钟上手](#0-五分钟上手)
- [1. 完整部署教程](#1-完整部署教程)
- [2. 数据长什么样](#2-数据长什么样)
- [3. 环境变量](#3-环境变量)
- [4. 备份与运维](#4-备份与运维)
- [5. 从旧版迁移数据](#5-从旧版迁移数据)
- [6. 本地开发](#6-本地开发)
- [7. 故障排查](#7-故障排查)
- [8. 写入可靠性设计](#8-写入可靠性设计为什么不会丢评论)
- [9. 与上游实现的差异](#9-与上游实现的差异重要)
- [10. 代码结构](#10-代码结构)
- [11. 同步上游与升级](#11-同步上游与升级)
- [12. 已知限制](#12-已知限制)

---

## 0. 五分钟上手

```text
1. 新建一个【空的 GitHub 仓库】当数据仓库（建议 Private）
2. 申请一个 Fine-grained token，只给这个仓库 Contents: Read and write
3. Fork 本仓库 → Netlify "Import from Git" → 填 3 个环境变量 → 部署
4. 打开 https://<站点>/.netlify/functions/comment/ui/register 注册管理员
5. 前端把 serverURL 指到 https://<站点>/.netlify/functions/comment
```

> ⚠️ **不要把数据仓库设成站点仓库自己**。每次写评论都会向数据仓库提交一次 commit，
> 若两者是同一个仓库，Netlify 会把每次提交都当成一次部署触发，形成"写入 → 部署 → 写入"的循环。

---

## 1. 完整部署教程

### 1.1 准备数据仓库

新建一个 GitHub 仓库（例如 `your-name/waline-data`），其它全部保持默认：

- **建议设为 Private**：评论 CSV 里含 `mail`、`ip`、`ua` 等字段，公开仓库等于公开这些信息。
- **不要勾选 Add a README**（保持完全空白也可以）：本方案在空仓库上也能工作，
  首个评论写入时会自动创建分支与首个提交 `data/`。
- 如果仓库已有内容、且有 `main` 分支，把 `GITHUB_BRANCH` 指到那个分支即可。
- 一个数据仓库只服务一个站点。多站点共用会让提交互相干扰。

### 1.2 准备 GitHub 访问令牌

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
→ Generate new token：

| 配置项 | 填什么 |
|---|---|
| Token name | 随意，例如 `waline-comments` |
| Expiration | 建议 90 天或自定义（到期前记得换，否则评论会开始 500） |
| Repository access | **Only select repositories** → 选上一步那个数据仓库 |
| Permissions → Contents | **Read and write** |

生成后复制 `github_pat_...` 那串，下一步要用。**它只会出现一次。**

### 1.3 Fork 并接入 Netlify

1. 点本仓库右上角 **Fork**（或用 "Use this template"）到你自己的账号。
2. [Netlify](https://app.netlify.com/) → **Add new site → Import an existing project** → 选你 fork 的仓库。
3. 构建设置保持默认即可（本仓库已用 `netlify.toml` 配好，无需手工填）：

   | 项 | 值 |
   |---|---|
   | Build command | 留空（依赖由 Netlify 自动安装并打包函数） |
   | Publish directory | 留空（纯 Functions 站点，没有静态产物） |
   | Functions directory | `netlify/functions/`（已在 `netlify.toml` 里） |
   | Node version | 24（已在 `netlify.toml` 里） |

4. 先别急着部署，去 **Site configuration → Environment variables** 添加变量（见下节），再触发部署。

> Fork 后有处**必须改**：`netlify.toml` 末尾有一条 favicon 重定向指向本仓库作者的站点，
> 请改成你自己的图标地址，或直接删掉那一段。

### 1.4 配置环境变量

| 变量 | 必填 | 示例 | 说明 |
|---|---|---|---|
| `GITHUB_TOKEN` | ✅ | `github_pat_xxx` | 1.2 生成的令牌 |
| `GITHUB_REPO` | ✅ | `your-name/waline-data` | 数据仓库；贴完整 URL 或带 `.git` 也会自动归一化 |
| `GITHUB_BRANCH` | | `main` | 数据仓库的分支名，默认 `main` |
| `JWT_TOKEN` | 建议 | 一串随机字符串 | 管理员登录态的签名密钥。**不设就每次重新部署都要重新登录**，且会退化用 `GITHUB_TOKEN` 当密钥 |

常用 Waline 变量（与官方完全一致，按需添加）：

| 变量 | 说明 |
|---|---|
| `SITE_NAME` / `SITE_URL` | 站点名与地址，用于邮件通知里的链接 |
| `SECURE_DOMAINS` | 允许嵌入的域名，防止别人盗用你的后端 |
| `COMMENT_AUDIT` | `true` 时新评论默认 `waiting`，需管理员批准 |
| `AKISMET_KEY` | 反垃圾评论 |
| `SMTP_SERVICE` / `SMTP_USER` / `SMTP_PASS` / `AUTHOR_EMAIL` | 邮件通知与找回密码 |

其余变量见 [Waline 官方文档](https://waline.js.org/reference/server/env.html)。
本改造**不改变任何上层行为**，只替换底层存储。

### 1.5 注册管理员

部署成功后访问（注意是 Netlify 的函数路径，没有 `/api` 前缀）：

```text
https://<你的站点>/.netlify/functions/comment/ui/register
```

第一个注册的账号自动成为管理员。之后后台入口是同一个目录下的 `/ui/login`。
如果注册页 500，先看 Netlify 的 Function 日志，十有八九是 `GITHUB_TOKEN` / `GITHUB_REPO` 不对。

### 1.6 前端接入

```html
<link rel="stylesheet" href="https://unpkg.com/@waline/client@v3/dist/waline.css" />
<div id="waline"></div>
<script type="module">
  import { init } from 'https://unpkg.com/@waline/client@v3/dist/waline.js';

  init({
    el: '#waline',
    serverURL: 'https://<你的站点>/.netlify/functions/comment',
  });
</script>
```

框架用户（Hexo / Vitepress / Astro …）同理，把 `serverURL` 指过去即可。
`serverURL` 末尾**不要带斜杠**，也不要加 `/api`——本仓库没有配置 `/api` 重定向。

嫌路径长的话可以在 `netlify.toml` 里自己加一条重定向：

```toml
[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/comment/:splat"
  status = 200
```

之后 `serverURL` 就可以写成 `https://<你的站点>/api`。

### 1.7 验证清单

1. 打开 `https://<站点>/.netlify/functions/comment`（Waline 自带的示例页，可直接在上面发一条评论）。
2. 发完后去数据仓库看：应出现 `data/comments/<xx>/<xxxx>.csv` 与 `data/comments/_manifest.csv`。
3. 调一次 `GET /csv-store/stats`（需管理员 token，见第 4 节），确认 `shards.Comment ≥ 1`、`pending = 0`。
4. 用 `/ui/login` 登录后台，确认能看到刚才那条评论。
5. 前端页面刷新，评论应正常显示。

---

## 2. 数据长什么样

```text
data/                             # 数据根目录（CSV_STORE_DIR，默认 data）
├── comments/                     # Comment 表
│   ├── ab/
│   │   ├── abcd.csv              # 分片：同一篇文章的评论都在这一族分片里
│   │   └── abcd-1.csv            # 行数超过 SHARD_MAX_ROWS 后裂变出来的分片
│   └── _manifest.csv             # 分片清单
├── users/                        # Users 表
│   ├── a1/
│   │   └── a1.csv
│   └── _manifest.csv
├── counters/                     # Counter 表（阅读量等）
│   ├── 3f/
│   │   └── 3f9c.csv
│   └── _manifest.csv
└── _snapshots/                   # 每日快照：一天一个清单文件（path,sha）
    └── 2026-09-25.csv
```

### 分片规则（稳定可预测，只由 key 决定）

| 表 | 分片 key | 路径 |
|---|---|---|
| `Comment` | `url` | `comments/<sha1(url)[0:2]>/<sha1(url)[0:4]>.csv` |
| `Counter` | `url` | `counters/<sha1(url)[0:2]>/<sha1(url)[0:4]>.csv` |
| `Users` | `objectId` | `users/<objectId[0:2]>/<objectId[0:2]>.csv` |

- **为什么 Comment/Counter 用 url 哈希做文件名**：同一篇文章的评论必然落在同一个分片族里，
  按文章查询只需读一个分片，局部写入也只影响一个分片。
- **为什么 Users 只用 2 位前缀且"目录名 = 文件名"**：Users 的分片 key 是一行一个的
  `objectId`，若照搬 4 位前缀，10 万用户会产生约 10 万个只有一行的小文件；用 2 位前缀
  把分片数收敛到有限个桶，每片容纳成百上千行。
- **裂变**：分片族内任一文件达到 `SHARD_MAX_ROWS` 行后，新记录写入 `<前缀>-1.csv`、`-2.csv`…，
  保证单个 CSV 不会无限增长。
- **合并**：族内总行数回落到阈值以内时，可通过 `POST /csv-store/compact` 压缩回基础分片。

### `_manifest.csv`

```csv
shard_path,row_count,sha,updated_at,min_key,max_key
comments/ab/abcd.csv,1832,3f9c…,2026-09-25T10:00:00.000Z,/posts/hello,/posts/hello
```

manifest 是**读路径的核心**：刷新时只拉取三张表的 manifest（3 次 API 调用），
逐条比对 `sha`，只有真正变化的那个分片才会被下载。manifest 与分片永远在同一次
Git 提交中落地，因此不会出现两者不一致的中间态。

### CSV 列

每张表的规范列与 Waline 上层实际读写的字段一致；`sticky`、`like`、`2fa`、
自定义计数器类型等动态列会以"规范列 ∪ 实际出现的动态列"的形式写进表头
（动态列按字母序追加），因此表头稳定且不丢字段。

| 表 | 列 |
|---|---|
| Comment | `objectId, user_id, comment, insertedAt, ip, link, mail, nick, pid, rid, status, ua, url, createdAt, updatedAt` |
| Users | `objectId, display_name, email, password, type, url, avatar, label, github, twitter, facebook, google, weibo, qq, oidc, createdAt, updatedAt` |
| Counter | `objectId, time, url, createdAt, updatedAt` |

文件编码 UTF-8、换行 LF、仅在必要时加引号（RFC 4180 转义）。
**时间列统一为 ISO 8601**（字典序 == 时间序），手工编辑时请保持这个格式。

---

## 3. 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `GITHUB_TOKEN` | ✅ | | 需要数据仓库的 `contents: read & write` 权限 |
| `GITHUB_REPO` | ✅ | | `owner/repo`（粘贴完整 URL 或带 `.git` 也能自动归一化） |
| `GITHUB_BRANCH` | | `main` | 数据所在分支 |
| `CSV_STORE_DIR` | | `data` | 数据根目录 |
| `SHARD_MAX_ROWS` | | `2000` | 单个分片行数上限，超过则裂变 |
| `SHARD_HASH_LEN` | | `2` | 一级目录哈希前缀长度（越大分片越多越小） |
| `FLUSH_INTERVAL` | | `30000` | 定时刷盘间隔（ms）；serverless 下主要靠"响应前刷盘" |
| `MAX_BATCH_SIZE` | | `50` | 单次 Git 提交最多包含的分片数 |
| `MAX_RETRIES` | | `3` | 一次 flush 的最大尝试次数（含冲突重试） |
| `CSV_CACHE_TTL` | | `60000` | 内存缓存有效期（ms），到期后检查 manifest 变化 |
| `DEDUP_WINDOW_SECONDS` | | `60` | 重复提交去重窗口；`0` 表示关闭 |
| `SNAPSHOT_KEEP_DAYS` | | `30` | 快照保留天数；`0` 表示关闭快照功能 |
| `SNAPSHOT_HOUR` | | `3` | 每日快照的触发时点（本地时间的整点） |
| `JWT_TOKEN` | 建议 | | 与 Waline 本身一致，用于管理员登录态 |
| `GITHUB_API_BASE` | | `https://api.github.com` | 仅用于测试/自建代理 |

> `COMMENT_AUDIT=true` 时新评论默认 `waiting`，管理员在后台批准后才出现在前台，
> 这是 Waline 自身的审核工作流，存储层只负责如实保存 `status` 字段。

---

## 4. 备份与运维

所有接口都需要管理员身份（`Authorization: Bearer <登录 token>`）。
**完整路径**是 `https://<站点>/.netlify/functions/comment/csv-store/<action>`
（若你自己配了 `/api` 重定向，就是 `https://<站点>/api/csv-store/<action>`）。

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/csv-store/snapshot` | 立即创建快照并清理过期快照 |
| `GET` | `/csv-store/snapshot` | 列出已有快照日期 |
| `POST` | `/csv-store/restore` | 用快照覆盖恢复，body/query 传 `date=YYYY-MM-DD` |
| `POST` | `/csv-store/compact` | 把行数回落的分片族压缩回基础分片 |
| `POST` | `/csv-store/rebuild` | 以仓库真实文件为准核对分片并修正 manifest（人工改过仓库后使用） |
| `POST` | `/csv-store/flush` | 手动把内存中待提交的变更落盘 |
| `GET` | `/csv-store/stats` | 运行指标：提交/冲突/重试/回滚次数、GitHub 请求数、各表分片数、待提交数 |
| `POST` | `/csv-store/reset` | **不可逆**：丢弃全部历史提交，只保留当前数据（需显式 `confirm=1`） |

```bash
BASE=https://<站点>/.netlify/functions/comment/csv-store
TOKEN=<后台登录后浏览器里拿到的 token>

curl -X POST "$BASE/snapshot" -H "Authorization: Bearer $TOKEN"
curl "$BASE/snapshot" -H "Authorization: Bearer $TOKEN"
curl "$BASE/stats" -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/restore?date=2026-09-25" -H "Authorization: Bearer $TOKEN"
# 仓库瘦身：丢弃历史提交（confirm 必填；快照默认一并丢弃，加 keepSnapshots=1 可保留）
curl -X POST "$BASE/reset?confirm=1" -H "Authorization: Bearer $TOKEN"
```

token 从浏览器里拿：登录后台后打开 DevTools → Network，随便挑一个后台请求，
复制它的 `Authorization: Bearer xxxxx` 那段即可（登录态也保存在浏览器本地存储里）。
接口**只认 `Authorization` 头**，不支持把 token 放在 URL query 里（会被代理日志记下）。

`restore` 的 `date` 必须是 `YYYY-MM-DD`，非法值直接报错（不会拿它去拼路径）。

### 每日快照

默认每天（`SNAPSHOT_HOUR` 之后）由第一个到达的请求触发一次，当天只执行一次。
快照只引用已有 blob，**零内容上传**，几百个分片也只是一次提交。

需要精确时点的话，用平台的 Scheduled Function 或 VPS 的 crontab 定时调
`POST /csv-store/snapshot` 即可。

### 恢复

- **推荐**：`POST /csv-store/restore`，用某个日期的快照整体覆盖 `data/`
  （同时删除快照之后多出来的文件，恢复后状态与该快照完全一致）。
- **手工**：快照清单 `_snapshots/<date>.csv` 就是一份 `path,sha` 列表，
  照它把对应 blob 放回原路径即可；数据本身就在 git 里。

### 仓库瘦身：`POST /csv-store/reset`

写入即提交，所以历史里堆着**每一次分片重写产生的 blob**：仓库体积只增不减，
时间久了会逼近 GitHub 的仓库体积建议值。而评论数据的历史提交没有价值——
任何时点都能用快照恢复。因此提供重置：

- 用当前 `data/` 下的文件构造一个**没有父提交**的 commit，并强制更新分支指针；
- 仓库回到"一个提交"的状态，`.git` 体积随之降到当前数据大小；
- 快照目录（同样只是历史负担）默认一并丢弃，需要保留就传 `keepSnapshots=1`；
- 比"新建仓库再切环境变量"更直接：没有两份数据并存的切换窗口，也不需要改配置。

操作前建议先 `POST /csv-store/snapshot` 拍一张，确认无误再 reset。

---

## 5. 从旧版迁移数据

新方案**不会**读取 `data/Comment.csv`（上游单文件布局）。如果你之前用的是官方方案，
需要把三个文件拆成分片；没有历史数据的话跳过本节，直接开始用即可。

拆分规则就是第 2 节那张表。下面这段脚本可以直接跑（需要本仓库已 `npm install`），
它复用 `overlay/csv-store` 的分片规则，保证与线上用的是同一套逻辑：

<details>
<summary>迁移脚本（点击展开）</summary>

```js
// migrate.js —— 用法：node migrate.js ./waline-data/data
//               参数是数据仓库里的 data 目录本身（里面放着 Comment.csv / Counter.csv / Users.csv）
const fs = require('node:fs');
const path = require('node:path');
const { ShardManager, DATE_FIELDS } = require('./overlay/csv-store/shard-manager');
const { gitBlobSha } = require('./overlay/csv-store/github-client');
const { TABLES } = require('./overlay/csv-store/csv-shard-cache');

const DATA_DIR = path.resolve(process.argv[2]);           // 例：…/waline-data/data
const LEGACY = { Comment: 'Comment.csv', Counter: 'Counter.csv', Users: 'Users.csv' };
const manager = new ShardManager({ storeDir: 'data', shardMaxRows: 2000, hashLen: 2 });
const toFsPath = (repoPath) => path.join(DATA_DIR, repoPath.slice(manager.storeDir.length + 1));

for (const table of TABLES) {
  const src = path.join(DATA_DIR, LEGACY[table]);

  if (!fs.existsSync(src)) {
    console.log(`${table}：没有旧文件，跳过`);
    continue;
  }

  const shards = new Map();

  for (const record of manager.parseShard(fs.readFileSync(src, 'utf8'))) {
    const row = manager.normalizeRow(table, record);

    // 旧数据是 Date.toString()，统一成 ISO 8601
    for (const field of DATE_FIELDS) {
      if (!row[field]) continue;
      const t = Date.parse(row[field]);
      if (!Number.isNaN(t)) row[field] = new Date(t).toISOString();
    }
    if (!row.objectId) continue;

    // 填满优先：基础分片 → -1 → -2 …
    const prefix = manager.shardPrefix(table, row[manager.shardKeyField(table)] ?? '');
    let target = null;
    for (let suffix = 0; suffix < 4096; suffix += 1) {
      const candidate = suffix === 0 ? `${prefix}.csv` : `${prefix}-${suffix}.csv`;
      if (!shards.has(candidate)) { shards.set(candidate, []); target = candidate; break; }
      if (shards.get(candidate).length < manager.shardMaxRows) { target = candidate; break; }
    }
    shards.get(target).push(row);
  }

  const entries = new Map();

  for (const [shardPath, rows] of shards) {
    const content = manager.serializeShard(table, rows, manager.buildColumns(table, rows));
    const target = toFsPath(shardPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    entries.set(shardPath, manager.manifestEntry(table, shardPath, rows, gitBlobSha(content)));
  }

  const manifest = toFsPath(manager.manifestPath(table));
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, manager.serializeManifest(entries), 'utf8');
  console.log(`${table}：${[...shards.values()].reduce((n, r) => n + r.length, 0)} 行 → ${shards.size} 个分片`);
}
```

</details>

迁移完：

1. 提交并推送数据仓库（站点读的是 GitHub 上的分支，本地改完必须推送才生效）。
2. 删掉 `data/Comment.csv`、`data/Counter.csv`、`data/Users.csv`——留着不会被读到，
   但会一直被快照带着。
3. **删掉引用旧路径的旧快照**（`_snapshots/` 下引用 `data/Comment.csv` 的那些）：
   恢复它们会把旧布局覆盖回去，评论就又读不到了。
4. 访问一次站点，用 `GET /csv-store/stats` 确认分片数与评论条数符合预期，再拍一张新快照。

---

## 6. 本地开发

```bash
npm install
npm test          # 55 个用例：单元 + 集成 + 真实 Waline 运行时端到端
                  #            + 并发/限流可靠性 + 内存预算
npm run benchmark # 生成 overlay/benchmark/REPORT.md
```

测试不需要任何真实凭据：`overlay/csv-store-tests/mock-github.js` 是一个会讲 HTTP 的
内存版 GitHub（真的维护 blob/tree/commit/ref 四层对象，真的会拒绝非快进更新），
所以"并发冲突""重试""回滚"这些行为测到的就是线上行为。

想拿真实仓库跑，可以另外建一个测试仓库、把 `GITHUB_TOKEN` / `GITHUB_REPO` 写进 `.env` 后
`netlify dev`（需要 Netlify CLI）。**不要直接拿线上数据仓库做实验**，先 `POST /csv-store/snapshot`。

---

## 7. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 评论提交返回 500 `评论存储提交失败` | 提交 GitHub 失败且重试耗尽；内存变更已回滚，**数据没有丢一半** | 检查 `GITHUB_TOKEN` 权限/有效期与 GitHub 状态 |
| 日志出现 `无法访问 GitHub 仓库` | `GITHUB_REPO` 不是 `owner/repo`，或 token 未授权该仓库 | 修正环境变量后重新部署 |
| `/ui/register` 打不开或 404 | 路径不对（Netlify 下没有 `/api` 前缀）或函数没起来 | 用 `/.netlify/functions/comment/ui/register`；看 Function 日志 |
| 页面读到的评论变少了 | 内存缓存尚未过期（默认 60s），其他实例刚写入 | 等一个 `CSV_CACHE_TTL` 周期；或调小该值 |
| 有人直接在 GitHub 上改了 CSV，前台没变 | 读路径只信任 manifest 记录的 SHA | 调 `POST /csv-store/rebuild` 核对并同步 |
| 部署后站点无限重新构建 | 数据仓库指向了站点仓库自己 | 换成独立的专用数据仓库 |
| `Git Trees API 返回被截断` | 仓库文件数超过 10 万，无法安全做快照 | 拆分仓库，或 `POST /csv-store/reset` 清理历史 |
| 数据仓库体积持续增大 | 每次写入都会重写整个分片并产生新 blob，历史只增不减 | `POST /csv-store/reset`；或调小 `SHARD_MAX_ROWS` |
| 阅读量比实际访问少 | 多实例并发自增（已用"远端值 + 本地增量"合并修掉绝大多数） | 极端并发仍可能少计 1~2 次，计数类数据本就不要求精确 |
| 写入偶发超时 | GitHub API 慢 + 函数超时 | 已设 26s；仍超时可减小 `SHARD_MAX_ROWS` 让单次提交更小 |
| 分片文件太多 | 文章数很多，一片一族是设计使然 | 调小 `SHARD_HASH_LEN` 会把文章合并到更少的分片 |

---

## 8. 写入可靠性设计（为什么不会丢评论）

1. **响应前落盘**：中间件在每次请求返回之前 `await flush()`。Netlify/Lambda 实例
   在响应后会被冻结，只靠定时器刷盘是不可靠的。落盘失败会把响应改成 5xx，
   绝不让客户端以为"保存成功"。并发请求也不会因为复用了在途提交而漏掉自己的写入。
2. **写后读一致**：变更是先应用到内存（含索引），再异步提交。`add()` 返回后立刻
   `select()` 就能看到，`add()` 返回的主键也一定有效。
3. **原子提交**：分片与 manifest 在同一次 Git Data API 提交里落地，要么全部生效，
   要么全部不生效。
4. **乐观锁**：读取顺序固定为"先读 head、再读数据"，提交时 `force=false` 更新 ref。
   只要在读取数据之后有人提交过，我们的非快进更新就会被 GitHub 拒绝。
5. **冲突合并**：被拒后重新拉取 manifest，只下载 SHA 变化的分片，按"本地优先 +
   尊重本实例删除"的规则合并，再重试（最多 `MAX_RETRIES` 次，带退避）。
   计数类表（`Counter`）例外：数值列按"远端值 + 本实例增量"合并，
   否则两个实例各加一次的阅读量会被后提交者覆盖掉一个。
6. **失败回滚**：重试耗尽后把内存恢复到"最后一次提交成功"的状态并丢弃待提交标记，
   让进程内状态与远端重新一致，同时把错误抛给调用方。
7. **幂等去重**：`mail + url + 内容哈希` 相同且落在 `DEDUP_WINDOW_SECONDS` 内的提交
   直接返回既有记录，避免刷新/重放导致的重复写入。
8. **限流友好**：GitHub 次级限流（403 + rate limit 文案）与 429/5xx 都会退避重试，
   并遵循 `Retry-After`；鉴权类错误不重试，直接报错。

---

## 9. 与上游实现的差异（重要）

本改造只替换底层存储适配器，**没有改动任何上层业务逻辑**。为了能正常工作，
下列几处必须与 Waline 的实际契约对齐，与上游行为存在（有意为之的）差异：

1. **CSV 列名**：以上层 controller 真正读写的字段为准（`comment` / `insertedAt` /
   `link` / `objectId` …），而不是任何"看起来更合理"的命名。
2. **`update` 支持函数返回补丁**：上游 `update(data, where)` 在 `data` 是函数时
   会丢弃返回值，导致 GitHub 存储下阅读量（Counter）永远不增长。这里同时支持
   "函数就地修改"与"函数返回补丁对象"。
3. **`LIKE` 转义正则元字符**：上游把关键字直接拼进 `new RegExp`，含 `(`、`[` 等
   字符的搜索关键词会抛错。这里统一转义。
4. **`>` 做真正的时间比较**：上游用 `item[k] >= where[k][1]`，当右侧是 `Date` 时
   字符串与日期比较会得到 `NaN`，条件恒为 false（评论频率限制因此从未生效）。
   这里对日期做显式归一化并按 `>` 语义比较。
5. **动态列不丢**：上游写盘时用 `headers: true`，会把首个写入行之外的额外字段整列丢弃
   （`sticky`、`like`、`2fa`、自定义计数器类型都会丢）。这里用"规范列 ∪ 动态列"。

---

## 10. 代码结构

本仓库刻意保持"上游 + 补丁"的形状——所有改造都收在 `overlay/` 一层目录里，
根目录不新增任何平级目录，因此和上游 starter 的 diff 一眼能看清：

```text
netlify/functions/comment.js    # 唯一的上游接线点：Waline({ model, plugins })
overlay/                        # ← 我们做的全部改造都在这一层里
├── csv-store/                  #   多 CSV 分片存储（适配器 + GitHub 客户端 + 快照 + 入口）
├── csv-store-tests/            #   内存版 GitHub API 与用例
├── benchmark/                  #   性能对比基准与生成的报告
└── empty-stub/                 #   依赖桩（package.json 的 overrides 指向它）
```

| 文件 | 职责 |
|---|---|
| [netlify/functions/comment.js](netlify/functions/comment.js) | Netlify Function 入口（注入 `model` 与插件，是唯一改动的上游文件） |
| [overlay/csv-store/github-client.js](overlay/csv-store/github-client.js) | GitHub Contents API / Git Data API 封装、SHA 校验、批量提交、重试 |
| [overlay/csv-store/shard-manager.js](overlay/csv-store/shard-manager.js) | 分片命名与路由、manifest、CSV 编解码、裂变与合并规划 |
| [overlay/csv-store/csv-shard-cache.js](overlay/csv-store/csv-shard-cache.js) | 分片按需加载、内存索引、条件查询（where/order/limit）、变更与回滚 |
| [overlay/csv-store/shard-write-queue.js](overlay/csv-store/shard-write-queue.js) | 写入合并、按分片提交、冲突检测与重试 |
| [overlay/csv-store/csv-model.js](overlay/csv-store/csv-model.js) | Waline `CustomModel` 适配器实现 |
| [overlay/csv-store/snapshot.js](overlay/csv-store/snapshot.js) | 快照创建、保留策略、恢复、仓库重置 |
| [overlay/csv-store/index.js](overlay/csv-store/index.js) | 入口：模型注入、中间件、运维接口、管理员鉴权 |
| [overlay/csv-store-tests/](overlay/csv-store-tests/) | 内存版 GitHub API 与 55 个用例（真实 Waline 运行时端到端、并发冲突、分片裂变、快照恢复、内存预算） |
| [overlay/benchmark/](overlay/benchmark/) | 性能对比基准与报告生成 |
| [overlay/empty-stub/](overlay/empty-stub/) | 重依赖的空实现桩（由 `package.json` 的 `overrides` 指向） |

`overlay/empty-stub` 是给 `@mathjax/*`、`leancloud-*` 等重依赖用的空实现，
作用是让 Netlify 的依赖体积保持在限额内（外置包约 94MB，低于 250MB 限制）；
它与 csv-store 无关，只是同样属于"我们对上游的改写"。

### 加载范围：按分片族按需加载

缓存里是两层状态：`entries` 是 manifest 里的**权威清单**（全部分片，无论是否读过），
`shards` 才是真正加载进内存的分片内容。查询进来时先算出目标族，只加载命中族：

| 查询形态 | 加载范围 |
|---|---|
| `select({ url })` / `url IN (…)`（评论列表、计数） | 命中族（一篇文章 1~2 个分片） |
| `Users` 按 `objectId` 查（鉴权、用户资料） | 命中族（objectId 前两位决定的桶） |
| 后台列表、模糊搜索、按 `pid`/`rid` 删除、`count({})` | 整表（无法收敛到族，宁可多读也不给不完整结果） |

因此冷启动不再需要把整个数据集读进内存：只读 manifest（每表 1 次请求）+ 命中分片。
只有真正需要全局视图的操作才会把整表读进来，并把该表标记为"已全量加载"。

### 内存占用

已加载的分片常驻内存（只在远端 SHA 变化时重新下载），这是"查询不碰网络"的前提。
`overlay/csv-store-tests/memory.spec.js` 会钉死全量加载时的上界：**10 万条评论（1973 个分片）的行对象
加上 `byId` / `byField` / 分片族索引，实测常驻约 88 MB**，低于 100MB 预算，超出即测试失败。
按需加载让常见路径的实际占用远低于这个上界；索引是分片级增量维护的，
只有分片合并与回滚这类整表重写才做一次全量重建。

索引刻意保持精简：主键直达（`byId`）、等值/IN 的倒排桶（`byField`）、分片族索引
（新增记录时 O(族内分片) 定位落点）。重复提交的指纹**不做全局索引**——10 万条评论下
那份 `Map<hash, Set>` 实测要占 20MB 以上（接近总量四分之一），而它只在新增评论时用一次，
因此改成在"同一 url 的候选行"上现算。

---

## 11. 同步上游与升级

上游 starter 只有依赖升级类提交，同步是安全的：

```bash
git remote add upstream https://github.com/walinejs/netlify-starter.git
git fetch upstream
git merge upstream/master --no-ff
```

`package-lock.json` 几乎必然冲突：**保留本地版本**（`git checkout HEAD -- package-lock.json`）。
本仓库的 lockfile 是 v3 且已按 `overrides` 裁剪过，混进上游的 v2 结构会让 Netlify 依赖体积失控。

`@waline/vercel` 目前锁在 1.41.6。要跟进上游新版本时注意：升级会牵动
`netlify/functions/comment.js` 的 `model` / `plugins` 注入契约与数据表列，
升完必须跑完 `npm test`（含真实 Waline 运行时端到端用例）再上线。

---

## 12. 已知限制

1. **写入依赖 GitHub API**：每条评论约 7 次 API 调用（head/manifest 校验 + blob + tree
   + commit + ref）。令牌配额 5000 次/小时，博客量级绰绰有余，但不适合高频率写入场景。
2. **仓库体积只增不减**：每次写入都会重写整个分片并产生新 blob。用
   `POST /csv-store/reset` 周期性清零历史。
3. **后台"全部评论"列表会整表加载**：数据量大时首次打开较慢（按需加载无法收敛到族）。
4. **跨实例读有 TTL 延迟**（默认 60s）：A 实例写入后，B 实例最多 60s 后才看到。
5. **数据仓库只服务一个站点**：多站点共用一个仓库会让提交互相干扰。
6. **数据里含 PII**（`mail`、`ip`、`ua`）：数据仓库建议设为 Private。
7. **不支持全文检索**：后端只实现了 Waline 实际用到的 `where` 子集（等值 / IN / NOT IN /
   LIKE / `>` / `_complex`）。
