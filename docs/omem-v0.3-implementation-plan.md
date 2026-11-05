# omem v0.3 工程决策与实施计划

> **状态**：决策已定，待实施｜**基准**：HEAD `41232e8`（2026-11-03，148 commits，`0.2.0-beta.1`）
> **性质**：本文是**工程决策记录**，不是设计提案。v0.3 的一切实现以本文 + `AGENTS.md` + `docs/omem-重构方案-路B.md` §14 为准。
> **来源**：`docs/omem-0.3.md`（2026-11-05 架构评审，属**历史评审**，其对字段与实现的建议不得直接执行）+ 同日本地代码层逐行审计。
> **事实优先级**：源码 > `AGENTS.md` / 路B §14（决策记录）> `README.md` / `ARCHITECTURE.md`（对外文档）。三者冲突时以后者向前者对齐，不得反向修改源码去迁就过时文案。

---

## 0. 本文的使用方式（给后续 Agent）

1. **开工前必读**：本文 §1.3「不可绕过的约束」+ `AGENTS.md` §Non-negotiables。上一轮评审的教训是「把架构层面的合理性直接推导成字段级改造建议」，本文正是为了阻止这种推导复发——任何新提议必须先对照 §1.3 逐条核对，再对照 §2 决策记录确认是否已被否决。
2. **保留证据**：本文刻意保留源码路径 + 行号 + 测试文件名 + 不变量条目号。行号会随提交漂移，但**符号名、测试名、不变量编号**是稳定锚点；核对时以符号名 grep 为准，不要只认行号。
3. **不为了修复一个真实问题，引入一个比原问题更复杂的新系统**。这是 v0.3 的第一约束，也是 §2 全部决策的共同依据。
4. **`docs/omem-0.3.md` 的定位**：它正确判断了架构方向（不推翻 v0.2、生命周期归 omem / 语义归 Agent、不做自动遗忘、不引入向量库），但其 P0 中「证据语义筛选」「`reviewed_revision`」「正文 SHA-256 当 revision」「三种写入意图」四类建议已被本审计否决或重设计。**不要把它当现行实施方案**。

---

## 0.1 实施进度（滚动更新）

| 阶段 | 状态 | 提交 | 测试证据 |
| --- | --- | --- | --- |
| S0 决策对齐 | ✅ 2026-11-05 | `a7f87bb` | 仅 `.md` 变更（6 files / +1334 −5）；`npm test` 70 文件 / 712 用例绿 |
| S1 数据安全与生命周期 | ✅ 2026-11-05 | `352d1d2` / `75bc459` / `c0eaacc` | 三子任务各自单独提交；新增 `exclude-paths.test.ts`(8) / `redact --topic`(4) / `reactivation.test.ts`(10)；收口 `npm test` 72 files / 738 tests 绿、`smoke` 80/0 绿、T08 后 payload 10560/12300 |
| S2 写入差异预览 | ✅ 2026-11-05 | 待回填 | 新增 `write-diff.test.ts`(8)；`npm test` 73 files / 746 tests 绿、`smoke` 80/0 绿、payload 10929/12300 |
| S3 检索结构化证据返回 | 🔄 进行中 | — | — |
| S4 expected_revision (best-effort) | ⬜ | — | — |
| S5 回归测试与评估 | ⬜ | — | — |
| S6 证据与评分模型重构 | ⬜ 门槛待判 | — | — |

> 每个阶段完成后回填提交哈希与实际测试输出，遵循 §3.0 Definition of Done。

---

# 第一部分　已确认事实

## 1.1 已实现能力（**不得再列为待办**）

