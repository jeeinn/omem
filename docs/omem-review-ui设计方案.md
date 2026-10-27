# omem review --ui 设计方案

> 状态：**已实施**（2026-10-27）。核心层 `b6d083a`，界面层紧随其后；实施中的两处接口调整见 §5 脚注。
> 范围：V0.1 beta 期的 review 工作流优化
> 关联文档：`docs/记忆可信度的人工核实与Agent协作手册.md`（§3.3 批量命令现状、§3.4 红线、§4.3 memory_feedback 的 P1 风险）
>
> 本文是审计用文档：记录**为什么**这么改、**核实过的事实**、以及**被否决的方案**。实现细节以代码为准，本文不重复代码。

---

## 0. 摘要

`omem review` 现在要求人逐条确认：一条要看两次（`review` 看 id、`review <id>` 看正文），确认还要再敲一次 `--confirm <id>`。实测积压 23 条时，完整走一遍需要 46 次命令。

本方案分两步解决：

1. `omem review --confirm id1,id2,id3` 支持逗号列表（低成本止血）
2. `omem review --ui` 起本地 HTTP 服务，在浏览器里展示可勾选的清单与详情，一次提交批量决议

关键设计是**分级落章**：批量勾选**永不授予 `verified`**（assent，confidence 保底 0.8、只升不降但不封顶），只有真正展开过详情的条目才允许升到 `0.9 / verified:true`。这条门槛由服务端强制，前端无法绕过。

> 修订记录：v2（2026-10-27）按外部审查意见修正 4 处事实错误、收紧 3 处边界、补齐文档清单。详见文末「修订记录」。

---

## 1. 问题

### 1.1 三重浪费

| 层 | 现状 | 代价 |
| --- | --- | --- |
| 数据层 | `omem review` 只输出 id + 50 字标题 + confidence，不输出正文（`src/commands/review.ts` 的 `showEntry` 才打正文） | 每条要看两次 |
| 动作层 | `--confirm` 通过 `flagStr` 取单值，逗号列表不支持（`src/commands/review.ts:53`；手册 §3.3 已记录） | 26 条 = 26 次进程启动 + 26 次索引写入 |
| 通道层 | 确认动作只在 CLI 里，Agent 会话内没有入口 | 判断与操作断在两个窗口 |

### 1.2 队列为什么结构性地清不完

三个原因叠加，不是单纯的 UI 问题：

1. `inReviewInbox()`（`src/commands/review.ts:21`）的规则是「未确认 + active +（14 天内创建 或 confidence ≤0.35 或带 `ungrounded`）」。每次 `omem sync` 都会往里加新条目。
2. 活文档每次更新都重置 `verified`（见 §2.1），所以**确认过的主题会重新回到队列**。
3. 确认动作本身是消耗品，没有 topic 级的"这个主题我信得过"开关。

本方案解决 1 的操作成本，不解决 2、3（见附录 A 的 P2-6）。

---

## 2. 已核实的实现事实

以下均为 2026-10-27 读源码确认，不是推测。行号会随时间漂移，以函数名为准。

### 2.1 topic / 活文档的实际机制

**谁生成**：omem 自己不生成活文档正文。只有三条写入路径：

- Agent 通过 MCP `save_memory`（`source: agent`）
- 用户 `omem add --topic`（`source: manual`，`verified: true`，confidence 0.9）
- API 档（`--tier api`，`source: llm`，`src/process/pipeline.ts` 调模型）

omem 只生成两个派生视图：`PROCESS.md`（待吸收会话）与 `MEMORY-INDEX.md`（L0 热层）。

**命名**：`normalizeTopic()`（`src/core/commit.ts`）——trim → 小写 → 空白转连字符 → 合并连续连字符 → 去首尾连字符。没有注册表，没有反向映射，完全由 Agent 自由命名。

**只有显式传才成立**：`resolveTopic()` 的注释明确「project 只用于归组，不在这里回落」。不传 `topic` 的写入是独立记忆，不是活文档。

