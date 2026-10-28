# omem MCP 改进建议核查与行动计划

核查对象：`outputs/omem-MCP体验实测与改进建议.md` 第 3、4 节全部条目
核查基线：仓库 `X:/omem` HEAD `848c254`（工作区干净，仅 `outputs/` 未跟踪），已安装 npm 包 `0.1.0-beta.7`
核查方式：逐条对照 `src/` 实现与 `dist/` 行为；3 组关键结论用隔离 `OMEM_HOME` 实跑复现（未读写真实 `~/.omem`）
判定口径：**属实**＝代码可证且现状如描述；**部分属实**＝核心缺陷成立但描述有偏差（附偏差说明）；**不成立**＝代码不支持

版本：v2 / 2026-10-27（v1 经外部审查后修订，采纳清单见 §6）

---

## 0. 修订记录（v1 → v2）

v1 的 32 条判定与 8 个工作包经外部审查独立复核：无一条被判「不成立」或方向性错误，两处实测声明（B5 摘要句界、A5 `LIMIT` 浮点）可独立复现。v2 采纳 10 项修订、1 项以更严格方式采纳、0 项否决。

| # | 审查意见 | 处理 |
| --- | --- | --- |
| ① | WP1 与 §5 时序矛盾（"可立即执行" vs "第一批含 WP2-4"） | 采纳。明确 **beta.8 = 纯发布 HEAD 已修内容**，WP2–WP4 顺延至 beta.9；§5 分批与 §3 依赖图统一口径 |
| ② | WP4 步骤 5 的 dedup 文案指向 `omem topic set`，MCP-only 客户端执行不了 | 采纳并加严。按 caller 分叉：MCP 版只给「改正文 + `supersedes`」，CLI 版才提 `omem topic set`；并说明"纯重写同正文仍会被 dedup 挡回"，故出路必须包含改正文 |
| ③ | WP5 缺"压低 D"方案，且误用 `omem eval` | 采纳。补齐三方案对比（抬高 B / 压低 D / 锚定增量），**推荐压低 D**（符合 `score.ts:55` 原设计意图、对既有数据只降不升）；分布统计改为一条 `GROUP BY` |
| ④ | D4「唯一 console.log 在 pipeline.ts」不准确；pipeline 属 `omem sync` 而非已移除的 `omem run` | 采纳。补 `src/web/review-server.ts:146`，并把 pipeline 的表述改为"`run` 命令已移除、该路径连 CLI 都不可达" |
| ⑤ | WP5 改动范围写 `tests/unit/*score*`，无此文件 | 采纳。改为逐一点名的实际测试文件 |
| ⑥ | WP3 步骤 4 的夹取会连带夹住 `config.search.top_k` | 采纳。夹取只作用于**显式传入值**，配置值 1-50 原样生效 |
| ⑦ | WP6 步骤 4 的 `bm25` 在 LIKE 兜底路径不存在 | 采纳。定义兜底路径不输出分数、标注 `match: substring` |
| ⑧ | WP8 步骤 3「编辑距离」属过度设计 | 采纳。只保留固定别名表 |
| ⑨ | WP8 步骤 5 的 SQL 吸收判定被低估（`source_sessions` 是 JSON 文本列） | 采纳。改用 `absorbedSessionIds()` 内存 Set，不写 SQL JOIN |
| ⑩ | WP4 步骤 1「含 `:` 取冒号后段」会误伤本身含冒号的 id | 采纳。改为 fallback 链：先原样查找，落空再剥前缀 |
| ⑪ | 审查遗留临时脚本 `outputs/_verify_limit.mjs` | 已删除 |

未采纳项：无。唯一偏离审查建议措辞的是 ②——审查建议"MCP 版只给重写 + supersedes 出路"，v2 进一步写明"必须改正文"，因为纯改写元数据时正文不变、dedup 仍会先命中（`commit.ts:116-119` 早于 `:134`），只写"重写"会让调用方再撞一次墙。

---

## 1. 核查总览

32 条（31 个问题 + 1 条正向确认 D4）中，30 条属实、2 条部分属实、0 条不成立。

| 编号 | 文档严重度 | 判定 | 核心依据（文件:行） |
| --- | --- | --- | --- |
| A1 instructions 缺失 | P0 | 属实 | `mcp/server.ts:33-36` 只声明 `capabilities`；`tools.ts:63` 引用的"omem instructions"仅在 `context/export.ts:19` |
| A2 版本无法确认 | P1 | 属实 | `server.ts:34` 硬编码 `'0.1.0'`；`cli.ts:28` 已有读 package.json 的实现可复用 |
| A3 无 tool annotations | P1 | 属实 | `tools.ts:23-27` 三字段；`server.ts:38` 原样返回 |
| A4 `required: []` 未表达两形态 | P1 | 属实 | `tools.ts:101`；空 content 由 `tools.ts:206` 运行期兜 |
| A5 `top_k` 无边界 | P1 | 属实 | `tools.ts:51` 无 min/max；`search.ts:29` 只判 `>0`（实测 3.7 报 datatype mismatch、100 原样下传） |
| A6 跨版本 evidence 语义漂移 | P1 | 属实 | beta.7 `dist/mcp/tools.js:192` 仅接受 string；HEAD `tools.ts:225-227` 已兼容数组 |
| A7 `project` 描述与实存格式不符 | P1 | 属实 | `tools.ts:49` vs `collect/claude-code.ts:40-70`（裸 12 位 hash / `local:xxxxxxxx` / `unknown`） |
| A8 `type` 无描述、非法值静默回落 | P2 | 属实 | `tools.ts:73`、`tools.ts:217-219` |
| A9 `scope=sessions` 不兑现原文 | P1 | 属实 | `tools.ts:157-165` 忽略 `detail`；`search.ts:105-129` 无 snippet、无吸收标记 |
| A10 多词匹配语义不可预测 | P2 | 属实 | `search.ts:49`、`66-94` |
| B1 零结果文案不区分过滤器 | P1 | 属实 | `tools.ts:176` 单句兜全部；`commands/search.ts:57` 多一行 Tip |
| B2 `Found N (top-N)` 恒等式 | P2 | 属实 | `tools.ts:178` 同一变量填两处 |
| B3 结果无相关度分 | P2 | 属实 | `search.ts:58` 混合排序；`EntryRow` 无分数字段 |
| B4 尾部提示与 detail 矛盾 | P2 | 属实 | `tools.ts:193` 无条件拼接 |
| B5 摘要句界切坏代码片段 | P1 | 属实（已复现） | `entry.ts:249-254`；实测输出 `"sys_service.status !"` |
| B6 标题悬挂 | P2 | 属实（已复现） | `entry.ts:242-246` + `tools.ts:127` + `lifecycle.ts:34` |
| B7 topic 不可检索 | P0 | 属实 | `index.ts:89-91` FTS 四列无 topic；`tools.ts:39-54` 无 topic 参数 |
| B8 PROCESS.md 不带 doc id | P1 | 属实 | `guide.ts:59-72`、`guide.ts:105-107` |
| C1 置信度只罚不奖且不解释 | P0 | **部分属实** | 见 §2 C1：锚定无增量成立；"完全无奖励"不成立（`score.ts:81-90` 有印证阶梯），且实测存在**激励倒挂**（D 0.65 > B 0.55） |
| C2 session_id 写法不明且最自然的猜法错 | P1 | 属实（已复现） | `session-store.ts:43-58` + `safeSeg:34-36`；带前缀 id → 实测 0.35 |
| C3 不校验 session/evidence 存在性 | P1 | 属实 | `score.ts:107-110`、`commit.ts:196`、`tools.ts:271` |
| C4 多证据无逐项归属 | P1 | 属实 | `score.ts:110` `.some()`、`score.ts:120-127` 取 max |
| C5 dedup 吞掉 topic 更新 | P0 | 属实 | `commit.ts:116-119` 早于 `resolveTopic:134` 与冲突检查 `:143` |
| C6 未知参数静默丢弃 | P2 | 属实 | `tools.ts:69-102`、`203-235` 只读已知键 |
| C7 冲突消息塞 CLI 词 | P1 | 属实 | `commit.ts:149`（含 `--force does not bypass this.`）；`CommitOpts` 无 caller 维度 |
| C8 supersedes 落空无出路 | P1 | 属实 | `commit.ts:131`；未利用 `input.topic` |
| C9 近似 topic 警告措辞诱导 | P2 | **部分属实** | `commit.ts:157-159` 已含 "If they mean the same thing"；缺反向分支 |
| C10 响应是拼接散文 | P2 | 属实 | `tools.ts:281`；`tools.ts:260` 拼出 `..`；无 structuredContent |
| D1 纠错回路无 MCP 入口 | P1 | 属实 | `tools.ts:105-118` env 门控；描述与 install 均不提示 |
| D2 CLI 独有能力形成盲区 | P1 | 属实 | `commit.ts:176-177` 直接写 CLI 命令 |
| D3 配置只在启动读一次 | P2 | 属实 | `server.ts:24` 一次 `loadConfig`，调用处理器复用闭包 |
| D4 stdout 纯净 / audit 已就绪 | — | 成立（无需改动） | `core/log.ts:6-14` 只写文件；`console.log` 仅在 `process/pipeline.ts`（`run` 已移除，不可达）与 `web/review-server.ts:146`（独立 HTTP 进程） |