| 能力 | 源码位置（符号名优先） | 钉住的测试 |
| --- | --- | --- |
| topic 即身份，`knowledge/<domain>/<topic>.md`，一主题一活文档 | `AGENTS.md:59`；`core/entry.ts` `normalizeTopic` / `parseEntry` | `topic-normalize.test.ts`、`store-lookup.test.ts` |
| 无索引数据库，内存派生视图，线性扫描 + 确定性排序 | `core/search.ts` `rank` / `searchEntriesPage`；`core/index.ts` `rows()` | `index.test.ts`、`golden-search.test.ts` |
| Markdown 事实源；外部编辑由 `(size, mtime)` + 全文 hash 吸收 | `core/index.ts` `catchUp`；`AGENTS.md:15` | `index.test.ts:106-129` |
| 两把 hash 用途隔离：`index.hash`（全文 sha256/32）、`body_hash`（归一化正文 sha256/16，仅去重） | `core/index.ts`；`core/util.ts` `contentHash`；`AGENTS.md:16` | `index.test.ts:93` |
| 覆盖前写前快照（滚动 7 份） | `core/commit.ts:515-520` `runSnapshot`；`core/snapshot.ts` | `snapshot.test.ts` |
| 默认自动提交 `auto_commit = "session"`，一次调用一笔本地 commit | `core/config.ts`；`core/commit.ts` `autoCommit`；`mcp/tools.ts:824-838`；`process/pipeline.ts:268-275` | `auto-commit.test.ts:63-162` |
| 去重命中只升不降（同 topic + 至少一条 evidence + `confirmations===0` + 严格更高分） | `core/commit.ts` `rescoreOnDedup` / `CommitResult.rescored`；`AGENTS.md:17` | `dedup-rescore.test.ts` |
| 无 `verified` 标志；confidence 是唯一信任数字；五档阶梯 | `process/score.ts:10-16`；`core/lifecycle.ts` `REVIEW_CAP=0.9`；`AGENTS.md:18` | `score-ladder.test.ts` |
| 印证按独立来源计数（同一段 `## user` 文本算一份，引用会话自身不算） | `collect/session-store.ts` `evidenceUserKey`；`process/score.ts` `buildSourceSkip` / `corroborationFromIndex`；`AGENTS.md:22/23` | `score-ladder.test.ts` |
| `omem verify` 只报告不改写，账本区间 `[min,max]` | `process/score.ts` `verifyConfidence`；`commands/verify.ts`；`AGENTS.md:24` | `verify-confidence.test.ts` |
| 活文档更新继承 trail（`created` / `source_sessions` / `evidence` / `confirmations` / `last_confirmed`），不继承 score | `core/commit.ts` `collectSourceSessions` / `newFrontmatter`；`core/entry.ts` `mergeEvidence`；`AGENTS.md:20` | `evidence-merge.test.ts`、`source-sessions-cap.test.ts`、`commit.test.ts:123` |
| 写入前脱敏（7 条凭证正则），采集与写入两条路径都过 | `core/redact.ts` `redactSecrets`；`core/commit.ts:378`；`collect/session-store.ts:97-102`；`AGENTS.md:19` | `rules.test.ts`、`evidence-text.test.ts` |
| work profile 默认阻断同步与导出 | `core/profile.ts`；`core/commit.ts:385-390`；`commands/sync.ts:88,98`；`AGENTS.md:29` | `profile.test.ts` |
| MCP 默认仅 `search_memory` / `save_memory`；`memory_feedback` 需 opt-in | `mcp/tools.ts` `buildTools`；`mcp/server.ts`；`AGENTS.md:30` | `mcp-tools.test.ts:34-41`、`tool-budget.test.ts` |
| `initialize.instructions` 与 `save_memory` 描述是同一份契约 | `context/instructions.ts` `mcpInstructions` / `RULE_EVIDENCE` / `RULE_CONFIDENCE`；`mcp/server.ts:54`；`AGENTS.md:26` | `context-export.test.ts`、`mcp-tools.test.ts` |
| 回执 caller-aware；`metadataDrift` 只在 `commit.ts` 算一次 | `core/commit.ts` `metadataDrift` / `vcsNotice` / `overCapNotice`；`AGENTS.md:27` | `mcp-tools.test.ts`、`commit.test.ts` |
| topic 近重复仅在新建时提示，**warnings 永不作为拒绝** | `core/commit.ts:467-475`；`core/entry.ts` `isNearDupTopic`；`AGENTS.md:28` | `pipeline.test.ts`、`mcp-tools.test.ts` |
| 三态生命周期：人工触发 `active→stale`（只标记）、`active→archived`（可逆）、`redact` 硬删 | `core/lifecycle.ts` `gcScan` / `reconfirm`；`core/store.ts` `moveToArchive`；`commands/review.ts`；`AGENTS.md:13` | `lifecycle.test.ts`、`review-decisions.test.ts` |
| `redact --source` 批量默认 dry-run + `--yes` 才删，并告知 git 历史可追溯 | `commands/redact.ts:19-48,77-90` | `redact.test.ts:42-103` |
| 同步冲突只报告：远端另存 `.conflict.md`，本地保留，遍历跳过 | `sync/git.ts:174-204`；`core/store.ts:70`；`AGENTS.md:14` | `sync-git.test.ts`、`sync-command.test.ts` |
| `dry_run` 预演（不落盘、不索引、不提交） | `mcp/tools.ts:200,242,651,771` | `auto-commit.test.ts:100-105` |
| 检索：topic 精确、domain/status/project 过滤、scope 分域、top_k、confidence 排序、text 层摘要与时间、零结果诊断 | `core/search.ts:52-105`；`mcp/tools.ts:83-124`；`core/search-format.ts` | `topic-filter.test.ts`、`session-search.test.ts`、`search-command.test.ts`、`golden-search.test.ts` |
| save 回执：`status` / `updated` / `rescored` / `anchors` / `metadata_drift` / `vcs` / `warnings` | `mcp/tools.ts:646-842` | `mcp-tools.test.ts`、`save-feedback.test.ts` |
| Golden 检索基线（6 条语料 + 8 个 `query→expected_topics` 断言） | `tests/unit/golden-search.test.ts:38-107` | 自身 |
| 工具面体积守门（12,300 字符双断言） | `tests/unit/tool-budget.test.ts` | 自身 |
| 文档一致性守门（依赖、采集器清单） | `tests/unit/docs-consistency.test.ts` | 自身 |
| 外部编辑后索引增量重建、新进程全量重建 | `core/index.ts:204-224`；`mcp/server.ts` `prepareToolCall` | `index.test.ts:106-129`、`mcp-tools.test.ts:431` |

**结论**：上一轮评审的 P1「改进 `search_memory` 返回结构」中，Topic 精确、Domain/Status 过滤、置信度排序、Top-K、memory/session 分域、摘要（text 层）、零结果诊断**均已实现**；P2 的 Golden Dataset **已以测试内基线形式存在**；P0 的「返回是否新建/更新/重复」「写前快照」「MCP 工具面收敛」**均已实现**。将它们列为待办会造成重复开发。

## 1.2 已确认存在的问题