**唯一性**：`commitEntry()` 应用层检查（`src/core/commit.ts`）。查到 active 且 `supersedes` 不含它时返回 `excluded`，提示语含 `--force does not bypass this`。`entries` 表**没有** `UNIQUE(topic) WHERE status='active'` 索引，靠单进程串行兜底。

**更新是整篇覆盖，不是增量合并**：

- 新版本 = 新 id + 新文件 + 新 body
- 旧版置 `status=superseded` + `superseded_by`，**文件不搬到 `archive/`，留在 `knowledge/<domain>/<YYYY>/` 原路径**
- 默认检索排除 `superseded` 与 `archived`（`src/core/search.ts`），`--all` 才带出

**继承与丢弃**：

| 字段 | 新版本行为 | 后果 |
| --- | --- | --- |
| `source_sessions` | 继承并累积（`collectSourceSessions`） | 会话吸收历史不丢 |
| `evidence` | **不继承**（`commitEntry` 里只用 `input.evidence`） | 证据链每次更新清零，`scoreEvidence` 重算可能从 0.75 掉回 0.55 |
| `confidence` | 重算 | — |
| `verified` | **重置为 false** | 确认是消耗品，主题反复回队列 |
| `confirmations` | 归 0（`newFrontmatter`） | 累计确认次数丢失 |

**`PROCESS.md` 的分组名不是 topic**：`pendingTopics()` 用 `session.project_fp` 分组，`GuideTopic.topic = project`，文档连线走 `entry.fm.project === project_fp`。渲染文案原话是「Project grouping is not a topic」。Agent 若把分组名当 topic 传给 `save_memory`，会造出以项目指纹命名的活文档。

**topic 一致性只有一处护栏**：`isNearDupTopic()`（前缀相同或去分隔符后相同）只在 API 档触发 warn，`save_memory` 路径完全不检查。

### 2.2 与本次改动相关的技术约束

| 约束 | 出处 | 对设计的影响 |
| --- | --- | --- |
| `reconfirm()` 不重建 `MEMORY-INDEX.md` | `src/core/lifecycle.ts` | 单条 `--confirm` 后热层排序不更新，是现存缺陷，本方案顺带修 |
| `applyAssent()` 已存在，语义是「confidence 提底至 0.8（`max`，只升不降）+ 打 `assent` tag + confirmations+1，不设 verified」 | `src/process/score.ts` | 直接复用，不新造概念 |
| `applyAssent()` 本身是**批量接口**（收 `ids[]`），循环后只重建一次热层 | `src/process/score.ts:151-169` | 若 `applyReviewDecisions` 对每条决策单独调它，才会退化成 N 次重建；实现时**按 action 聚合后一次性传入** |
| `--supersedes` 走 `idList()` 支持逗号列表，`--confirm` 走 `flagStr` 只收单值 | `src/commands/review.ts:45,48` | 批量 confirm 仍须拒绝 supersedes，但理由是**语义**（N 个旧 id 对应 1 个新文档，批量取代无法指定归属），不是解析限制 |
| 手册 §0 铁律 1「`review --confirm` 只翻 verified，不动 confidence」**曾与代码矛盾**（已于 2026-10-27 修正） | `reconfirm()` 实际写 `confidence = 0.9`（`src/core/lifecycle.ts:74`）；`AGENTS.md` 也写 raises confidence to 0.9 | 已改正；否则本文引用「手册实测记录」会自相矛盾 |
| `tsc` 只编译 `src/**/*.ts` | `tsconfig.json` 的 `include` | 静态 HTML 不会被复制进 `dist/`，页面必须内联为 TS 字符串 |
| `VALUE_FLAGS` 有防漂移测试 | `tests/unit/cli-args.test.ts` 扫描 `src/` | 新增 `--port` / `--timeout` 必须注册，否则测试红 |
| MCP 工具面不改 | `AGENTS.md`「Do not expand the default tool surface」 | 本方案完全不动 `src/mcp/tools.ts` |

---

## 3. 决策记录

### 3.1 方案选型