---

## 2. 逐项判断依据

### A. 契约与可发现性

**A1 · 属实，且比文档描述更严重。**
`mcp/server.ts:33-36` 构造 `Server({ name:'omem', version:'0.1.0' }, { capabilities:{ tools:{} } })`，没有 `instructions` 字段——MCP 协议里 `instructions` 属于 `InitializeResult` 的独立顶层字段，不在 `capabilities` 内，所以当前客户端拿到的就是 `undefined`。
`save_memory` 描述（`tools.ts:63`）写着 "first read the PROCESS.md path from the omem instructions"。该文本真实存在：`context/export.ts:19-32` 的 `instructionsFor()` 内含 `files.processGuide(home)` 绝对路径（`core/paths.ts:29`）。
但交付通道只有两条：`omem context --for <target>`（`commands/context.ts:20`）；以及 `omem install` 选中 claude-code 时写入 `~/.claude/CLAUDE.md` 的 marker 段（`commands/install.ts:126`、`install/writer.ts:259-270`）。
**关键偏差**：那条 marker 段（`writer.ts:259-270`）**不含** PROCESS.md 绝对路径，只说 "If PROCESS.md lists groups…"。因此即便走了 install，SOP 里的"从 instructions 读路径"也不成立；只有 `omem context --for` 一条路真的给路径。不走这两条路的 MCP-only 客户端（本次实测的连接器即属此类）拿到的是一个无法满足的指涉。

**A2 · 属实。**
`server.ts:34` 的字面量 `'0.1.0'` 与 `package.json` 的 `0.1.0-beta.7` 无关，也与 `cli.ts:28` 读取的真实版本无关。`server.ts:31` 的 `mcp.start` 日志只记 catch-up 统计，没有版本、没有进程启动时间，因此"长驻进程跑的是旧 build"无法从日志归因。修造成本极低：`cli.ts:28` 的读取逻辑（`readFileSync(join(here,'..','package.json'))`）可直接抽成 `core/version.ts`。

**A3 · 属实。**
`ToolDef`（`tools.ts:23-27`）只有 `name / description / inputSchema`；`server.ts:38` 直接 `buildTools()` 返回。MCP 的 `annotations`、`title`、`outputSchema` 三个字段没有任何写入点。`search_memory` 是纯只读，确实拿不到 `readOnlyHint`。文档关于"客户端要为一次查询弹权限确认"的说法是推断，不作判定依据；事实层面（无 annotations）成立。

**A4 · 属实。**
`required: []`（`tools.ts:101`）。两种合法形态（写正文 / 只确认）在描述里只体现为 `confirm_ids` 的字段说明（`tools.ts:98`），schema 层未用 `anyOf` 表达。空 content 由 `tools.ts:206` 抛 `content must not be empty`，属运行期兜底而非契约。

**A5 · 属实，已实测。**
schema 无 `minimum/maximum`（`tools.ts:51`），服务端 `search.ts:29` 只做下界判断 `q.limit && q.limit > 0 ? q.limit : 3`。
隔离实测（`node:sqlite`，与 `core/index.ts` 同库）：`LIMIT` 绑浮点 `3.7` → `datatype mismatch`；`-1` 在原生 SQLite 中表示不限，但在工具层因 `> 0` 不成立而静默回落默认 3；`100` 原样下传，`LIMIT 100` 会把库中全部命中倒入上下文。

**A6 · 属实，但性质是"发布说明"而非代码缺陷。**
已安装包 `dist/mcp/tools.js:192`：`const evidence = typeof args.evidence === 'string' ? args.evidence : '';` —— 传数组即静默当作未提供，既不计 `ungrounded` 也不落盘，直接走 0.55 分支。
HEAD `tools.ts:225-227` 已改为 array/string 双兼容，`main` 与 `source_sessions` 同（`tools.ts:222-224`）。故本条仅剩"发布时显式点名语义漂移"的动作，随 beta.8 一并处理。

**A7 · 属实。**
描述（`tools.ts:49`）为 "normalized hash of the git remote"，真实生成逻辑在 `collect/claude-code.ts:40-70`：remote 归一化后取 `sha256[:12]`；无 remote 回退 `local:` + `sha256(cwd)[:8]`；无 cwd 为 `unknown`。qwenwork / codebuddy 复用同一函数。检索侧 `search.ts:42-45` 是精确等值 `e.project = ?`，因此"传路径必然 0 命中"是结构性的，而非概率问题。MCP 无任何列举 `project` 取值的手段（既无工具也无过滤提示），`tools.ts:176` 的零结果文案也不会提示格式问题。文档所述真实库中并存 `slug+hash` 形态，对应人工写入路径，与代码并不冲突。

**A8 · 属实。**
`type` 只有 `enum`、无 `description`（`tools.ts:73`）；非法值经 `tools.ts:217-219` 静默回落 `'fact'`，响应（`tools.ts:271`）不体现回落。

**A9 · 属实。**
sessions 分支（`tools.ts:157-165`）只读 `limit`，`detail` 在 `:154` 取出后未被该分支使用。`searchSessions`（`search.ts:105-129`）两条 SQL 都只 SELECT `session_id/path/project_fp/last_ts`，没有 `snippet()`，也没有吸收状态。吸收状态只能由 `entries.session_id` / `source_sessions` 反推（`guide.ts:257-265` 的 `absorbedSessionIds`），sessions 表本身无该列（`index.ts:96-102`）。所以"是否已吸收"需要额外查询才能给出。

**A10 · 属实。**
`search.ts:49` 判定：全部 token ≥3 字符才走 FTS 短语 AND；否则先整串 LIKE（`:69`），整串无命中且多词时退化为逐词 AND（`:86-94`）。因此 `"MCP 截断"`（含 2 字词）与 `"MCP 截断说明"` 语义分支不同。描述（`tools.ts:42`）只写 "separate multiple words with spaces for intersection"。

### B. 检索结果质量

**B1 · 属实（表述微差）。**
`tools.ts:176` 只有一句 `No memories found matching "…". Try: more specific words, at least 3 characters for Chinese, or semantically related terms.` —— `domain` / `project` 写错时输出完全相同。
CLI 侧 `commands/search.ts:57` 多一行 Tip，但那是**一行**包含两条提示（trigram ≥3 字符 + `--all`），不是"两条 Tip"；且 CLI 同样不区分"过滤器写错"。故"缺口真实、CLI 略强"成立，"两条 Tip"为表述偏差。

**B2 · 属实。** `tools.ts:178` 用 `hits.length` 同时填 `Found N` 与 `(top-N)`；无 offset，`matched` 总数不可知。

**B3 · 属实。** `search.ts:58` 排序键为 `(stale 权重) * confidence * bm25`，两种量纲相乘；`EntryRow` 不含分数字段，`tools.ts:184` 只输出 confidence/verified/source/status，调用方无法区分强命中与勉强命中。

**B4 · 属实。** `tools.ts:193` 的尾句在 `detail=true` 时仍拼上 "Full text: detail=true"，而全文已在 `:181-187` 输出。

**B5 · 属实，已复现。**
`entry.ts:249-254` 的 `/^(?:[^。！？.!?]+[。！？.!?]){1,2}/` 把拉丁 `.` `!` `?` 与 CJK 句末符等同处理。
实测（`dist/core/entry.js`）：输入 `sys_service.status != 0 有两种情况：服务未注册、或注册已过期。…` → `deriveSummary` 返回 `"sys_service.status !"`。第一句在 `status` 后的 `.` 处切断，第二句在 `!=` 的 `!` 处切断。文档结论准确。