| 编号 | 问题 | 源码证据 | 判定 |
| --- | --- | --- | --- |
| F1 | **归档 / stale topic 被写入后静默复活** | `core/commit.ts:461` `findByTopic(..., {includeArchived:true})`、`:497` `status:'active'`、`:525` 删旧路径搬回 `knowledge/` | 真实，生命周期正确性缺口，**提至 S1** |
| F2 | **`exclude_paths` 定义了却未接线** | `core/config.ts:26,71,389,447` 有定义/解析/序列化；`collect/collector.ts:42-110` 与各 `list()` 完全不读；仅 `config.test.ts` 有 TOML 往返测试 | 真实，隐私边界失效，**提至 S1 最高优先** |
| F3 | **`redact --topic` 无 dry-run、无 `--yes`、无测试，直接硬删** | `commands/redact.ts:58-66`；`redact.test.ts` 仅覆盖 `--source` | 真实，违反「不拥有任意处置权」，**提至 S1** |
| F4 | **单一 `evidence` 字段同时承担历史追溯与当前内容背书** | `core/commit.ts:508` `mergeEvidence` 只做集合并集；`process/score.ts` `scoreEvidence` **函数体内不读 `content`**，连本次引文是否支持正文都不校验；`:331` `verifyConfidence` 用继承后的 `fm.evidence` 复算印证 | 真实，且比上一轮评审所见的「旧证据继承污染」多两层：本次证据也可能与正文无关、账本复算把历史线索当新增印证 |
| F5 | **无 revision / 无 CAS / 无并发保护** | 全 `src/` 对 `revision`、`expected_revision`、`reviewed_revision` 零命中；`core/commit.ts:461→522` 读旧文件与写新文件之间无版本比对、无锁 | 真实，Lost Update 窗口存在 |
| F6 | **`ARCHITECTURE.md` 单侧过时 + 状态图不成立 + 回执文案错误** | `ARCHITECTURE.md:169`「写入不自动 commit」与 `README.md:99/244`、源码、`auto-commit.test.ts` 相反；`:180` 状态图 `stale→active: review --confirm` 与 `core/lifecycle.ts:215-217`（非 active 直接 skip）相反；`commands/review.ts:63,187` 提示语同样错误；`mcp/tools.ts:165,602` 把 `rank` 描述成 bm25，实际 `search.ts:104` 是 `rank: -hits` | 真实，会误导后续 Agent |
| F7 | **`confidence` 在 MCP 返回体中是裸数值，无任何说明** | `mcp/tools.ts:162,252` 仅 `{type:'number'}`；语义说明只在 `initialize.instructions` 与工具描述里 | 真实但低风险。注意：`README` / `ARCHITECTURE` **从未**把 confidence 宣传为「事实正确概率」，上一轮评审这半条是过时指责 |
| F8 | **`PROCESS.md` 是派生视图，不可手放规则** | `process/guide.ts:374` `atomicWrite(path, text)` 全量重写；`core/commit.ts:530` 每次写入后 `refreshGuide` 重算 | 设计约束。上一轮「把写入原则放进 PROCESS.md」不可行，除非改生成器注入固定头部 |
| F9 | **写入原则未进 instructions，且受 2KB 预算约束** | `context/instructions.ts:19` 注释「长度控制在 2KB 以内：部分客户端会截断或拒收」；现有 Hard rules / Grounding / Correction channel 三条，无「事实/偏好/计划/推断区分」「计划不得写成事实」等原则 | 真实但受预算与 `AGENTS.md:26` 双向约束 |
| F10 | **测试缺口** | `tests/unit` 无多进程并发写入测试、无证据污染防护测试、无 `redact --topic` 测试；`golden-search.test.ts:83-85` 自述「B 落地后应新增一条明确的排序断言」至今未加；`tests/integration` 目录不存在；`vitest.config.ts:11` 只 include `tests/unit/**/*.test.ts` | 真实 |
| F11 | **API 档已经是与 Agent 档并行的第二套 pipeline** | `process/score.ts:16,282` `SCORE_API_CAP=0.75`；`process/queue.ts` 独立重跑；`AGENTS.md:46` `tier: agent | api` | 现状记录：上一轮把它当「未来风险」，实际分叉已存在。v0.3 不处理，但不得再声称「只有一套 Extraction」 |
| F12 | **工具面体积已逼近硬门槛** | `tool-budget.test.ts` 全量 payload ≤ 12,300；其注释显示 beta.10 已预定 `topic_list`(+700) 与 `pending_memory`(+900)，需先做 T08 把描述改为引用 `RULE_` 常量再压约 1,400 字符 | 硬约束：S1/S3/S4 都要动 schema，必须统一规划预算 |

## 1.3 不可绕过的约束（`AGENTS.md` §Non-negotiables 索引）