| 方案 | 做法 | 点选体验 | 成本 | 结论 |
| --- | --- | --- | --- | --- |
| A. MCP 双工具 + 宿主原生控件 | `review_queue` + `review_apply`，UI 交给 Agent | 好 | 中 | 否决：需修订「默认 2 个工具」的规格决策；且 UI 质量取决于宿主 |
| B. MCP elicitation 表单 | 协议标准 `elicitation/create` 逐条询问 | 差（一次一条） | 中 | 否决：26 次往返比 CLI 更慢，schema 不支持多选 |
| **C. 本地确认页** | `omem review --ui` 起 localhost 页面 | **最好**（正文并排、可全选） | **中高** | **采纳** |
| D. CLI 批量 | `--confirm id1,id2,id3` | 无（终端） | 最低 | 采纳，作为 C 的前置步骤 |

**选 C 的理由**：MCP 协议只有 tools / resources / prompts，没有 UI 渲染能力。真正的「点选」只能由宿主 agent 或浏览器提供。既然确认动作本身需要人看图判断（正文 + 证据 + 来源），浏览器比聊天卡片更适合承载信息密度。

### 3.2 已拍板的设计点

| # | 决策 | 理由 |
| --- | --- | --- |
| 1 | 终端 `Enter` 只表示「授权打开浏览器」，不是提交 | 提交的唯一入口是页面按钮，避免两个提交源 |
| 2 | 接受「展开详情才给 verified」门槛 | 把「人是否真的看过」变成可执行条件，防止批量全选变成静默盖章 |
| 3 | 详情页显示 `source_sessions` 对应会话标题 | 判断「这条结论从哪来」需要来源，先实现并测量性能，太慢再降级 |
| 4 | 服务端记录已阅集合，前端无法伪造 | `readIds` 只在 `GET /api/detail/:id` 成功时写入 |

**决策 2 的语义边界**：`verified: true` 是整个可信度体系的地基，而待审条目绝大多数由 Agent 自己写入（`source: agent`）。给 Agent 或给「全选按钮」批量盖章的能力，等于让 Agent 确认自己的产出——手册 §4.3 已把 `memory_feedback(helpful=true)` 这条现有路径标为 P1 风险。因此批量路径的天花板必须低于单条人工确认。

---

## 4. 设计

### 4.1 交互流程

```
$ omem review --ui

Review UI is ready at http://127.0.0.1:52341/?token=8f3a…
Press Enter to open it in your browser, Ctrl+C to cancel.
                                    ← 用户按 Enter
Waiting for your decisions in the browser… (timeout 10m)
                                    ← 用户在页面勾选、点 Apply
Confirmed 15 · Assent 3 · Archived 4 · Cooled 1
All done. You can close the browser tab.
```

时序说明：服务必须先 `listen` 才能拿到端口并打印 URL，所以敲下命令时服务**已经起来**，`Enter` 只决定「是否调起浏览器」（`--no-open` 等价于永不调起）。

- `Ctrl+C`（任何时刻）：关闭服务、退出码 0、零写入
- 超时（默认 10 分钟）：不写入，打印 `Timed out. Nothing was applied.`
- 提交后：页面锁定为结果视图，服务端拒绝重复提交（409）

### 4.2 分级落章

| 用户行为 | `action` | confidence | verified | 附带 |
| --- | --- | --- | --- | --- |
| 勾选 + 未展开详情 | `assent` | `max(现值, 0.8)`，**只升不降** | false | 打 `assent` tag，confirmations+1，刷新 `last_confirmed` |
| 勾选 + 展开过详情 | `confirm` | 0.9 | true | `last_confirmed` 刷新，confirmations+1 |
| 标 ✕ | `dismiss` | — | — | 移到 `archive/`，status=archived |
| 标 − | `stale` | — | — | status=stale，检索降权 ×0.5 |
| 不操作 | — | — | — | 不进 decisions 数组 |

**`assent` 的 confidence 是保底不封顶**：`applyAssent` 的实现是 `if (fm.confidence < 0.8) fm.confidence = 0.8`，一条 `confidence: 0.9` 但尚未 `verified` 的条目（14 天内仍会进队列）勾选后保持 0.9。真正被批量路径限制的是 **`verified`，不是分数**。测试夹具若用 0.9 的条目，必须断言「保持 0.9」而不是「变成 0.8」。