**B6 · 属实，已复现。**
`deriveTitle`（`entry.ts:242-246`）取正文首个非空行、截 60；`tools.ts:127` 模板为 `${truncate(row.title,60)} ${formatStaleness(...)}`；`formatStaleness`（`lifecycle.ts:34`）verified 时返回 `— confirmed <rel>`。
实测标题为 `omem MCP 工具面与置信度契约：`，与分隔符 `—` 拼成「： — confirmed」，与文档所见字符串一致。

**B7 · 属实，是全清单里影响最大的一条。**
`entries_fts` 定义为 `fts5(id UNINDEXED, title, content, tags, tokenize='trigram')`（`index.ts:89-91`），`upsert` 写入时也只填这四列（`index.ts:147-150`）。`topic` 只存在于 `entries` 表（`index.ts:111`）与 frontmatter。`search_memory` schema（`tools.ts:39-54`）无 `topic` 参数。
而 `findActiveByTopic`（`index.ts:193-200`）已经存在且是 `commitEntry` 判定"一 topic 一 active"的依据（`commit.ts:143`）——即服务端完全有能力"按 topic 取 active id"，只是没暴露。零命中 + 强制 `supersedes` + 拒绝消息里才给 id，三者叠加正是文档描述的"盲写→被拒→抠 id→重写"环路。

**B8 · 属实。**
`renderExistingTopics`（`guide.ts:59-72`）每行只有 `topic / confidence / created`，无 doc id；分组的 `otherDocs`（`guide.ts:105-107`）只给数量与一句"update the one matching…"。
附带一处文档未提的问题：`guide.ts:69` 的 `…N more. Run \`omem topic list\`.` 把 CLI 命令写进了面向 Agent 的 PROCESS.md，与 C7/D2 属同类（MCP 客户端无法执行）。

### C. 写入反馈

**C1 · 部分属实。**
成立部分：`score.ts:114-116`（无证据且无引用会话）→ 0.55 + `pending-session`；`score.ts:117-129`（证据命中被引会话）→ 基准 0.55 + `corroborationBonus`，**无独立印证时 bonus 为 0**；`score.ts:144-146`（证据锚不上）→ 0.35 + `ungrounded`。响应（`tools.ts:271`）确实只报 confidence，锚定结果与 tags 都不出现。
不成立部分：**并非"完全没有奖励"**。`score.ts:81-90` 实现了分级印证加分（第 1 个印证 +0.10、第 2 个 +0.06、第 3 个起每个 +0.03、跨项目额外 +0.03，封顶 +0.25）。准确表述应是"**锚定本身无增量**，只有取得第二方独立印证才有增量"。
**核查新增发现（文档未提，且比原判断更严重）**：隔离实测五组，固定同一句 `## user` 原文与同一份会话文件：

| 用例 | 输入 | 实测结果 |
| --- | --- | --- |
| A | 无证据、无 session_id | `0.55` + `pending-session` |
| B | 证据 + 正确裸 session_id | `0.55`，tags `[]` |
| C | 证据 + `claude-code:probe-0001` | `0.35` + `ungrounded` |
| D | 证据、**不给** session_id | **`0.65`**，tags `[]` |
| E | 证据取自 `## assistant` 段 | `0.35` + `ungrounded` |

D > B：**指名正确会话反而比不指名低 0.10**。成因是 `score.ts:130-140` 的无 session 分支把"全库印证"当作加分（`corroboratingSessions` 命中自己即 +0.10），而有 session 的分支把被引会话从印证集合里剔除（`score.ts:59` skipSet）。这是激励结构上的倒挂——C1 的原始判断（"举证只可能亏"）在方向上是正确的，但根因不止"缺正向增量"，还包括两条分支的口径不一致。修复方案见 WP5。

**C2 · 属实，已复现。**
`readSessionsById`（`session-store.ts:43-58`）按 `join(root, agent, ${safeSeg(sessionId)}.md)` 精确打开；`safeSeg`（`:34-36`）把 `:` 换成 `_`。传 `claude-code:probe-0001` 时实际找的是 `claude-code_probe-0001.md`，必然落空 → `cited = []` → `score.ts:130` 的 `allSessionIds.length === 0` 不成立 → 落到 `:144` 的 else → 0.35 + `ungrounded`。实测 C 组即此结果。
连带影响文档未提：`tools.ts:238-243` 的 project 推断同样依赖 `readSessionsById`，带前缀时会一并失效，`project` 落空。
写法不一致也确实存在：PROCESS.md 输出 `` `claude-code` / `probe-fixture-0001` ``（`guide.ts:118`，agent 与 sessionId 分列两个反引号），`scope=sessions` 输出 `claude-code:probe-fixture-0001`（`search.ts:113`，`session_key` = `agent:sessionId`）。没有任何一处写明"原样传哪个"。

**C3 · 属实。**
`scoreEvidence` 只做"按 id 取文件、取不到就少一个印证源"，不区分"会话不存在"与"会话存在但没这句"。`commitEntry` 也不校验 `session_id`（`commit.ts:196` 直接写入 frontmatter）。实测用不存在的 id 与 C3 描述一致：0.35，无提示。`source_sessions` 同（`commit.ts:199`）。

**C4 · 属实。**
`citedHit` 用 `evidences.some(...)`（`score.ts:110`），印证数取各条的 `max`（`score.ts:120-127`）。因此两条 evidence 中一条真、一条假，整体仍按"锚定成功"处理，`tags` 为空。`source_sessions` 与 `evidence` 在 `commit.ts:199-200` 分别写入，无对应关系可查。文档结论成立。

**C5 · 属实。**
`commit.ts:116-119` 的 `getByBodyHash` 判重发生在 `resolveTopic`（`:134`）与 topic 冲突检查（`:143`）之前，命中即 `return finish(...)`，既不走 `writeEntry` 也不走 `upsert`，所以请求中的 `topic`/`tags`/`type` 全部丢弃。MCP 层文案 `tools.ts:263-264` 为 "Content already exists (id: …); not written again."，读起来像成功。`omem topic set` 已具备（`commands/topic.ts:39-77`，`--dry-run` 也有），只是 MCP 消息不指向它。

**C6 · 属实。**
`toolSave`（`tools.ts:203-235`）只读白名单键，无 `additionalProperties` 声明，也无未知键回收。`session_ids` 这类"看起来对"的名字会被静默忽略——且由于 `source_sessions` 缺失，`session_ids` 里给的会话不会进入 `source_sessions`，溯源静默丢失。

**C7 · 属实。**
`commit.ts:149` 的原文为 `Topic "…" already has an active document … . Pass --supersedes <id> (or supersedes: ["<id>"]) to update it. --force does not bypass this.`。MCP schema 无 `force` 参数，`--` 前缀也不是调用方语法。`CommitOpts`（`commit.ts:38-49`）没有任何标识调用方的维度，`CommitInput`（`:20-36`）也没有，因此文案无法按 caller 分叉。给对 id 这一点确实成立（消息内含 active id）。

**C8 · 属实。**
`commit.ts:130-132` 只输出 `Old entries not found: <ids>`；此处位于 `resolveTopic`（`:134`）之前，`input.topic` 未参与。`--dry-run` 走同一分支（`commit.ts:182` 在更后面），因此预演也无法提示"你要的这个 topic 当前 active 是谁"。

**C9 · 部分属实。**
`commit.ts:154-161` 的现文案已含条件句：`If they mean the same thing, write into "<near>" with supersedes instead of starting a second living document.`
所以"无条件命令改写"的描述不准确。真实缺口是**缺反向分支**（"若不属同一件事，保留新主题"），单边条件句在 LLM 侧容易被读成行动指令。识别逻辑本身合规：`isNearDupTopic` 在 `commitEntry` 内、以 `warnings` 返回而非拒绝（`commit.ts:65` 注释与 AGENTS.md 纪律一致）。

**C10 · 属实。**
`tools.ts:281` 返回 `parts.join(' ')`，全部片段空格拼成一行。dry-run 分支 `tools.ts:260` 形如 `` `[dry-run] ${status}${reason ? ': '+reason : ''}.` ``，而 excluded 的 reason 自带句点（如 `--force does not bypass this.`），拼出 `..`。`ToolDef` 无 `outputSchema`，`handleTool` 返回值无 `structuredContent`。