| 条目 | 内容摘要 | 对 v0.3 的约束 |
| --- | --- | --- |
| `:13` | 永不自动删除；`review --gc` 只标 stale；硬删只有 `redact` | S1 的 redact 护栏必须更严，不能更松 |
| `:14` | 冲突只报告；远端存 `.conflict.md`；「conflict」一词已被 git sync 占用 | S4 的 `stale-revision` 必须用新术语，不得叫 conflict |
| `:15` | Markdown 事实源；store 不缓存；每次读盘；`(size,mtime)` + 全文 hash 检测外部编辑 | S4 写前二次读盘与此模型一致；不得引入缓存版本号 |
| `:16` | 两把 hash 用途隔离；`index.hash` 是**唯一允许的 revision 基线**，`body_hash` 只做去重，禁止第三把 hash（S0 已按 D3 修订措辞） | S4 必须复用 `index.hash`，不得把 `body_hash` 当版本 |
| `:17` | 去重命中只升不降，四条件；降低是人的决定 | D1 改证据口径、D2 若改确认语义都会撞这条；D2 已决定暂缓 |
| `:18` | 无 `verified`；confidence 是唯一信任数字；禁止新增信任标记 | D2 暂缓的直接依据 |
| `:19` | 写入前脱敏；`exclude_keywords` 已废 | S1 接线 `exclude_paths` 时不得复活 `exclude_keywords` |
| `:20` | 活文档更新继承 trail 不继承 score；继承只发生在 `collectSourceSessions` / `mergeEvidence`，禁止别处重读旧文件 | **D1 的直接约束**：历史链完整继承不得改，只能在写入侧新增「当前版本证据」层 |
| `:21` | 无 topic 级策略文件；不得新增第二条策略通道 | 任何「版本级审阅策略」不得落进 `config.toml` |
| `:22/:23` | 印证不计自身来源；按独立来源（证据域用户文本）计数 | D1 的 `verifyConfidence` 改造必须保持这两条 |
| `:24` | `omem verify` 只报告不改写；区间 `[min,max]` | D1 不得把 verify 改成修订器 |
| `:25` | 无全文索引，线性扫描，排序是普通函数 | S3 不得改排序算法 |
| `:26` | instructions 与 `save_memory` 描述是一份契约 | S1/S4 新增参数与回执必须两处同步 |
| `:27` | 回执 caller-aware；`metadataDrift` 只在 `commit.ts` 算一次；MCP 不得出现 `--` 形式 | S2/S4 所有新回执照此办理 |
| `:28` | topic warnings 只在 `commitEntry` 决定，**永不作为拒绝** | S1 的 `needs-reactivation`、S4 的 `stale-revision` 必须走 `CommitStatus`，不得塞进 `warnings` |
| `:29` | work profile 默认阻断同步与导出 | S1 的采集接线不得绕过 |
| `:30` | MCP stdout 只走协议；默认 2 工具；**不扩默认工具面** | 所有新能力只能加参数/字段，不能加工具 |
| `:70/:72` | 不重新引入 `node:sqlite` 或原生模块（zstd 是唯一例外） | D3 明确不做文件锁，也含「不引入锁依赖」 |
| `:77` | 所有用户可见文案英文，docs/README 中文 | 所有新回执文案英文 |
| `:78` | 持久化写走 `atomicWrite`（temp + rename），CLI/MCP 同步 IO | S4 的比对必须发生在 `atomicWrite` 之前 |
| `:94/:98` | 测试 hermetic：`makeHome()` / `cleanupHome()`；采集器隔离由 registry 单点推导 | S1 的 `exclude_paths` 测试必须沙盒 `OMEM_*_PROJECTS` |
| `:55` | frontmatter 是扁平 YAML 子集；字段顺序由 `core/entry.ts` `FM_ORDER` 定义；`config.toml` 只允许 omem 自写文件的无损往返 | D1 新增字段必须登记 `FM_ORDER` 并做旧库兼容读取；配置改动必须文本级段合并，禁止 parse→serialize 全量往返 |

**补充工程约定（非 `AGENTS.md` 明文，但为既有实践）**：`config.toml` 写入一律文本级段合并；写命令测试须 `openCtx()` + `try/finally index.close()`；任何不可逆批量写先 dry-run + 显式确认；`PROCESS.md` 是派生视图，不得作为规则或状态的存储位置。

## 1.4 高频文件速查

`core/commit.ts`（写入主链、回执计算）｜`core/entry.ts`（frontmatter、`FM_ORDER`、`mergeEvidence`、`isNearDupTopic`）｜`core/index.ts`（派生索引、两把 hash、`catchUp`）｜`core/search.ts`（确定性检索）｜`core/lifecycle.ts`（状态迁移、`REVIEW_CAP`）｜`process/score.ts`（评分阶梯、`verifyConfidence`）｜`mcp/tools.ts`（工具 schema、回执渲染）｜`context/instructions.ts`（Agent 指令契约）｜`commands/redact.ts` / `collect/collector.ts` / `process/guide.ts`（S1 主战场）｜`tests/unit/tool-budget.test.ts` / `docs-consistency.test.ts`（守门）。

---

# 第二部分　决策记录

## D1　证据分层，但不做语义级证据裁决　【采纳，须先过 S0】

**结论**
- 区分「历史证据链」与「当前版本证据」两个概念，**不再让一个 `evidence` 字段同时承担历史追溯与当前内容背书两种职责**。
- **保留历史证据链的完整继承**：`mergeEvidence` 的集合并集语义不改，`collectSourceSessions` 不改，满足 `AGENTS.md:20` 的 trail 不变量。
- **新增「当前版本证据」层**：记录本次写入明确提交的引文。`scoreEvidence` 与 `verifyConfidence` 只用这一层计分 / 复算账本；历史线索不产生当前版本的新增印证。
- **不声称历史证据都能证明当前正文**；**omem 不判断旧证据是否仍支持新正文**——语义判断归 Agent，这条与产品第一原则一致。
- 历史证据继续由 Git 历史与原始 `sessions/` 保存。

**理由**：F4 的根因是职责重叠，不是继承动作本身。做语义相关性筛选会把语义判断重新塞回 omem，并同时违反 `AGENTS.md:20`、`:22/:23`、`:24`。分层是唯一不破坏现有体系的解法。

**代价（必须一并处理）**：新增 frontmatter 字段 → `core/entry.ts` `FM_ORDER` 登记、扁平 YAML 子集、旧库兼容读取（`normalizeFm`）；`dedup-rescore` 的「至少一条 evidence」门槛（`AGENTS.md:17`）需明确指向当前版本证据；`verifyConfidence` 的 `[min,max]` 区间（`AGENTS.md:24`）口径需重新说明；`docs/omem-重构方案-路B.md` §14 追加一行。

**前置条件**：**S0 决策记录完成前不得修改 `mergeEvidence`**。

**明确不做**：Claim 级知识图谱、语义相关性裁决、机器自动降分、把 `omem verify` 改成修订器、第二套策略通道。

## D2　`reviewed_revision` 暂缓，不进入 v0.3　【采纳】