CLI 的 `--confirm <id>` 走 `requireReadForVerified: false`，保持 `0.9 + verified` 的既有语义（`AGENTS.md` 的 Non-negotiables 与 `reconfirm()` 实现一致；注意手册 §0 铁律 1 此处写反了，见 §2.2 与 §7）。

### 4.3 数据模型

```ts
type ReviewAction = 'confirm' | 'assent' | 'dismiss' | 'stale';

interface ReviewDecision { id: string; action: ReviewAction; read?: boolean }

interface ReviewOutcome {
  id: string;
  /** 调用方请求的动作 */
  requested: ReviewAction;
  /** 实际落地动作；仅 status='ok' 时有意义（如 confirm 因未读降级为 assent） */
  applied: ReviewAction | 'skipped';
  /** 处理结果：ok=已写入；skipped=被规则拒绝；missing=找不到条目 */
  status: 'ok' | 'skipped' | 'missing';
  reason?: string;
  /** 落地后的现值，供终端逐条打印 */
  confidence?: number;
  verified?: boolean;
}
```

逐条判定（核心函数 `applyReviewDecisions` 的行为契约）：

| 请求 | 条目状态 | 结果 |
| --- | --- | --- |
| `confirm` + `read:true` | active | verified=true, 0.9, confirmations+1 |
| `confirm` + `read` 非 true | active | **降级为 assent** |
| `assent` | active | 提底 0.8（只升不降），不设 verified |
| `confirm`/`assent` | superseded / archived | `skipped`，reason 说明 |
| `dismiss` | active | 归档 |
| `dismiss` | 已在 archive | `skipped` |
| `stale` | active（非 stale） | 置 stale |
| 任意 | 不存在 | `missing` |

**不整批回滚**：单条失败记 `skipped` 继续，全部处理完返回逐条结果。

### 4.4 HTTP 契约

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/` | 返回 HTML，校验 token；无效 → 403 |
| GET | `/api/detail/:id` | 校验 token；`id` 限 `[0-9A-Za-z-]{1,64}`（防 path 注入，不硬编码 `YYYY-MM-DD-xxxxxx`，因为测试夹具与手改的 md 可能用别的 id）；返回详情 JSON，**并把 id 记入已阅集合** |
| POST | `/api/apply` | body `{token, decisions}`；校验 token；执行一次；重复 → 409 |

**三个端点全部校验 token**。detail 返回正文，漏校验等于本机任意进程可读全部记忆。

页面首屏内联队列元数据（id/topic/confidence/摘要/计数），正文与会话标题在点击时按需拉取。这样既避免首屏加载全部正文，又天然形成「展开 = 已阅」的判定点。

### 4.5 安全

- `server.listen(port, '127.0.0.1')`，不绑 `0.0.0.0`
- 一次性 token（`randomBytes(24).toString('hex')`），URL query 携带，POST 回传校验
- 校验 `Host` 头为 `127.0.0.1:<port>` **或** `localhost:<port>`（两者都不是可 rebind 的域名；只放行前者会让手输 `localhost` 的用户莫名 403）
- POST 要求 `content-type: application/json`，阻断简单表单跨站提交
- 响应头 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`
- 提交前自动 `omem snapshot`（复用 `createSnapshot` / `pruneSnapshots`，保留 7 份）

---

## 5. 改动清单

### 阶段 A：核心层（可独立验收）

| 文件 | 改动 |
| --- | --- |
| `src/core/lifecycle.ts` | 新增 `applyReviewDecisions(home, index, decisions, opts): ReviewOutcome[]`；循环内不重建热层，末尾按 `opts.refreshIndex` 统一重建一次 |
| `src/process/score.ts` | `applyAssent` 增加 `opts: { refreshIndex?: boolean = true, touchLastConfirmed?: boolean = false }`；`applyReviewDecisions` 按 action 聚合后**一次性传入** `{ refreshIndex: false, touchLastConfirmed: true }`，末尾统一重建一次热层 |
| `src/commands/review.ts` | `--confirm` 改用已有 `idList()` 支持逗号列表；`supersedes.length > 0 && confirmIds.length > 1` 抛 `UsageError` |