### D. 流程与生态

**D1 · 属实。** `tools.ts:105-118` 仅当 `OMEM_MCP_TOOLS` 含 `feedback` 时挂载；`buildTools` 两个默认工具的 description 与 `context/export.ts` 的 instructions 都不提纠错路径；`src/install/` 与 `commands/install.ts` 中无任何 `OMEM_MCP_TOOLS` 提示（grep 无命中）。

**D2 · 属实。** `commit.ts:176-177` 两条跨主题合并 warning 直接要求执行 `omem topic list --all` / `omem search --all`。MCP 侧 `search_memory` 无 `topic`、无 `status`、无 `all`（`tools.ts:39-54`），确实构成盲区。

**D3 · 属实。** `server.ts:24` 在 `startMcpServer` 内一次性 `loadConfig(home)`，`:40-44` 的 `CallTool` 处理器闭包复用该值并传入 `handleTool`；长驻进程期间改 `config.toml` 不生效。同处已有 `prepareToolCall`（`server.ts:15-21`）在做 catch-up，加入 mtime 检查的边际成本可忽略。

**D4 · 成立，无需改动（表述已按审查修正）。**
`core/log.ts:6-14` 只 `appendFileSync` 到 `logs/omem.log`。MCP 可达路径（`src/mcp`、`src/core`、`src/collect`、`src/process/guide.ts`）中无 `console.log`。仅有的两处都不在 MCP 路径上：`process/pipeline.ts`（`run` 命令已移除，见 `cli.ts:167-169` 打印 "Removed. Collect sessions with: omem sync"，该文件连 CLI 都不可达）与 `web/review-server.ts:146`（`omem review --ui` 的独立 HTTP 进程）。
`mcp.search` 带 `{query, hits, scope|detail}`（`tools.ts:159/174`），`commit` 带 `{status, id, source, redacted, reason}`（`commit.ts:257-261`），与文档描述一致。结论不受影响。

---

## 3. 下一步行动计划

范围：仅纳入 §1 判定为"属实"的 30 条与"部分属实"的可成立部分（C1 的锚定无增量 + 响应不解释 + D>B 倒挂；C9 的反向分支）。C1 中"完全没有奖励"的表述按 §2 修正后不再作为改动依据。

排序原则：① 已提交的修复先发布，避免 beta.7 与 HEAD 的对照持续失真；② 契约类改动（instructions / schema）在语义类改动之前；③ 涉及既有数据语义的评分调整单独成包、单独发版。

### 版本口径（先定这条，其余依赖它）

- **beta.8 = 纯发布 HEAD 已提交内容**（`a73f4d2` / `28f8de3` / `ad6305f` / `848c254`），不含本计划任何代码改动。WP1 独立执行、可立即进行。
- **beta.9 = WP2 + WP3 + WP4**。契约与反馈层，全部为增量改动（新增参数、新增文案、新增结构化字段），不改既有数据的评分与排序。
- **beta.10 = WP5**（唯一改变置信度语义的包，独占一个版本以便回滚）。
- **beta.11 = WP6 + WP7 + WP8**（可读性与诊断性；若进度允许可与 WP5 同版但必须分开提交）。

### 依赖关系

```
beta.8  WP1（纯发布）── 无依赖，立即执行
beta.9  WP2（instructions/描述）── 独立
        WP3（topic/status 检索）──► WP4 的 dedup/supersedes 文案要能指向 search_memory(topic=…)
        WP4（写入反馈）──► 依赖 WP3 的 topic 查询；WP4 内的 caller 分叉同时服务 C5/C7/C8
beta.10 WP5（计分校准）── 需决策；建议在 WP4 之后（先有可观测性，再改数值）
beta.11 WP6（结果可读性/结构化）── A3 与 C10 同批（都动 tools/list 表面）
        WP7（PROCESS.md）── 引用 WP3 的 topic= 取法
        WP8（诊断性/热读/杂项）── 独立
```

---

### WP1 · 发布 beta.8（P0，无代码改动）

- **问题**：A6；以及 §2 表中四项"已修待发布"（截断提示 `tools.ts:272`、evidence/source_sessions 数组化 `tools.ts:222-227`、`INSTRUCTION_TONE` 已移除、`dry_run` `tools.ts:259`）。当前 npm 上的 beta.7 仍带全部旧行为，实测对照无意义。
- **改动范围**：`package.json` version、发布说明正文、`README.md` 中版本相关表述。
- **步骤**：
  1. `npm run build && npm test` 确认 HEAD 绿；`npm run smoke` 通过。
  2. 版本号 `0.1.0-beta.8`，打 tag 后 `npm publish --tag beta --otp=<码> --registry=https://registry.npmjs.org`。
  3. 发布说明显式点名 A6 的语义漂移：`evidence` / `source_sessions` 在 beta.7 只接受 string，传数组被静默当作未提供（不惩罚、不落盘、直接 0.55）；beta.8 起接受 string | string[]。按新版写法的 Agent 在旧版上会静默丢失溯源。
  4. `npm dist-tag add @jeeinn/omem@0.1.0-beta.8 latest`（beta 期需手动；dist-tag 命令必须显式 `--registry` 且带 OTP）。
  5. 发布后核对 packument 与版本端点（约 3 分钟延迟）。
- **预期结果**：npm 最新版具备 HEAD 行为；后续 WP2–WP4 的实测有干净基线。
- **验证**：`npm view @jeeinn/omem versions` 含 beta.8；安装后 `tools/list` 的 `evidence` 类型为 array。
- **边界**：WP1 不含本计划任何代码改动。若你选择跳过 beta.8 直接等 beta.9，则 WP1 的发布说明并入 beta.9 一次发出，§5 的批次号整体前移。

---

### WP2 · 补齐 MCP `instructions` 并校准工具描述（P0，纯文案 + 一行）

- **问题**：A1（P0）、A4、A7、A8、A10、D1、A5 的描述部分。
- **改动范围**：`src/mcp/server.ts`、`src/context/export.ts`（抽出共享指令文本）、`src/mcp/tools.ts`、`README.md`。
- **步骤**：
  1. 抽出共享常量：把 `instructionsFor(home)`（`export.ts:19-32`）与 MCP 侧新增的 `instructions` 统一到一处（建议 `src/context/instructions.ts`），避免两处文案漂移。现有文本已含 PROCESS.md 绝对路径、evidence 规则、verified 纪律，按原建议文档 §4.3 补四步循环与纠错通道（顺带覆盖 D1）。
  2. `server.ts:33-36` 传入 `version: pkg.version`（与 WP8 步骤 1 合并实施更省改动）并补 `instructions`。**注意**：`instructions` 是 `InitializeResult` 顶层字段，需按 `@modelcontextprotocol/sdk@1.32` 的实际签名落位（构造函数第二参或 `connect` 前赋值），落地时以 SDK 源码为准，不臆造字段。
  3. 替换两段工具描述为原建议文档 §4.2 的文本，但**逐条对齐实现后再落地**：`content` 上限必须引用 `config.process.max_content_chars`，不可写死 2000（默认见 `config.ts:65`，可配到 100_000）。
  4. 参数 description 补齐：`project`（真实格式 + 一例 + "从结果行或 PROCESS.md 复制"）、`top_k`（"显式 1-20；省略则用配置值"）、`evidence`（每条 ≥12 连续字符、来自 `## user`、一会话一条）、`supersedes`（取法指向 `search_memory(topic=…)`）、`session_id`（"去掉 collector 前缀的裸 id"）、`type`（四类各一句"何时用"，覆盖 A8）、`query`（补短词退化为子串匹配，覆盖 A10）。
  5. `README.md` 增补 MCP 段落的 instructions 与 `top_k` 边界说明（AGENTS.md 要求行为变更同步 README，`docs-consistency.test.ts` 会检查依赖与采集器口径）。
- **预期结果**：`initialize` 返回非空 `instructions` 且含 PROCESS.md 绝对路径；`save_memory` 描述中所有指涉都可在本次会话内达成。
- **验证**：`tests/mcp-probe.mjs` 断言 `initialize.instructions` 非空且含 `PROCESS.md`；`tests/unit/mcp-tools.test.ts` 的 "description is trigger-condition style" 类断言按新文案调整。
- **风险**：低。注意 `instructions` 长度（部分客户端有上限），控制在 2KB 内。