**结论**：保留主题级 `confirmations` / `last_confirmed` 及其无条件继承（`core/commit.ts:504-506`），**不新增 `reviewed_revision`**，不改信任模型。

**理由**：`confirmations` 已参与评分与去重机制，绑定正文版本会连锁触发「正文变化→计数归零→`dedup-rescore` 重新进入确认门槛→Agent 重复提交相同内容即可影响评分→人工介入陷入不断重新确认的循环」。更根本的是：**人工看过一个 Topic，不等于人工逐字确认了每次正文变化**。现有 `commit.ts:504-505` 的注释已给出这一取舍的理由。版本级审核若要做，应作为一次**独立的信任模型重构**（v0.4+），并与其他评分机制一并重设计，而不是 v0.3 的顺手优化。

**补偿动作（写入 S0）**：文档必须明确澄清语义——「人工确认表示这个主题曾经获得过人工关注，不表示当前正文已被人工逐项验证」。涉及 `README.md`、`ARCHITECTURE.md:185`、`context/instructions.ts` `RULE_CONFIDENCE`，三处口径一致。**只改文案，不改源码行为**。

**保持原样的不变量**：`AGENTS.md:18`（唯一信任数字、禁止新增信任标记）、`:20`（counters 继承）、`:17`（去重门槛）。

## D3　CAS 做 best-effort，锁机制延后　【采纳】

**结论**：v0.3 只实现以下五步，不提供强一致保证。
1. `search_memory` 返回全文 `index.hash`（`sha256hex(fileText).slice(0,32)`，`core/index.ts:119`）。
2. `save_memory` 接收 `expected_revision`。
3. 写入前重新读取磁盘上的全文并比对。
4. 不一致时返回明确的 `stale-revision`。
5. **不写入、不提交 Git、不混入 `warnings`**（`AGENTS.md:28`），按 caller 渲染（`AGENTS.md:27`），MCP 回执不得出现 `--` 形式。

**revision 口径**：**复用 `index.hash`，不新造第三把 hash**。需先在 S0 把 `AGENTS.md:16` 的措辞修订为「两把 hash 用途不混用：`index.hash` 承担外部编辑检测并同时作为 revision 基线，`body_hash` 只做去重」。不得复用 `body_hash`——它是归一化正文哈希，大小写与标点变化不敏感，当版本号不安全。

**保证边界（必须写进 README / ARCHITECTURE）**：二次比对**只能降低** Lost Update 风险，读-比-写之间仍存在 TOCTOU 窗口；`atomicWrite` 只保证单次写原子，不保证跨进程串行化。**验收标准不得写成「两进程交错写入绝不丢失更新」**——那需要锁或其他原子协调机制。

**延后理由**：omem 是本地工具而非高并发服务。跨进程锁需处理进程异常退出后的 stale lock、锁超时与持有者识别、Windows/macOS/Linux 文件系统差异、外部编辑器与 Git 操作并发，工程成本高于 v0.3 的收益。

**明确不做**：文件锁、stale-lock 恢复、锁持有者识别、跨平台锁语义、git 层面原子化、任何强一致承诺。

## D4　归档复活显式化　【新增决策，进入 S1】

**结论**：**不禁止向 archived/stale topic 写入，但禁止静默复活**。用户的归档是明确处置行为，Agent 因检索到旧会话而回写同一 topic，不得自动撤销它。

- 目标 topic 为 `archived` 或 `stale` 时，回执必须显式暴露「原状态 → 本次写入将恢复为 active」以及路径迁移（`archive/` → `knowledge/`，`commit.ts:525` 会删旧文件）。
- **是否恢复由明确的写入意图决定，而不是静默发生**：新增显式布尔入参（建议名 `reactivate`）；未提供时返回新 `CommitStatus`（建议 `needs-reactivation`），不落盘、不提交；`dry_run` 预演同样给出该提示，形成「预演 → 显式带参重写」闭环。
- Agent 必须在回执里明确知道这一状态变化，再决定是否继续。

**约束**：走 `CommitStatus` 而非 `warnings`（`AGENTS.md:28`）；只加参数不加工具（`AGENTS.md:30`）；入参描述计入 `tool-budget` 预算；回执 caller-aware（`:27`）；文案英文（`:77`）。参数名与 status 值属接口细节，在 S1 任务卡内定案，不改变本决策语义。

**附带修复**：`commands/review.ts:63,187` 中「restore one with `omem review --confirm`」的提示与 `lifecycle.ts:215-217` 不符，一并改为符合代码的说明；`ARCHITECTURE.md:180` 状态图中 `stale → active: review --confirm` 删除或改写。

## D5　优先级结构与 S6 可延后　【采纳】

不照搬原 S0–S6 顺序，调整为下表。**S6 不强制在 v0.3 完成**：若证据与确认机制牵动现有评分体系、历史数据兼容与大量测试，宁可先把边界记录清楚，不为版本号仓促重构。S6 合入 v0.3 的门槛是：不改变 `score-ladder.test.ts` 五档与 `dedup-rescore.test.ts` 四条边界；否则立即移出，推迟 v0.4。

| 优先级 | 工作 | 判断 |
| --- | --- | --- |
| S0 | 证据、确认机制的决策对齐 | 决策记录（本文）已产出；S0 为同步到项目规范，**必须先行、不改源码** |
| S1 | `exclude_paths`、redact 安全、归档复活 | 先修复数据安全与生命周期缺口；**优先于检索增强** |
| S2 | 写入差异预览 | 利用现有 `dry_run`，低风险 |
| S3 | 检索结构化证据返回 | 先解决工具预算，再增加字段 |
| S4 | `expected_revision` | 先 best-effort，不承诺强一致 |
| S5 | 回归测试与评估 | 补齐并发、证据、删除、归档用例 |
| S6 | 证据与评分模型重构 | 单独决策，必要时推迟 v0.4 |