`touchLastConfirmed` 默认 `false` 是有意的：MCP 的 `confirm_ids` 由 Agent 代传「用户在本轮对话里同意了」，可靠性低于用户在页面上亲手点击，因此不改变其既有行为；只有 `--ui` 的 assent 刷新 `last_confirmed`。

输出格式向后兼容：单条成功仍打印 `Confirmed: <id> (verified=true, confirmations=N)`；多条逐条打印后附 `Confirmed N / skipped M / missing K`。

### 阶段 B：CLI 入口

| 文件 | 改动 |
| --- | --- |
| `src/commands/review.ts` | 新增 `--ui` 分支；与 `--confirm` / `--dismiss` / `--stale` **及位置参数 `<id>`** 互斥（`UsageError`） |
| `src/commands/review-ui.ts` | 新建：`runReviewUi()` 编排「提示 → 等 Enter → 开浏览器 → 等提交 → 快照 → 应用 → 打印」 |
| `src/cli-args.ts` | `VALUE_FLAGS` 加 `port`、`timeout` |
| `src/cli.ts` | `review` 的 `usage` 字符串加 `--ui` |

### 阶段 C：HTTP 与页面

| 文件 | 改动 |
| --- | --- |
| `src/web/review-data.ts` | 新建：`buildReviewItem` / `buildReviewDetail` / `buildSessionIndex` / `resolveSessionTitles` |
| `src/web/review-server.ts` | 新建：`startReviewServer()` → `{ url, token, port, waitForResult, close }` |
| `src/web/review-page.ts` | 新建：`renderReviewPage(params): string`，内联全部 CSS/JS |

**实施时的两处接口调整**（与本文初稿不同，以代码为准）：

1. `waitForSubmit()` 改为 `waitForResult(): Promise<SubmitResult | null>`。原设计让命令层在 `waitForSubmit` 返回后自己调 `applyReviewDecisions`，但页面就看不到逐条结果（设计 §4.4 要求提交后页面显示结果）。改为服务端接收一个 `onApply` 回调：命令层在回调里先 `runSnapshot` 再落盘，把 `ReviewOutcome[]` 返回给页面。写权限仍然在命令层，服务只做转发。
2. 新增 `src/commands/review-ui.ts` 承担编排（等 Enter、开浏览器、超时、打印结果），`review.ts` 只保留分支判断。

**会话标题解析策略**（性能关键）：先用 `index.listSessions()` 一次 SQL 建 `sessionId → 文件路径` 映射，再按需 `readStoredSession`，模块内加 LRU（上限 200）。禁止对每个 session 遍历 9 个 agent 目录。

**性能埋点**：每次详情请求写 `logs/omem.log` 的 `review.ui.detail` 事件（含 `sessions` 数、缓存命中数、`ms`），同时在终端打一行 `Detail <id> · 12 sessions · 38ms`。这是本次要验证的核心指标。

### 阶段 D：顺带修复

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `src/core/index.ts` | `findActiveByTopic` 排序从 `last_confirmed DESC` 改为 `created DESC` | 与 `guide.ts` 的 `fillDocSlot` 口径统一。现排序下，对旧版跑一次 `review --confirm` 会让它盖过真正的最新版，下次写入 supersede 错对象 |
| `src/core/entry.ts` | 新增 `normalizeDomain()` | 规则：保留 `[a-z0-9-]` 与中日韩字符，其余折叠为 `-`，空 → `general` |
| `src/core/store.ts` | 在 `entryPath()` **内部**归一化 `fm.domain` | 一处改动覆盖 `writeEntry` / `updateEntry` / `moveToArchive`。只放 `commitEntry` 管不住 `updateEntry`——外部编辑一条 domain 脏的 md 后，`review --confirm` 触发 `updateEntry` 仍会把文件写/删到仓库外 |
| `src/core/commit.ts` | 写入前用 `normalizeDomain` 净化 frontmatter 值 | 路径安全由 `entryPath` 兜底，这里保证落盘的 `domain` 字段本身也干净（否则检索的 domain 过滤与热层标签仍带脏值） |