---

### WP3 · 把 topic / status 变成一等检索维度（P0）

- **问题**：B7（P0）、D2、B1、B2、A5 的服务端部分。
- **改动范围**：`src/core/search.ts`、`src/mcp/tools.ts`、`src/commands/search.ts`、新增 `src/core/search-format.ts`（零结果文案共享）。
- **步骤**：
  1. `SearchQuery`（`search.ts:8-15`）增 `topic?: string` 与 `status?: string[]`；`buildFilters`（`:35-47`）追加 `e.topic = ?` 与 `e.status IN (...)`。**不采用"把 topic 加进 FTS 列"的方案**——`entries_fts` 是 `CREATE VIRTUAL TABLE IF NOT EXISTS`（`index.ts:89`），改列定义对既有库不生效，必须 drop + `omem rebuild`，代价是每个用户重建一次索引；而 `entries` 表已有 `topic` 列，等值过滤即可满足"topic → active id"这条主诉求。
  2. 新增"无 query 只给 topic"的路径：`toolSearch` 的 `query` 强制非空（`tools.ts:152-153`）改为 `query` 与 `topic` 至少一项；无 query 时走 `index.findActiveByTopic(topic)`（`index.ts:193-200`），并可选择性带回该 topic 的历史版本（`status` 含 `superseded`）。
  3. `searchEntries` 返回命中总数：同一 WHERE 下再跑一次 `COUNT(*)`（比去 `LIMIT` 取长度省内存）。MCP 输出改为 `matched M · showing N`（覆盖 B2），N < M 时提示"提高 top_k 或加 filters"。
  4. **`top_k` 边界**：schema 加 `minimum:1, maximum:20`（`tools.ts:51`）；服务端**只夹显式传入值**——`typeof args.top_k === 'number' ? clamp(floor(args.top_k),1,20) : ctx.config.search.top_k`。配置默认值不被夹：`config.search.top_k` 的合法区间是 1-50（`config.ts:391`），用户把它调大后、调用方不传 `top_k` 时应原样生效。非整数取整而非抛错（消除 A5 的 `datatype mismatch`）。
  5. 零结果文案共享化：抽 `formatNoHits(query, {domain, project, topic})`，CLI（`commands/search.ts:55-58`）与 MCP（`tools.ts:175-177`）共用。当 `domain`/`project`/`topic` 生效且 0 命中时，追加"过滤器可能是错的：去掉它重试，或从已有结果行/PROCESS.md 复制真实取值"（覆盖 B1）。
  6. 日志补字段：`mcp.search` 增 `topic/status`（`tools.ts:174`）。
- **预期结果**：`search_memory(topic="omem-mcp-surface")` 直接返回该 topic 的 active 文档 id；单次调用可知"总共多少 / 返回多少"；`top_k` 无法再放大上下文，且不会覆盖用户配置。
- **验证**：新增 `tests/unit/topic-filter.test.ts`（命中 active / topic 存在但已 superseded / topic 不存在 三例）；`tests/unit/mcp-tools.test.ts` 增 `top_k` 边界四例（0 / 3.7 / 20 / 100）与"配置 50 + 不传 top_k 应返回多于 20 条"一例；零结果三例（`domain` 写错、`project` 传路径、正常无命中）文案互不相同。
- **风险**：中低。`searchEntries` 返回值结构变化会影响 `commands/search.ts`、`commands/review*.ts` 等调用点，需全局搜 `searchEntries(` 逐个适配。

---

### WP4 · 写入反馈可观测化（P0）

- **问题**：C1（响应不解释部分）、C2、C3、C4、C5、C7、C8。
- **改动范围**：`src/process/score.ts`、`src/collect/session-store.ts`、`src/core/commit.ts`、`src/mcp/tools.ts`。
- **步骤**：
  1. **session_id 归一化（C2，收益最高的一处）**：采用 fallback 链而非无条件剥离——`readSessionsById` 先按原样取；取不到且字符串含 `:` 或 `/` 时，剥掉 collector 前缀（`splitSessionKey`，`session-store.ts:28-32`）/ 路径前缀后再试一次。**不能一律"取冒号后段"**：session id 本身可能含冒号，无条件剥离会把合法 id 改坏。建议把该逻辑收进 `readSessionsById` 内部（它已遍历 `sessions/` 下的 agent 目录，多试一次成本不变），这样 `score.ts` 与 `tools.ts:238-243` 的 project 推断同时受益。
  2. **存在性提示（C3）**：`scoreEvidence` 返回值增加 `sessionFound: boolean`；`tools.ts` 在 `false` 时追加 `session <id> is not in the collected set (run omem sync, or copy the id from PROCESS.md)`。明确不拒绝写入（AGENTS.md 纪律）。
  3. **逐项归属（C4）**：`ScoreResult` 增加 `anchored: { total: number; matched: { evidence: string; session: string }[] }`；`citedHit` 改为逐条判定，`tools.ts:271` 输出 `anchored 1/2: <session> ✓, <session> ✗`。归因信息同时写进 `commit` 日志（`commit.ts:214`）。
  4. **响应显式报告（C1 可观测部分）**：`tools.ts:271` 的 `Saved (...)` 拆成可读多句：`Saved … Unverified entry.` + `Grounded on 1 user quote from probe-0001.` / `Evidence did not match any ## user section; confidence 0.35, tagged ungrounded.` + `Tags: …`（被打的 tag 全部可见，不只 ungrounded）。
  5. **dedup 分支比对 topic（C5，按 caller 分叉）**：`CommitResult` 在 `deduped` 时带回既有文档的 `topic`/`type`/`tags`；`tools.ts:263-264` 比对请求值，不一致时分别输出：
     - **MCP**：`Deduped by content (id <id>). Its topic is "<existing>", you asked for "<requested>". Content-level dedup only blocks an identical body — change the body and resend with supersedes: ["<id>"] to apply the metadata.`
     - **CLI**：同上，额外补 `or run \`omem topic set <id> <topic>\``。
     说明：MCP 侧没有零摩擦通路，这是 "dedup 先于 topic 解析"（`commit.ts:116-119` vs `:134`）与"一 topic 一活文档"两条不变式共同的结果，不是文案能解决的。故 MCP 版必须点明"改正文"，否则调用方原样重发会再撞一次 dedup。
     **备选方案（不纳入本批）**：dedup 命中且仅元数据不同时改走 in-place 元数据更新（复用 `commands/topic.ts:39-77` 的实现）。风险明确：相当于给 Agent 开放"修改既有文档元数据"的能力，且必须新增"目标 topic 已被占用则拒绝"的判定，建议单独立项评估。
  6. **caller-aware 文案（C7/C8）**：`CommitInput` 增 `caller?: 'mcp' | 'cli'`（默认 `cli` 保持向后兼容），`commit.ts:149` 与 `:131` 按 caller 生成。MCP 版只保留 `supersedes: ["<id>"]` 形式，去掉 `--` 前缀与 `--force`；`tools.ts:244` 传 `caller:'mcp'`。C8 在同时给了 `topic` 时追加 `the active document for "<topic>" is <id>`——该分支位于 `resolveTopic` 之前，需把 `input.topic` 的归一提前到 `:130` 之前（纯顺序调整，不改语义）。
- **预期结果**：任何一次写入的响应都能回答"写没写、锚没锚上、哪条证据没锚上、被打什么标签、为什么被 dedup、下一步怎么走"；带前缀 `session_id` 不再静默降档；MCP 消息里不再出现无法执行的 CLI 词。
- **验证**：扩展 `tests/unit/mcp-tools.test.ts`；新增 `tests/unit/session-id-normalization.test.ts`（裸 id、`agent:id`、`slug/uuid`、id 自身含冒号、超短证据、跨段证据六例）；`tests/unit/commit.test.ts` 增 caller 分支两例（MCP 文案不含 `--`）；`tests/unit/evidence-merge.test.ts` 增逐项归属断言。
- **风险**：中。步骤 5 改的是"成功口吻"的文案，实现时以 `CommitResult.status` 为唯一真源，文案只做渲染，避免与 `commit` 日志的 `status` 口径不一致。

---

### WP5 · 计分阶梯校准（P1，需你先决策）