## D6　Non-goals（v0.3 明确不做）

1. 不引入向量数据库、Embedding、Reranker、知识图谱、SQLite / `node:sqlite`、常驻服务、独立 AI Agent、云端账号与多租户。
2. 不实现自动遗忘、时间衰减、按访问次数遗忘、自动合并引擎、自动裁决事实冲突。
3. 不追求兼容所有 Memory Framework API；不追赶 mem0 / OpenViking 的功能数量。
4. **不做文件锁与强一致 CAS**（D3）。
5. **不做 `reviewed_revision` 与版本级审核**（D2）。
6. **不做语义级证据裁决、Claim 级图谱、机器自动降分**（D1）。
7. **不做 Git 历史清理、Topic 级备份排除**（`git add -A` 全量提交 + git 是唯一版本链，排除即失去版本保护；已在历史中的还需改写历史并强推远端，与 `AGENTS.md:14` 相悖）。二者只做**范围告知**。
8. 不扩 MCP 默认工具面（`AGENTS.md:30`）；不恢复已删的 `eval` / `api` / `audit` / `context` 命令。
9. 不把写入规则写进 `PROCESS.md`（派生视图，F8）；不新增第二条策略通道（`AGENTS.md:21`）。
10. 不新增「三种写入意图」参数：上一轮评审的 `append` 与「`content` 是完整正文、同 topic 整篇覆盖」不兼容——若 omem 拼接片段就开始管理正文语义，若 Agent 自行拼好再 replace 则无需该参数，属职责重叠。

## D7　产品定位与判断标准　【采纳，作为后续评审第一条判据】

omem 已不是 Markdown 文件管理工具，而是一套分层机制：**原始会话是证据来源；Agent 负责理解与提炼；Topic 是组织单位；Markdown 是事实存储；Git 是历史版本链；Index 是可重建检索结构；MCP 是 Agent 使用记忆的接口；Lifecycle 是 omem 管理记忆状态的边界**。

最有价值的不是检索算法，而是**所有权、解释权、处置权没有全部交给 AI**。产品承诺：

> AI 可以读取、引用和更新我的记忆，但我的记忆由我拥有，所有变化都能追溯，重要的处置行为必须受到约束。

**判断标准**：任何功能提议先问「它是否把记忆的所有权、解释权或处置权交给了 AI」。答案为是，则默认否决，除非有明确的人工授权通道。这比再增加一个向量检索后端更能形成产品辨识度。

---

# 第三部分　实施任务

## 3.0 实施纪律：Definition of Done（**对所有 S1–S6 生效**）

每个任务完成后，**本地 Agent 必须同时提交代码变更与对应的测试证据，不得只提交实现**。二者缺一，任务不得标记完成：

1. **变更清单**：任务编号、所依据的决策编号（D1–D7）、`git diff --stat`（核对文件范围未越界）。
2. **测试证据**：新增/修改的测试文件名与断言名；`npm test`（含通过计数）、`npm run smoke`（涉及 MCP / install / sync 时必跑）、相关专项命令的**实际输出**。
3. **回归证明**：逐条列出受影响的既有不变量对应测试仍绿（至少核对 `score-ladder` / `dedup-rescore` / `tool-budget` / `auto-commit` / `docs-consistency` 中与本任务相关者）。
4. **禁止**用「已自测」「应该没问题」等自然语言替代上述输出；禁止以 AI 对自身代码的解释作为验收依据。
5. 每个任务**单独提交**，提交信息格式 `S<n>-<id>: <动作> (D<n>)`；验收测试未绿则任务保持 `in_progress`。
6. 开工前重读本文 §1.3 与 `AGENTS.md` §Non-negotiables，确认提议未与既有体系冲突。

> 本条已于 S0（2026-11-05）提升为 `AGENTS.md` §Testing 的 **Definition of Done** 正式条款，对所有改动本仓库的 Agent 生效，不限于 v0.3 任务。

## S0　决策对齐（决策记录本文已产出；待同步到项目规范，不改源码）

| 项 | 内容 |
| --- | --- |
| **目标** | 本文的 D1–D7 决策记录已完成。S0 是把决策**同步到项目规范与对外文档**：修订被决策改变的不变量措辞、标注旧评审的历史定位、统一对外文案口径 |
| **文件范围** | `AGENTS.md`（`:16` 按 D3 修订，`:20`/`:24` 按 D1 补充说明，**不改语义**）、`docs/omem-重构方案-路B.md` §14 追加 D1 一行、`docs/omem-0.3.md` 头部标注「历史评审，非现行实施方案」、`README.md` / `ARCHITECTURE.md`（`:169` auto_commit、`:180` 状态图、`:185` 人工确认语义澄清、五档表口径） |
| **依赖** | 无（本文已完成）。S1–S6 全部 blockedBy S0 |
| **验收测试** | `git diff --stat` 确认**只有 `.md` 变更**，`src/` 与 `tests/` 零改动；人工逐条核对 D1–D7 与上表文件一一对应；`npm test` 全绿（证明文案改动未破坏现有守门）。**新增守门断言一律放到 S1，不在 S0 引入测试改动** |
| **Non-goals** | 不改任何行为代码；不实现证据分层；不加 `reviewed_revision`；不加 revision 参数 |

## S1　数据安全与生命周期缺口（**最高实现优先级**）