两层防护的分工必须都做：`entryPath` 防的是「文件被写到知识库外」，`commitEntry` 防的是「frontmatter 里的脏值污染检索与展示」。

---

## 6. 测试点

### `tests/unit/review-decisions.test.ts`（新建）

- `confirm` + `read:true` → verified=true, 0.9, confirmations+1
- `confirm` 无 `read` → 降级 assent，verified=false, confidence=0.8, tag 含 `assent`
- `confirm` 无 `read` + 条目原 confidence=0.9 → assent 后**仍为 0.9**（钉住 `max` 语义，防止实现写成固定赋值 0.8）
- `confirm` 无 `read` + `requireReadForVerified:false` → 仍 verified（CLI 路径）
- `--confirm a,b --supersedes x` → `UsageError`（批量取代无法指定归属）
- 对 superseded / archived 条目 confirm → `skipped`
- `dismiss` → 文件移入 `archive/`，旧路径不存在
- `stale` → status=stale
- 不存在 id → `missing`
- 混合 5 条 → 逐条结果正确，无整批失败
- 空数组 → `[]`
- 批量 10 条只重建 1 次热层（spy `generateMemoryIndex`）
- `outcomes` 顺序与 `decisions` 一致

### `tests/unit/review-server.test.ts`（新建）

- 无 token → 403（`/`、`/api/detail/:id`、`/api/apply` 三个端点各一例）
- 正确 token → 200 且含队列标题
- `/api/detail/:id` 返回正文；重复请求不重复记已阅
- `/api/detail/<含非法字符的 id>` → 400（path 注入防护）
- 不存在的 id → 404
- `apply` 未读条目 + confirm → 落地 assent；已读 → verified
- 重复 POST → 409
- `Host` 头不符 → 403
- `close()` 后连接失败

### `tests/unit/review-data.test.ts`（新建）

- `ReviewItem` 的摘要/计数/`versionChain` 正确
- 自环 `supersedes` 不死循环
- 会话标题取首条 `## user` 首行，截断 60
- 会话不在 index → 占位不抛错
- 同一 session 两次调用只读一次文件

### 回归风险

| 测试 | 风险 | 处理 |
| --- | --- | --- |
| `review-queue.test.ts` | `--confirm` 输出格式变更 | 保留单条原格式 |
| `commit.test.ts` | `normalizeDomain` 改变 domain 值 | 检查是否有非 ascii domain 用例 |
| `guide-docid.test.ts` | `findActiveByTopic` 排序变更 | 若依赖旧排序，改用例并注释原因 |
| `cli-args.test.ts` 防漂移 | 新旗标未注册 | 必须加进 `VALUE_FLAGS` |
| `store.test.ts` | `entryPath()` 内归一化 domain 后，路径断言可能变化 | 现有 fixture 的 domain 都是 `coding`/`general`/`d` 等合法值，预期不受影响；补一例 `domain: '../../x'` 断言路径仍在 `knowledge/` 内 |

---

## 7. 文档更新

| 文件 | 改什么 |
| --- | --- |
| `README.md` | 命令表加 `--ui`；说明 `--confirm` 支持逗号列表 |
| `AGENTS.md` | **Modules 表必须登记 `src/web/`**（新分层）。这张表是「下一个改代码的人或 Agent」的权威地图，新增模块层不登记，违反的正是仓库自己的纪律 |
| `ARCHITECTURE.md` | **必须**（不是可选）：分层表加 `src/web/`，CLI 层补 `review --ui`。`docs-consistency.test.ts` 虽不检查此项，但该测试存在的原因（2026-10-26 审计）就是「文档说的和代码做的不一致」 |
| `docs/记忆可信度的人工核实与Agent协作手册.md` §3.3 | 「一条 `--confirm` 只接受一个 id，逗号列表不支持」必须改 |
| `docs/记忆可信度的人工核实与Agent协作手册.md` §0 铁律 1 | **已修正（2026-10-27）**：「`review --confirm` 只翻 verified，不动 confidence」与 `reconfirm()` 实际写入 0.9 矛盾，已改为准确表述 |
| `docs/手动测试指南.md` | 补 5 步手工验证（见 §8） |

