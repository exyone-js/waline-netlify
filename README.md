# Waline on Netlify · GitHub 多 CSV 分片存储

把 Waline 评论系统的评论数据以 **CSV 分片文件**的形式存放在 GitHub 仓库里：
不引入任何外部数据库或对象存储，备份即仓库备份，数据变更全部留有 git 历史。

本仓库在 [walinejs/netlify-starter](https://github.com/walinejs/netlify-starter) 的基础上，
用一套自定义存储适配器替换了官方 `@waline/vercel` 的"单文件 CSV"实现：

| | 上游单文件方案 | 本仓库多分片方案 |
|---|---|---|
| 数据布局 | `data/Comment.csv` 一个文件 | `waline-data/comments/<xx>/<xxxx>.csv` 多个分片 + `_manifest.csv` |
| 查询 | 下载整个 CSV → JS 逐行过滤 | 内存索引筛出候选 → 只读命中分片 |
| 写入 | 重写整个 CSV | 只重写受影响分片，一次请求合并成一次 Git 提交 |
| 并发安全 | 无（后写覆盖先写） | 分片 SHA 校验 + ref 非快进拒绝 + 自动合并重试 |
| 备份 | 无 | 每日快照 + 可一键恢复 |

实测数据见 [overlay/benchmark/REPORT.md](overlay/benchmark/REPORT.md)（由 `npm run benchmark` 生成）。

### 仓库布局：上游 starter + 一层 overlay

本仓库刻意保持"上游 + 补丁"的形状——所有改造都收在 `overlay/` 一层目录里，
根目录不新增任何平级目录，因此和上游 starter 的 diff 一眼能看清：

```text
netlify/functions/comment.js    # 唯一的上游接线点：Waline({ model, plugins })
overlay/                        # ← 我们做的全部改造都在这一层里
├── storage/                    #   多 CSV 分片存储适配器（实现 + GitHub 客户端 + 快照 + 入口）
├── test/                       #   内存版 GitHub API 与 43 个用例
├── benchmark/                  #   性能对比基准与生成的报告
└── empty-stub/                 #   依赖桩（package.json 的 overrides 指向它）
```

`overlay/empty-stub` 是给 `@mathjax/*`、`leancloud-*` 等重依赖用的空实现，
作用是让 Netlify 的依赖体积保持在限额内；它与 storage 无关，只是同样属于"我们对上游的改写"。

---

## 1. 目录结构

```text
waline-data/                      # 数据根目录（CSV_STORE_DIR，默认 waline-data）
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
└── _snapshots/                   # 每日快照
    └── 2026-09-25/
        ├── comments/…
        ├── users/…
        └── counters/…
```

### 分片规则（稳定可预测，只由 key 决定）

| 表 | 分片 key | 路径 |
|---|---|---|
| `Comment` | `url` | `comments/<sha1(url)[0:2]>/<sha1(url)[0:4]>.csv` |
| `Counter` | `url` | `counters/<sha1(url)[0:2]>/<sha1(url)[0:4]>.csv` |
| `Users`  | `objectId` | `users/<objectId[0:2]>/<objectId[0:2]>.csv` |

- **为什么 Comment/Counter 用 url 哈希做文件名**：同一篇文章的评论必然落在同一个分片族里，
  按文章查询只需读一个分片，局部写入也只影响一个分片。
- **为什么 Users 只用 2 位前缀且"目录名 = 文件名"**：Users 的分片 key 是一行一个的
  `objectId`，若照搬 4 位前缀，10 万用户会产生约 10 万个只有一行的小文件；用 2 位前缀
  把分片数收敛到有限个桶，每片容纳成百上千行。
- **裂变**：分片族内任一文件达到 `SHARD_MAX_ROWS` 行后，新记录写入 `<前缀>-1.csv`、`-2.csv`…
  保证单个 CSV 不会无限增长。
- **合并**：族内总行数回落到阈值以内时，可通过 `POST /waline-data/compact` 压缩回基础分片。

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

---

## 2. 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `GITHUB_TOKEN` | ✅ | | 需要该仓库的 `contents: read & write` 权限 |
| `GITHUB_REPO` | ✅ | | `owner/repo`（粘贴完整 URL 或带 `.git` 也能自动归一化） |
| `GITHUB_BRANCH` | | `main` | 数据所在分支 |
| `CSV_STORE_DIR` | | `waline-data` | 数据根目录 |
| `SHARD_MAX_ROWS` | | `2000` | 单个分片行数上限，超过则裂变 |
| `SHARD_HASH_LEN` | | `2` | 一级目录哈希前缀长度（越大分片越多越小） |
| `FLUSH_INTERVAL` | | `30000` | 定时刷盘间隔（ms）；serverless 下主要靠"响应前刷盘" |
| `MAX_BATCH_SIZE` | | `50` | 单次 Git 提交最多包含的分片数 |
| `MAX_RETRIES` | | `3` | 一次 flush 的最大尝试次数（含冲突重试） |
| `CSV_CACHE_TTL` | | `60000` | 内存缓存有效期（ms），到期后检查 manifest 变化 |
| `DEDUP_WINDOW_SECONDS` | | `60` | 重复提交去重窗口；`0` 表示关闭 |
| `SNAPSHOT_KEEP_DAYS` | | `30` | 快照保留天数；`0` 表示关闭快照功能 |
| `SNAPSHOT_HOUR` | | `3` | 每日快照的触发时点（本地时间的整点） |
| `JWT_TOKEN` | | | 与 Waline 本身一致，用于管理员登录态 |
| `GITHUB_API_BASE` | | `https://api.github.com` | 仅用于测试/自建代理 |

其余 Waline 环境变量（`SITE_NAME`、`COMMENT_AUDIT`、`SMTP_*`、`SECURE_DOMAINS` 等）
与官方文档完全一致，本改造不改变任何上层行为。

> `COMMENT_AUDIT=true` 时新评论默认 `waiting`，管理员在后台批准后才出现在前台，
> 这是 Waline 自身的审核工作流，存储层只负责如实保存 `status` 字段。

---

## 3. 部署步骤

1. **Fork 本仓库**（或使用 Deploy to Netlify 按钮创建站点）。
2. 在 Netlify 站点设置里添加环境变量：
   - `GITHUB_TOKEN`：Fine-grained token，权限 `Contents: Read and write`，仓库选你的数据仓库。
   - `GITHUB_REPO`：例如 `your-name/your-blog-data`。
   - `GITHUB_BRANCH`：例如 `main`。
   - 建议同时设置 `JWT_TOKEN`（随机字符串）以便登录态稳定。
3. 部署完成后访问 `https://<你的站点>/ui/register` 注册第一个账号，它会成为管理员。
4. 在站点前端里把 `serverURL` 指到该站点即可。

**数据仓库准备**：把 `GITHUB_REPO` 指向一个仓库即可，无需手工建目录——首个评论写入时
会自动创建 `waline-data/`。如果仓库是全新的（还没有任何提交），也能正常工作：
首次写入会创建分支与首个提交。

**本地开发**：

```bash
npm install
npm test          # 43 个用例：单元 + 集成 + 真实 Waline 运行时端到端 + 内存预算
npm run benchmark # 生成 overlay/benchmark/REPORT.md
```

---

## 4. 运维接口

所有接口都需要管理员身份（`Authorization: Bearer <登录 token>`），路径后缀固定为
`/waline-data/<action>`。

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/waline-data/snapshot` | 立即创建快照并清理过期快照 |
| `GET` | `/waline-data/snapshot` | 列出已有快照日期 |
| `POST` | `/waline-data/restore` | 用快照覆盖恢复，body/query 传 `date=YYYY-MM-DD` |
| `POST` | `/waline-data/compact` | 把行数回落的分片族压缩回基础分片 |
| `POST` | `/waline-data/rebuild` | 以仓库真实文件为准核对分片并修正 manifest（人工改过仓库后使用） |
| `POST` | `/waline-data/flush` | 手动把内存中待提交的变更落盘 |

示例：

```bash
TOKEN=<登录后在浏览器里拿到的 token>
curl -X POST https://<站点>/api/waline-data/snapshot -H "Authorization: Bearer $TOKEN"
curl -X POST "https://<站点>/api/waline-data/restore?date=2026-09-25" -H "Authorization: Bearer $TOKEN"
```

### 每日快照

默认每天（`SNAPSHOT_HOUR` 之后）由第一个到达的请求触发一次，当天只执行一次。
快照只引用已有 blob，**零内容上传**，几百个分片也只是一次提交。

如果需要精确的时点，用平台的 Scheduled Function 或 VPS 的 crontab 定时调用
`POST /waline-data/snapshot` 即可。

### 恢复

- **推荐**：`POST /waline-data/restore`，用某个日期的快照整体覆盖 `waline-data/`
  （同时删除快照之后多出来的文件，恢复后状态与该快照完全一致）。
- **手工**：直接在 GitHub 上把 `_snapshots/<date>/` 下的文件复制回原路径也能恢复；
  数据本身就在 git 里，任何历史版本都可以通过 git 找回。

---

## 5. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 评论提交返回 500 `评论存储提交失败` | 提交 GitHub 失败且重试耗尽；内存变更已回滚，**数据没有丢一半** | 检查 `GITHUB_TOKEN` 权限与 GitHub 状态；确认访问令牌没过期 |
| 日志出现 `无法访问 GitHub 仓库` | `GITHUB_REPO` 不是 `owner/repo`，或 token 未授权该仓库 | 修正环境变量后重新部署 |
| 页面读到的评论变少了 | 内存缓存尚未过期（默认 60s），其他实例刚写入 | 等一个 `CSV_CACHE_TTL` 周期；或调小该值 |
| 有人直接在 GitHub 上改了 CSV，前台没变 | 读路径只信任 manifest 记录的 SHA | 调 `POST /waline-data/rebuild` 核对并同步 |
| `Git Trees API 返回被截断` | 仓库文件数超过 10 万，无法安全做快照 | 拆分仓库，或调大 `SHARD_HASH_LEN` 之外的粒度设置 |
| 分片文件太多 | 文章数很多，一片一族是设计使然 | 调小 `SHARD_HASH_LEN` 会把同一目录下的文章合并到更少的分片 |

### 写入可靠性设计（为什么不会丢评论）

1. **响应前落盘**：中间件在每次请求返回之前 `await flush()`。Netlify/Lambda 实例
   在响应后会被冻结，只靠定时器刷盘是不可靠的。落盘失败会把响应改成 5xx，
   绝不让客户端以为"保存成功"。
2. **写后读一致**：变更是先应用到内存（含索引），再异步提交。`add()` 返回后立刻
   `select()` 就能看到，`add()` 返回的主键也一定有效。
3. **原子提交**：分片与 manifest 在同一次 Git Data API 提交里落地，要么全部生效，
   要么全部不生效。
4. **乐观锁**：读取顺序固定为"先读 head、再读数据"，提交时 `force=false` 更新 ref。
   只要在读取数据之后有人提交过，我们的非快进更新就会被 GitHub 拒绝。
5. **冲突合并**：被拒后重新拉取 manifest，只下载 SHA 变化的分片，按"本地优先 +
   尊重本实例删除"的规则合并，再重试（最多 `MAX_RETRIES` 次）。
6. **失败回滚**：重试耗尽后把内存恢复到"最后一次提交成功"的状态并丢弃待提交标记，
   让进程内状态与远端重新一致，同时把错误抛给调用方。
7. **幂等去重**：`mail + url + 内容哈希` 相同且落在 `DEDUP_WINDOW_SECONDS` 内的提交
   直接返回既有记录，避免刷新/重放导致的重复写入。

---

## 6. 与上游实现的差异（重要）

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

## 7. 代码结构

| 文件 | 职责 |
|---|---|
| [netlify/functions/comment.js](netlify/functions/comment.js) | Netlify Function 入口（注入 `model` 与插件，是唯一改动的上游文件） |
| [overlay/storage/github-client.js](overlay/storage/github-client.js) | GitHub Contents API / Git Data API 封装、SHA 校验、批量提交、重试 |
| [overlay/storage/shard-manager.js](overlay/storage/shard-manager.js) | 分片命名与路由、manifest、CSV 编解码、裂变与合并规划 |
| [overlay/storage/csv-shard-cache.js](overlay/storage/csv-shard-cache.js) | 分片加载、内存索引、条件查询（where/order/limit）、变更与回滚 |
| [overlay/storage/shard-write-queue.js](overlay/storage/shard-write-queue.js) | 写入合并、按分片提交、冲突检测与重试 |
| [overlay/storage/csv-model.js](overlay/storage/csv-model.js) | Waline `CustomModel` 适配器实现 |
| [overlay/storage/snapshot.js](overlay/storage/snapshot.js) | 快照创建、保留策略、恢复 |
| [overlay/storage/index.js](overlay/storage/index.js) | 入口：模型注入、中间件、运维接口、管理员鉴权 |
| [overlay/test/](overlay/test/) | 内存版 GitHub API 与 43 个用例（真实 Waline 运行时端到端、并发冲突、分片裂变、快照恢复、内存预算） |
| [overlay/benchmark/](overlay/benchmark/) | 性能对比基准与报告生成 |
| [overlay/empty-stub/](overlay/empty-stub/) | 重依赖的空实现桩（由 `package.json` 的 `overrides` 指向） |

### 内存占用

全部数据常驻内存（分片按需加载，只在远端 SHA 变化时重新下载），这是"查询不碰网络"
的前提。`overlay/test/memory.spec.js` 会把这条假设钉死：**10 万条评论（1973 个分片）的行对象
加上 `byId` / `byField` / 分片族索引，实测常驻约 88 MB**，低于 100MB 预算，超出即测试失败。

索引刻意保持精简：主键直达（`byId`）、等值/IN 的倒排桶（`byField`）、分片族索引
（新增记录时 O(族内分片) 定位落点）。重复提交的指纹**不做全局索引**——10 万条评论下
那份 `Map<hash, Set>` 实测要占 20MB 以上（接近总量四分之一），而它只在新增评论时用一次，
因此改成在"同一 url 的候选行"上现算。