| 项 | 内容 |
| --- | --- |
| **目标** | S1-a `exclude_paths` 真正接线；S1-b `redact --topic` 补 dry-run / 显式确认 / 删除范围说明；S1-c 归档复活显式化（D4）；S1-d 顺带修正误导性提示文案 |
| **文件范围** | `collect/collector.ts`（及 `collect/registry.ts` 若需）、`core/config.ts`、`process/pipeline.ts`（采集入口）；`commands/redact.ts`；`core/commit.ts`（新增 `CommitStatus`）、`mcp/tools.ts`（新入参 + 回执）、`commands/add.ts`（CLI 侧）、`commands/review.ts:63,187`（提示文案）、`core/search-format.ts`（如需共用回执文案）；`README.md` / `ARCHITECTURE.md`（删除范围与 best-effort 说明） |
| **依赖** | S0 |
| **验收测试** | 新增 `tests/unit/exclude-paths.test.ts`：配置排除目录后 collector 不采集，且隔离沙盒覆盖 `OMEM_*_PROJECTS`（`AGENTS.md:98`）；`redact.test.ts` 补 `--topic` 的 dry-run / 无 `--yes` 不删 / `--yes` 才删 / 范围说明（含 git 历史与远端备份未清除的明确告知）；新增 `tests/unit/reactivation.test.ts`：archived 与 stale 两条路径，无显式意图时返回 `needs-reactivation` 且**不落盘、不提交、不进 warnings**，带 `reactivate` 后恢复 active 并提示路径迁移；`auto-commit.test.ts` 断言拒绝路径 0 提交；`docs-consistency.test.ts` 补 auto_commit 与状态图断言；`tool-budget.test.ts` 双断言仍绿 |
| **Non-goals** | 不做 Git 历史清理、不做 Topic 级备份排除（D6-7）；不禁止向归档 topic 写入；不新增 MCP 工具；不复活 `exclude_keywords`（`AGENTS.md:19`） |

## S2　写入差异预览

| 项 | 内容 |
| --- | --- |
| **目标** | 在 `commit.ts` 计算一次 `previous/incoming` 差异（仿 `metadataDrift` 的共用计算模式），`dry_run` 预演与真实写入回执都输出；让覆盖行为对 Agent 可见 |
| **文件范围** | `core/commit.ts`、`mcp/tools.ts`、`commands/add.ts`、`process/pipeline.ts`（仅渲染）、新增 `tests/unit/write-diff.test.ts` |
| **依赖** | S0、S1（回执通道稳定后） |
| **验收测试** | `write-diff.test.ts`：dry_run 不落盘 / 不索引 / 不提交（沿用 `auto-commit.test.ts:100-105` 口径）；差异文本 CLI 与 MCP 各自渲染且 MCP 不含 `--` 形式（`AGENTS.md:27`）；`deduped` / `rescored` 回执不得说 "nothing was written"（`AGENTS.md:17`）；`npm test` 全绿 |
| **Non-goals** | 不新增 MCP 工具、不做三方 diff、不自动回滚、不引入「三种写入意图」（D6-10） |

## S3　检索结构化证据返回

| 项 | 内容 |
| --- | --- |
| **目标** | **先腾工具预算**（执行 `tool-budget.test.ts` 注释中的 T08：把 `save_memory` / `search_memory` 描述改为引用 `RULE_` 常量），再给 `hits` 增加 `evidence` / `source_sessions` / `created` / `last_confirmed` / 结构化摘要；顺带修 `tools.ts:165,602` 的 bm25 文案，给 `confidence` 补 `description`（F7） |
| **文件范围** | `mcp/tools.ts`（schema + 描述压缩）、`core/entry.ts`（`readEntryFile` 取 evidence）、`core/index.ts`（`EntryRow.source_sessions` 已存在）、`core/search-format.ts`；`tests/unit/tool-budget.test.ts`、`mcp-tools.test.ts`、`golden-search.test.ts` |
| **依赖** | S0、S1（新入参预算）、S2（回执口径）；**与 S1/S4 统一规划 schema 体积** |
| **验收测试** | `tool-budget.test.ts` 两道体积断言仍绿；新增字段在 `outputSchema` 与 `structuredContent` 同步；`golden-search.test.ts` 补 evidence 回传断言与 `:83-85` 自述的排序断言；`tests/mcp-probe.mjs` 断言 stdout 无日志（`AGENTS.md:30`） |
| **Non-goals** | 不扩工具面、不做向量 / Embedding / Rerank、不改排序算法（`AGENTS.md:25`）、不改 `rank` 语义（只修文案） |

## S4　`expected_revision`（best-effort）

| 项 | 内容 |
| --- | --- |
| **目标** | 落实 D3 五步；`search_memory` 返回 `revision`；`save_memory` 接收 `expected_revision`；写前二次读盘比对；不一致返回 `stale-revision`，不写、不提交、不进 warnings；README/ARCHITECTURE 明确 best-effort 边界与 TOCTOU 残存窗口 |
| **文件范围** | `core/index.ts`（复用 `index.hash` 口径）、`core/commit.ts`（新 `CommitStatus` + 写前比对 + caller-aware notice）、`mcp/tools.ts`、`commands/add.ts`；新增 `tests/unit/revision-cas.test.ts`；`tests/unit/auto-commit.test.ts`、`mcp-tools.test.ts`、`tool-budget.test.ts` |
| **依赖** | S0（`AGENTS.md:16` 措辞修订）、S2（回执通道）、S3（search 返回结构与预算） |
| **验收测试** | `revision-cas.test.ts`：一致时正常写入；不一致时返回 `stale-revision` 且**不落盘、不提交、不出现在 `warnings`**；交错写入用例断言「检测到变化的一方被拒绝」，**禁止断言「绝不丢失更新」**；MCP 回执无 CLI 语法；`auto-commit.test.ts` 断言冲突路径 0 提交；`tool-budget.test.ts` 仍绿 |
| **Non-goals** | 文件锁、stale-lock 恢复、锁持有者识别、跨平台锁语义、强一致承诺、git 层面原子化（D3 / D6-4） |