---

## 8. 手工验证清单

1. `omem review --ui` → 提示 → Enter → 浏览器打开，23 条可见
2. 点开 3 条详情并勾 ✓；另勾 2 条不展开 → 提交
3. 终端输出 `Confirmed 3 · Assent 2`；`omem review` 队列减少 5 条
4. 检查那 3 条 md：`verified: true`、`confidence: 0.9`；另 2 条带 `assent` tag 且 `verified: false`
5. `omem audit --tail 20` 查看 `review.ui.detail` 的 ms 分布

---

## 9. 提交计划

| # | message | 内容 | 可独立回滚 | 状态 |
| --- | --- | --- | --- | --- |
| 0 | `docs: add review --ui design doc and correct a stale confidence rule` | 本文 + 手册铁律 1 | 是 | **已提交 5d630f2** |
| 1 | `refactor(core): extract applyReviewDecisions for batch review` | 阶段 A + `--confirm` 批量 + 19 个用例 | 是 | **已提交 b6d083a** |
| 2 | `feat(review): --ui browser review with read-gated verification` | 阶段 B + C + 23 个用例 | 是（去掉 flag 即失效） | 待提交 |
| 3 | `fix(core): unify topic ordering and normalize domain at entryPath` | 阶段 D（含 `entryPath` 内归一化 + `commitEntry` 净化 + `store.test.ts` 路径用例） | 是 | 待办 |
| 4 | `docs: document review --ui and batch confirm` | §7 全部 | 是 | 待办 |

验收顺序建议：先在真实库上跑 `omem review --confirm id1,id2`（已可用），再跑 `omem review --ui --no-open` 看页面与耗时埋点。

---

## 10. 参数确认（2026-10-27 已定）

| # | 问题 | 取值 | 依据 |
| --- | --- | --- | --- |
| 1 | `assent` 是否刷新 `last_confirmed` | **刷新**（仅 `--ui` 路径） | 人手点击是人工介入信号；gc 语义是「长期没人看」，不刷新会让 assent 过的条目 30 天后仍被标 stale。MCP 的 `confirm_ids` 保持不刷新，见 §5 阶段 A |
| 2 | 无 TTY 环境执行 `--ui` | 跳过 Enter 等待，打印 URL 后继续阻塞 | 远程 SSH + 端口转发场景仍可用；抛 `UsageError` 会把这条路堵死 |
| 3 | 页面是否遵守 `PAGE=10` 分页 | **不分页**，队列全量展示 | `inReviewInbox` 规则天然限流（14 天窗口 + 低置信），771 条只出现在 fixture 场景 |

---

## 11. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 浏览器被关掉但终端仍在等 | 超时兜底（10 分钟），不写入任何东西 |
| 页面提交时条目已被 Agent 更新（superseded） | 提交后逐条重新 `findById` 校验 status，失败记 `skipped`，不整批回滚 |
| 用户全选以图省事 | 未展开的条目**不授予 `verified`**（confidence 只保底 0.8），进不了热层最前 |
| 页面渲染耗时影响判断 | 详情按需加载 + 会话标题 LRU；埋点可观测，太慢可关闭标题功能 |
| 端口冲突 | 默认 `port: 0` 由系统分配，`--port` 可指定 |

---

## 附录 A：topic 现存问题清单