- **问题**：C1 的核心——锚定本身无增量，且实测存在 D(0.65) > B(0.55) 的倒挂。
- **改动范围**：`src/process/score.ts`、`docs/记忆可信度的人工核实与Agent协作手册.md`、`README.md`；测试落在 `tests/unit/session-ingest.test.ts`、`tests/unit/api-docs.test.ts`、`tests/unit/mcp-tools.test.ts` 及新增 `tests/unit/score-ladder.test.ts`（无 `*score*` 命名的既有文件，勿按通配查找）。
- **三个可选方案**：

  | 方案 | 做法 | 效果 | 代价 / 风险 |
  | --- | --- | --- | --- |
  | **A 抬高 B** | 把被引会话计回印证集合（`score.ts:59` 的 skipSet 不再排除 `session_id`） | B 0.55 → 0.65，与 D 持平 | **推翻 `score.ts:55` 注释明示的设计意图**（"跳过 source 会话避免自印证"）。等于允许"我引用的会话为我作证"，印证语义被稀释 |
  | **B 压低 D** | 无 `session_id` 分支（`score.ts:130-140`）中，第一个命中不视为独立印证，仅 count ≥ 2 时加分 | D 0.65 → 0.55，与 B 持平 | 符合原设计语义；对既有数据**只降不升**，review 队列只会变严不会漏放 |
  | **C 锚定增量** | 锚定成立时在 `SCORE_GROUNDED` 上固定 +0.10（0.55 → 0.65），与印证加分叠加后仍受 `SCORE_AUTO_CAP=0.8` 约束 | 举证有正向回报，纪律可被激励 | 改变全部既有条目的分数语义；连带影响 `autoAssent`（`commit.ts:139-141`）、`lowTrust` 阈值（`<= 0.35`）、review 队列门槛三处判定 |

- **建议**：**先做方案 B（修倒挂），方案 C 单独立项**。
  理由：倒挂是可证的实现缺陷（两条分支口径不一致），修它不需要引入新数值；方案 B 的方向是"收紧"，即使判断有偏差也不会让低质记忆被提权，而方案 A 会让自印证合法化，与"多会话互证"的初衷相反。方案 C 属产品决策，须先看分布。
- **步骤**：
  1. 落地方案 B 并补测试（断言 B ≥ D，且 D 的 tags 仍为 `[]`）。
  2. 输出既有库置信度分布：`SELECT confidence, COUNT(*) FROM entries GROUP BY confidence ORDER BY 1`（直接对 `index/omem.db` 执行；**不要用 `omem eval`**——它是抽取召回评测，见 `cli.ts:118` 的 desc）。
  3. 若采纳方案 C，先确认分布变化不会把大量条目推过 0.35 的 review 门槛；再同步更新手册与 README 的分数说明。
- **预期结果**：举证 + 指名会话不再比不指名差；是否给锚定增量由你拍板后单独实施。
- **验证**：`tests/unit/score-ladder.test.ts` 固化 §2 C1 的五组用例（A=0.55、B=D=0.55、C 归一化后=B、E=0.35）。
- **风险**：高（相对）。这是唯一改变既有数据语义的包，务必独立成提交、独立发版，便于回滚。

---

### WP6 · 结果可读性与结构化输出（P1，建议同批）

- **问题**：B5、B6、B3、B4、C10、A3。
- **改动范围**：`src/core/entry.ts`、`src/mcp/tools.ts`、`src/mcp/server.ts`。
- **步骤**：
  1. **句界修正（B5）**：`deriveSummary`（`entry.ts:249-254`）正则改为拉丁句末符须后接空白或行尾：CJK 用 `[。！？]` 即时生效，拉丁用 `[.!?](?=\s|$)`。实测用例 `sys_service.status != 0 有两种情况：…` 应返回完整两句中文。
  2. **标题（B6）**：`hitLine`（`tools.ts:122-130`）优先用 `row.topic` 作标题，无 topic 回落 `row.title`；分隔符由空格 + `—` 改为 ` · `，并在 title 以全角标点结尾时避免粘连。
  3. **尾句条件化（B4）**：`tools.ts:193` 按 `detail` 分支；非 detail 输出 `Full text: detail=true`，detail 时改为 `verified:false entries are candidates — check them against reality before acting.`
  4. **相关度（B3，保守方案）**：**不改 `ORDER BY`**（`search.ts:58` 的混合排序无评测基线，动它会整体改变现有结果）。只在 FTS 主路径（`search.ts:49-63`）回显原始 `bm25` 与 `confidence`，并给批内相对档（`strong / weak`，按批内 bm25 分位）。**兜底路径无 bm25**（LIKE 路径 `:66-94` 不参与打分）：此时只输出 `confidence` 与 `match: substring`，**不伪造分数**——调用方必须能分辨"这是子串命中，不是相关性排序"。
  5. **结构化输出（C10）**：`ToolDef` 增可选 `title` / `annotations` / `outputSchema`（`tools.ts:23-27`）；`handleTool` 返回 `{ content:[{type:'text'}], structuredContent }` 双轨——text 供人读，`structuredContent` 供程序读（`{ status, id, confidence, tags, warnings, truncated, supersedes, anchored }`）。同时修正 `tools.ts:260` 的 `..`（reason 已带句点时不再补句点）。
  6. **annotations（A3）**：`search_memory` → `readOnlyHint:true, destructiveHint:false, idempotentHint:true`；`save_memory` → `readOnlyHint:false, destructiveHint:false, idempotentHint:true`（内容级去重确实幂等），`openWorldHint:false`。
- **预期结果**：coding 域摘要不再被 `!=`/`.` 切断；结果行有可读标题；调用方能拿结构化字段而不用正则；只读查询不再被要求确认权限。
- **验证**：`tests/unit/entry.test.ts` 增 5 例句界（`!=`、`v1.2.3`、`e.g.`、行尾 `.`、中文句号）；`tests/unit/mcp-tools.test.ts` 断言 `annotations` 与 `structuredContent` 存在、`search_memory` 的 `readOnlyHint === true`、LIKE 路径不输出 `bm25`。
- **风险**：中低。`outputSchema` 与 `structuredContent` 必须由同一份对象生成，不可两处手写——不一致会导致部分客户端拒收。

---

### WP7 · PROCESS.md 与 topic 可见性（P1）

- **问题**：B8、C2 的文档侧、`guide.ts:69` 的 CLI 词（D2 同源）。
- **改动范围**：`src/process/guide.ts`。
- **步骤**：
  1. `ExistingTopic`（`guide.ts:34-38`）增 `docId: string`，`collectExistingTopics`（`:47-57`）填充；`renderExistingTopics`（`:59-72`）每行输出 `- \`topic\` <id>  0.55 · 2026-10-27`。
  2. `otherDocs`（`:105-107`）由数量改为 id 列表（`GuideTopic` 增 `otherDocIds: string[]`，`fillDocSlot:161-168` 填充）；若暂不展开，至少补一句取法 `get the active id with search_memory(topic="<name>")`（依赖 WP3）。
  3. `:69` 的 `Run \`omem topic list\`` 改为 `search_memory(topic=…) lists the rest`，或 CLI 与 MCP 两种写法并列。
  4. 文件头指令块（`:80-91`）补一句 session_id 写法：`pass the bare id from each session line as session_id — from \`claude-code\` / \`probe-fixture-0001\`, pass probe-fixture-0001`（挡住 C2 的主要失败路径，与 WP4 的归一化构成双保险）。
- **预期结果**：读完 PROCESS.md 即可拿到 supersedes 所需 id，不必先写失败一次。
- **验证**：`tests/unit/guide-docid.test.ts` 扩展为断言每行含 id；`tests/unit/guide-topics.test.ts` 断言 `otherDocIds`。
- **风险**：低。PROCESS.md 会变长，注意 `EXISTING_LIMIT = 15`（`guide.ts:32`）下每行仍在可读范围。

---

### WP8 · 可诊断性、配置热读与杂项（P2）