## S5　回归测试与评估

| 项 | 内容 |
| --- | --- |
| **目标** | 抽出独立 Golden 检索标注集与离线评估脚本；补齐并发、证据、删除、归档四类用例 |
| **文件范围** | 新增 `tests/eval/golden-search.json`（`query + expected_topics`）、`scripts/eval-search.mjs`（离线、无模型）；`vitest.config.ts`（纳入新基线，不引入 `tests/eval/` 的测试发现）；`tests/unit/` 相关用例；必要时 `tests/smoke.sh` |
| **依赖** | S1–S4 |
| **验收测试** | 离线脚本**不调用任何模型 API**（`AGENTS.md:82`：无 MCP sampling、无时间衰减；`eval` 命令已由路B C-1 删除）；`npm test` 全绿、`npm run smoke` 绿、MCP probe stdout 无日志；并发 / 证据 / `redact --topic` / 归档四类用例各有明确断言名并在交付证据中列出 |
| **Non-goals** | 不恢复 `eval` 命令（路B C-1 已删）、不做模型质量评分、不引入 LLM 依赖 |

## S6　证据与评分模型重构（**可延后至 v0.4**）

| 项 | 内容 |
| --- | --- |
| **目标** | 落地 D1：`evidence` 保留为历史链（完整继承不变），新增「当前版本证据」层；`scoreEvidence` 与 `verifyConfidence` 只认当前版本证据；旧库兼容读取 |
| **文件范围** | `core/entry.ts`（`FM_ORDER` / `normalizeFm` 兼容旧库）、`core/commit.ts`（写入侧新增当前版本证据，**不改 `mergeEvidence` 的历史链语义**）、`process/score.ts`（`scoreEvidence` / `verifyConfidence`）；`score-ladder.test.ts`、`dedup-rescore.test.ts`、`verify-confidence.test.ts`、`evidence-merge.test.ts`、新增 `tests/unit/evidence-layers.test.ts` |
| **依赖** | **S0 决策 + S5 回归网**；且需单独 go/no-go 评审 |
| **验收测试** | `score-ladder.test.ts` 五档不变；`dedup-rescore.test.ts` 四条边界不变；`omem verify` 仍只报告不改写（`AGENTS.md:24`）；新增「历史线索不产生印证加成」「本次引文与正文无关时不得升分」用例；旧库 frontmatter 兼容读取用例；**若五档或四边界发生变化，立即移出 v0.3** |
| **Non-goals** | 语义级证据裁决、Claim 图谱、机器自动降分、`reviewed_revision`（D2）、第二套策略通道（D6-9） |

## 3.8 跨任务硬约束（所有任务共同遵守）

| 约束 | 来源 | 涉及任务 |
| --- | --- | --- |
| **schema 体积统一规划**：`reactivate` 入参（S1）、`hits` 字段（S3）、`expected_revision` + `revision`（S4）三处都要动 schema。先做 T08 压缩并一次性分配预算，`tool-budget.test.ts` 12,300 双断言 + beta.10 预留 +1,600 字符不得突破 | `tool-budget.test.ts`、`AGENTS.md:30` | S1 / S3 / S4 |
| **所有新拒绝类结果走 `CommitStatus`，不走 `warnings`** | `AGENTS.md:28` | S1 / S4 |
| **所有新回执在 `commit.ts` 计算一次，CLI/MCP 各自渲染；MCP 不出现 `--`** | `AGENTS.md:27` | S1 / S2 / S4 |
| **instructions 与 `save_memory` 描述同步；instructions 2KB 预算** | `AGENTS.md:26`、`instructions.ts:19` | S1 / S4 |
| **用户可见文案全英文，docs/README 中文** | `AGENTS.md:77` | 全部 |
| **持久化写走 `atomicWrite`；比对发生在写之前** | `AGENTS.md:78` | S1 / S4 |
| **frontmatter 扁平 YAML 子集 + `FM_ORDER`；`config.toml` 文本级段合并** | `AGENTS.md:55` + 既有约定 | S1 / S6 |
| **测试 hermetic：`makeHome()` / `cleanupHome()`、采集器隔离由 registry 单点推导、写命令 `try/finally index.close()`** | `AGENTS.md:94/98` + 既有约定 | S1 / S5 |
| **不扩默认工具面、不重新引入原生模块、不新增策略通道** | `AGENTS.md:30/70/21` | 全部 |

---

## 附：三个被否决的上一轮建议（供快速核对）

| 上一轮建议 | 否决依据 | 本文对应 |
| --- | --- | --- |
| 「只继承仍支持新内容的旧证据」 | 需语义判断；违反 `AGENTS.md:20`，且被 `evidence-merge.test.ts:74-88` 反向钉死 | D1 改为分层，不做裁决 |
| 「`reviewed_revision` 绑定版本」 | 与 `AGENTS.md:18/20` 冲突；连锁打开 `dedup-rescore` 门槛；人工看过主题 ≠ 逐字确认正文 | D2 暂缓 |
| 「revision = 正文 SHA-256」「create/replace/append 三意图」「写入原则放进 PROCESS.md」 | 与 `AGENTS.md:16` 两把 hash 隔离冲突；`append` 与整篇覆盖职责重叠；`PROCESS.md` 是 `atomicWrite` 全量重写的派生视图 | D3 复用 `index.hash`；D6-10 否决三意图；F8 + §1.3 |

**一句话边界**：不为了修复一个真实问题，引入一个比原问题更复杂的新系统。