| 级别 | 问题 | 方案 | 状态 |
| --- | --- | --- | --- |
| P1 | `findActiveByTopic` 与 `fillDocSlot` 排序口径不一致 | 统一为 `created DESC` | ✅ 阶段 D（`a253e36`） |
| P1 | `domain` 未校验直接进路径 | `normalizeDomain()`，下沉到 `entryPath` | ✅ 阶段 D（`a253e36`） |
| P1 | `evidence` 不继承，更新即证据清零 | 继承并加上限（8 条 / 2000 字符） | ❌ 未做 |
| P2 | Agent 不知道有哪些既有 topic，容易造同义新主题 | `PROCESS.md` 追加 `## Existing topics` 词表 | ✅ 已做 |
| P2 | `isNearDupTopic` 只在 API 档生效 | 下沉到 `commitEntry`，返回 `warnings[]` 不拒绝 | ✅ 已做 |
| P2 | 跨主题合并静默丢掉旧主题名 | `commitEntry` 返回 `warnings` + `omem topic list --all` 给出归宿映射 | ✅ 已做 |
| P2 | `omem search` 不显示 topic | 命中行补 `· topic:xxx`（CLI 与 MCP 同步） | ✅ 已做 |
| P2 | 活文档每次更新重置 verified，主题反复回队列 | topic 级审阅策略（`review.toml` 的 `always/once/never`） | ❌ 待定 |
| P3 | `omem topic list` 缺失 | 运维命令 | ✅ 已做（`merge` 仍未做，当前无近似对需要它） |
| P3 | `source_sessions` 无限累积 | 软上限（保留最近 50 + 总数计数） | ❌ 未做 |

「topic 级审阅策略」是「确认完还会回来」的根治方案，排在 `--ui` 之后：先用真实队列跑一轮，判断 `assent` 档够不够用，再决定要不要引入 policy 文件。

---

## 附录 B：被否决的细节


| 设想 | 否决理由 |
| --- | --- |
| 用一个 MCP 工具做「点选确认」 | MCP 无 UI 渲染能力；`elicitation` 只支持扁平 primitive 表单，一次一问，不支持多选 |
| 让 Agent 读队列后自己批量确认 | 待审条目绝大多数由 Agent 自己写入，属自我盖章；手册 §4.3 已标 P1 风险 |
| 用 `memory_feedback(helpful=true)` 作为确认入口 | 语义错位（「有用」≠「正确」），且一次一条；不建议扩大该工具面 |
| 批量确认直接给 `verified: true` | 会污染 `MEMORY-INDEX.md` 的「verified 优先」排序，把未细看的条目顶到热层最前 |
| 把 topic 审阅策略塞进 `config.toml` | `config.toml` 有文本级段合并的写入纪律，topic 是动态增长的高频写入，频繁插入会破坏用户手写内容 |
| 页面支持编辑正文 | 会绕过 `redactSecrets` 与 evidence 校验，破坏写入路径的唯一性 |
| 静态 HTML 文件放 `src/web/*.html` | `tsc` 不复制非 TS 文件，`dist/` 里会缺失 |
| 只在 `commitEntry` 归一化 domain | `updateEntry` 也走 `entryPath`，外部编辑的脏 domain 仍会让文件移出仓库；归一化必须下沉到 `entryPath` 才覆盖全部写入路径 |
| 给 `applyAssent` 加 `refreshIndex` 等于承认逐条调用 | 更好的做法是**按 action 聚合**后再一次性传入；`opts` 只是兜住 `applyReviewDecisions` 末尾统一重建的那一次 |

---

## 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1 | 2026-10-27 | 初稿 |
| v2 | 2026-10-27 | 按外部审查意见修订。**事实纠正 4 处**：`applyAssent` 本身是批量接口且只重建一次热层（原写「逐条重建」有误）；`--supersedes` 实际支持逗号列表、单值限制在 `--confirm`（原表述反了）；§4.1 时序自相矛盾（服务须先 listen 才有端口）；`assent` 的 confidence 是 `max` 只升不降（原写固定 0.8）。**边界收紧 3 处**：detail 端点补 token 校验 + id 白名单；Host 放行 `localhost`；`normalizeDomain` 下沉到 `entryPath`。**清单补漏 2 处**：`AGENTS.md` Modules 表登记 `src/web/`；`ARCHITECTURE.md` 从「可选」改为「必须」。**顺带发现 1 处**：手册 §0 铁律 1 与 `reconfirm()` 实现矛盾。**新增用例 3 个**：detail 无 token、0.9 条目 assent 保持 0.9、批量 confirm + supersedes 报错。**参数确认**：§10 三项由「待定」转为「已定」。 |