- **问题**：A2、D3、C6、C9、A9、A7 的服务端部分。
- **改动范围**：`src/mcp/server.ts`、`src/mcp/tools.ts`、`src/core/search.ts`、`src/core/commit.ts`。
- **步骤**：
  1. **版本注入（A2）**：抽 `src/core/version.ts`（复用 `cli.ts:28` 的读取方式），`server.ts:34` 与 `mcp.start` 日志（`:31`）都带上真实版本 + `process.pid` + 启动时间；`omem audit` 已读该 JSONL，无需改命令。与 WP2 步骤 2 合并实施。
  2. **配置热读（D3）**：`server.ts:24` 改为 `let config`，在 `CallTool` 处理器里比对 `config.toml` 的 `mtimeMs`（复用 `prepareToolCall` 的时机），变化则重新 `loadConfig`。失败时保留旧配置并 `console.error`。
  3. **未知参数提示（C6）**：不设 `additionalProperties:false`（会拒，违背 AGENTS.md）。`toolSave` 开头计算 `Object.keys(args)` 与已知键的差集，响应尾部追加 `ignored unknown args: force, status, session_ids (did you mean session_id / source_sessions?)`。建议**只用固定别名表**（十余个键，够用）：`session_ids → source_sessions|session_id`、`force → (use supersedes)`、`status → (not a save_memory field)`。不引入编辑距离，收益不抵复杂度。
  4. **近似 topic 措辞（C9）**：`commit.ts:157-159` 补反向分支：`If they are different things, keep the new topic — you can ignore this warning.`
  5. **sessions 片段（A9）**：`searchSessions` 的 FTS 分支改用 `snippet(sessions_fts, 1, '『', '』', '…', 12)`；"是否已吸收"**不要写 SQL JOIN**——`entries.source_sessions` 是 `JSON.stringify` 后的文本列（`index.ts:143`），SQL 侧判定要用 `json_each` 或 LIKE 模糊匹配，既脏又易错。直接复用 `guide.ts:257-265` 的 `absorbedSessionIds()` 得到内存 Set，对 `session_key` 同时试 `agent:id` 与裸 id 两种形式后标注「已吸收 / 未吸收」。若本轮不做 SQL 改造，则退而修改描述为"只给定位信息"，二选一，不能两头空。
  6. **project 描述（A7）**：description 给出真实格式与一例（`local:35651ad7` / `a1b2c3d4e5f6` / `unknown`），并明示"不要传路径"；零结果时（依赖 WP3 的 formatter）提示"project 需精确匹配存储指纹"。
- **预期结果**：可远程确认客户端跑的是哪个 build；改配置不必重启；臆造参数不再无声消失。
- **验证**：`tests/unit/mcp-tools.test.ts` 增未知参数与 config 热读各一例；`tests/unit/search-command.test.ts` 增 sessions snippet 一例。
- **风险**：低。config 热读后 `ctx.config` 的引用必须整体替换，不能原地 mutate（`ToolCtx` 按值传递）。

---

## 4. 不建议做的改动

| 项 | 原因 |
| --- | --- |
| 把 topic 加进 `entries_fts` 列 | 虚拟表 `CREATE ... IF NOT EXISTS` 对既有库不生效，必须 `omem rebuild`；`entries.topic` 等值过滤已能满足全部已知用例（WP3） |
| 改 `search.ts:58` 的排序（拆分 bm25 与 confidence） | 无检索评测基线；改排序会整体改变既有结果集，收益（仅 B3）与回归风险不成比例 |
| `additionalProperties:false` 拒未知参数 | AGENTS.md 明确"拒绝会打断 Agent 写回"；只提示不拒 |
| 新增第三个 MCP 工具（如 `get_topic`） | 违背最小工具面纪律；`search_memory(topic=…)` 即可覆盖（WP3） |
| 让 `save_memory` 自动 `git commit` | 与"工作区语义 + `omem backup` 显式提交"的既有设计冲突 |
| 在 dedup 分支直接改走 in-place 元数据更新 | 相当于给 Agent 开放修改既有文档元数据的权限，且需新增 topic 占用判定；先只改文案（WP4 步骤 5 备选方案），单独立项 |

---

## 5. 上线节奏与放行条件

| 批次 | 版本 | 内容 | 放行条件 |
| --- | --- | --- | --- |
| 1 | **beta.8** | WP1（纯发布，无代码） | `npm test` 全绿、`npm run smoke` 通过；发布说明点名 A6 的 evidence 语义漂移 |
| 2 | **beta.9** | WP2 + WP3 + WP4 | `tests/mcp-probe.mjs` 断言：`instructions` 非空且含 `PROCESS.md`；`search_memory(topic=…)` 命中 active；`top_k=100` 被夹到 20 而配置 50 不传参时不被夹；带前缀 `session_id` 得分不低于裸 id；MCP 文案不含 `--`；真实库只读抽查 |
| 3 | **beta.10** | WP5（独占一个版本） | 五组阶梯用例固化为测试；既有库置信度分布前后对比（`GROUP BY confidence`），确认 0.35/0.55 两档变化符合预期 |
| 4 | **beta.11** | WP6 + WP7 + WP8 | `structuredContent` 与 `outputSchema` 由同一对象生成；`guide-*.test.ts` 三套既有断言不被破坏；LIKE 路径不输出伪造分数 |

若你选择跳过 beta.8（直接把 WP1 的发布说明并入下一版），则批次 2–4 的版本号整体前移一位，其余不变。

全局纪律（贯穿所有 WP）：Markdown 仍是事实源，`index/omem.db` 可重建；不自动删除任何条目；所有写入仍走 `redactSecrets` 与 `atomicWrite`；新增命令沿用 `openCtx()` + `finally index.close()`（Windows EBUSY 约束）；README 与 AGENTS.md 随行为同步，否则 `docs-consistency.test.ts` 会红；每个 WP 独立提交，WP5 不与任何其他改动混在同一提交里。

---

## 6. 审查意见采纳对照

| 审查意见 | 处理 | 落点 |
| --- | --- | --- |
| ① beta.8 口径二选一 | 采纳「beta.8 = 纯发布 HEAD 已修内容」 | §0 修订记录、§3 版本口径、§5 批次表 |
| ② dedup 文案的 MCP 出路不可执行 | 采纳并加严：MCP 版要求"改正文 + supersedes"，CLI 版才提 `omem topic set` | WP4 步骤 5 |
| ③ WP5 缺"压低 D"、误用 `omem eval` | 采纳：补齐三方案对比、推荐方案 B；分布统计改 `GROUP BY` | WP5 |
| ④ D4 console.log 表述、`omem run` 已移除 | 采纳 | §1 D4 行、§2 D4 |
| ⑤ `tests/unit/*score*` 不存在 | 采纳：逐一点名实际文件 | WP5 改动范围 |
| ⑥ `top_k` 夹取会连带夹住配置值 | 采纳：只夹显式传入值 | WP3 步骤 4、验证项 |
| ⑦ LIKE 路径无 bm25 | 采纳：兜底路径不输出分数、标 `match: substring` | WP6 步骤 4 |
| ⑧ 编辑距离属过度设计 | 采纳：只保留固定别名表 | WP8 步骤 3 |
| ⑨ 吸收判定被低估（JSON 文本列） | 采纳：改用 `absorbedSessionIds()` 内存 Set | WP8 步骤 5 |
| ⑩ 剥前缀会误伤含冒号的 id | 采纳：fallback 链（先原样、后剥前缀） | WP4 步骤 1 |
| ⑪ 临时脚本 `outputs/_verify_limit.mjs` | 已删除 | — |

---

## 7. 实施进展（2026-10-27 首轮落地）

已按 §5 的顺序实现 WP2–WP8 的代码部分，测试 613 passed / 60 files，`npm run smoke` 67 passed / 0 failed。

| 包 | 状态 | 备注 |
| --- | --- | --- |
| WP1 发布 beta.8 | **未执行** | 需要 OTP 与版本号确认；`npm publish` 不在本次范围内 |
| WP2 instructions + 描述 | 已完成 | 新增 `context/instructions.ts`；`server.ts` 通过 `ServerOptions.instructions` 下传；版本改由 `core/version.ts` 注入 |
| WP3 topic/status 检索 | 已完成 | `searchEntriesPage` 返回 `{rows, matched}`；`search-format.ts` 共享零结果文案；CLI 与 MCP 同一份措辞 |
| WP4 写入反馈 | 已完成 | `sessionFound` / `anchors` / `caller` / `existing` 四个字段回流；响应改多行 |
| WP5 方案 B | 已完成 | 首位命中不计独立印证（`corroborationFromIndex`）；顺手修了 skipSet 未归一化导致的自印证漏网 |
| WP6 可读性/结构化 | 已完成 | 句界、topic 优先标题、尾句条件化、`annotations` / `outputSchema` / `structuredContent` |
| WP7 PROCESS.md | 已完成 | `Existing topics` 每行带 active id；`otherDocIds` 展开；补 session_id 写法 |
| WP8 诊断与杂项 | 已完成 | 版本+pid 日志、config mtime 热读、未知参数别名提示、C9 反向分支、sessions snippet + 吸收标记 |

### 与计划的偏离（执行中决定）

1. **B3 不输出"批内分位 strong/weak"**，改为回显原始 `bm25` + 一句 legend（「越负越近；仅在本结果集内可比」）。分位阈值是无数据的臆造，反而会诱导误判；原始分在同一次查询内本就可比。
2. **`top_k` 的 0 / 负数夹到 1 而非回落到配置默认值**，与 schema 的 `minimum: 1` 同口径。计划只写了「同口径 clamp」，未指定边界行为。
3. **`session_id` 额外支持逗号拼接**：拆成「首项为 primary、其余进 `source_sessions`」并提示。计划未列此项，但它是实测过的失败形态之一，且改动只有几行。
4. **`process/score.ts` 的 skipSet 归一化**：计划里没有这条，是 WP4 实施时发现的同类缺陷——带前缀的 `session_id` 仍然会让来源会话被当成"独立印证"，从而给 0.65。修完 B 与 D 才真正持平。
5. **`tests/smoke.sh` 改用 run-scoped home**：Windows 上 `rm -rf .omem-test` 会因残留的 `omem.db` 句柄静默失败，上一轮 `knowledge/` 被重新索引后，下一步写入撞上 content-hash 去重，报成与改动无关的假失败。属于测试基建缺陷，与本次功能改动无关但会持续干扰验证。
6. **`AGENTS.md` 修正了过时描述**：原文仍写着「祈使语气减半置信度并打 `low-weight`」，但该逻辑已在 `ad6305f` 删除。这不是本次引入的问题，而是文档一致性测试没覆盖到的一处漂移。

### 首轮未申报的偏离（由 2026-10-28 审查意见补记，处置见 §8）

7. **WP4 步骤 5 的 CLI 半边没做**：计划要求 `omem add` 的 dedup 文案也比对元数据并指路 `omem topic set`，首轮只做了 MCP 侧；且 MCP 侧的比对漏掉了计划里写的 tags。
8. **WP4 步骤 3 的「归因写进 commit 日志」没做**：`logOutcome('written')` 当时只有 id/source/redacted/supersedes，审计链路回答不了「这条当时锚没锚上」。
9. **WP6 步骤 5 自己立的纪律被违反**：`outputSchema` 与 `structuredContent` 两处手写，且已经漂移（search 的 `rank`、sessions 命中项的 `snippet` / `absorbed` / `project`、save 的 `confirmed` / `confirm_missing` 都没进 schema）。
10. **`dry_run` 与 `confirm_ids` 不互斥**：`a73f4d2` 引入 `dry_run` 时 `applyAssent` 不受门控，而描述却承诺「不落盘」——契约文案与行为直接矛盾（该洞早于本轮，但文案是本轮写进描述的）。

### 待办

- WP1 发布（需要 OTP）：`0.1.0-beta.8` 只发已提交的 HEAD（截断提示、evidence 数组、corroboration ladder、`dry_run`、`omem topic set`），本次改动进 beta.9。
- WP5 的方案 C（锚定固定 +0.10）仍待决策，需先跑 `SELECT confidence, COUNT(*) FROM entries GROUP BY confidence` 看既有分布。

---

## 8. 第二轮整改（2026-10-28，审查意见逐项）

基线 HEAD `399c8be` + 工作区在途改动。验证：`npm test` 630 passed / 61 files，`npm run smoke` 67 passed / 0 failed，`npm run build` 通过。

| 审查条 | 判定 | 本轮处置 |
| --- | --- | --- |
| 二-1（P2）`dry_run` + `confirm_ids` 真实写入 | 已在途改动中修复，本轮补测试钉住 | `dryRun` 分支改为只 `findById` 探测并输出 `[dry-run] Would record assent …`，不调用 `applyAssent`；`structuredContent.dry_run = true` 成为程序侧区分标记。`save-feedback.test.ts` 两条用例：预演前后 `confidence` 不变且 `confirmed` 缺省；去掉 `dry_run` 才升到 0.8 |
| 二-2（P3）CLI dedup 文案未做 / MCP 漏 tags | 已做，并把口径收拢 | 新增 `core/commit.ts` 的 `metadataDrift(existing, {topic, type, tags})`，CLI 与 MCP 共用同一份比对（原先两处手写正是 tags 漏掉的原因）。`omem add` 命中去重时打印 `Metadata not applied: …` 与 `… or run: omem topic set <id> <topic>`。测试：`commit.test.ts` 一条（含 tags、含「没给旗标时不误报」反向断言） |
| 二-3（P3）归因未进 commit 日志 | 已做 | `CommitOpts.audit` 原样并入 `commit` 事件；MCP 侧带出 `confidence / tags / session_found / anchors{total,matched}`。测试断言锚定成功与锚不上两种情形的日志值 |
| 二-4（P3）schema 与 structured 双写漂移 | 已补齐 + 改为测试对齐 | 明确选择「schema 刻意宽松（无 `required`、无 `additionalProperties:false`）+ 靠测试对齐」而非单一来源生成：补声明 `rank`、`dry_run`、`confirmed`、`confirm_missing`、`metadata_drift`，并把 sessions 命中项的 `session_key/path/project/absorbed/snippet` 补进 `hits.items`（`hits` 的含义随 scope 变化，已在 description 里言明）。新增 `mcp-tools.test.ts` 的对齐用例：实跑三种调用形态，逐 key 比对声明集 |
| 二-5①（P3）CLI 未用 `version.ts` | 按代码方向修正文档声明 | `src/cli.ts` 改 `import { OMEM_VERSION }`，删掉自行的 `readFileSync(package.json)`——现在 AGENTS.md 的「唯一来源」是真的 |
| 二-5②（P3）不变式未限定范围 | 已限定，并把倒挂挂账 | AGENTS.md 的印证不变式改为「**given evidence**：同一条引文，点名会话不得比不点名低」，并显式声明「引会话但不给证据（0.35 ungrounded）< 什么都不给（0.55 pending-session）」这一倒挂是已知、未解、留给方案 C 的决策材料，禁止悄悄扩大不变式适用范围 |
| 二-5④ / 二-6①②③（P4）文案与注释 | 已做 | 「证据全被 <12 字门槛过滤」单列一句 `No valid evidence: every quote was shorter than 12 characters…`（不再读起来像忘了给）；`sessionFound === true` 分支不再说「confidence rests on the session reference alone」而给出实际分数与补救动作；MCP 响应里的 `or run omem sync` 改为 `ask the user to run omem sync`（Agent 执行不了 CLI）；`search.ts` 的 `snippet` 注释此前超前于代码——LIKE 兜底路径本轮补上 `manualSnippet()` 实现（code point 定位、大小写不敏感对齐 SQLite LIKE、换行压平），注释与行为一致 |

### 本轮新增的偏离与设计决定

1. **`metadataDrift` 落在 `core/commit.ts`**：计划把它放在调用方。放这里的理由是它只需要 `CommitResult.existing` 的形态，且能顺带把「谁都不能手写第二份比对」写进 AGENTS.md 不变式。
2. **type 漂移只在调用方显式给对时才比对**：`type` 缺省会回落成 `fact`，若照此比对，「给 experience 写的正文、再不带 type 地重放一次」会被误报成漂移。CLI 与 MCP 同口径。
3. **FTS `snippet()` 不再自带 `『』` 标记**：标记由渲染层统一加，否则 FTS 路径套两层括号；`SessionHit.snippet` 的注释里写明了这条约定。
4. **`dry_run` 预演命中去重时也算并展示 drift**（`Metadata that would be lost to content dedup: …`）：预演的价值就在于不写就能看见会丢什么。
5. **`structuredContent.status` 在预演成功时仍是 `written`**：靠 `dry_run: true` 区分，而不是新增 `status` 取值——避免把「未写」的语义扩散到 `omem audit` 与既有断言里。

### 待办（更新）

- WP1 发布仍待执行：`beta.8` = 已提交的 HEAD；本轮改动（含 §7 补记的 4 条）进 `beta.9`。
- 方案 C 决策材料追加一项：二-5② 的「无证据倒挂」与已修的「点名会话倒挂」同构，一起进分布评估。
