# omem v0.5.0 演进路线与 Roadmap（Phase 1 立项定义产出）

> 日期：2026-11-22 ｜ 基线：v0.4.0（`465faf8`，tag `v0.4.0` 已推远端，npm 未发包）
> 工作方式：全栈智造专家团 Phase 1 三成员并行（选品洞察师 / 产品主理人 / 架构师），团长整合裁决；2026-11-22 评审 6 条修正已回写。
> **本文件已迁入 `docs/` 作为现行开工依据**；下方状态表随分阶段实施更新。

## 实施状态表

| 阶段 | 议题 | 状态 | 验证 |
|---|---|---|---|
| 0 | 基线冻结 | 完成 | payload 12,283/12,300、instructions 1,976/2,038、工具描述 1,096/1,377、预算测试 16 全绿 |
| 1 | S1 证据裁定（P0） | **完成** | `automation-mark-readonly.test.ts` 7/7；既有 guide-budget / quote-coverage / score-ladder / evidence-layers / 预算测试 53/53 绿 |
| 2 | S3 假出口修复（P0） | **完成** | `guide-budget.test.ts` 11/11（含 probe 来自 hidden 集合、非 topic 假出口）；`guide-empty-state.test.ts` 2/2（空态 + session_id 通道端到端） |
| 3 | S2 有界采集（P1） | **完成** | `watch-once.test.ts` 7/7（静默窗/硬上限/去抖/复扫/no-roots/work profile）；`install-hooks-readonly.test.ts` 2/2；`cli-args.test.ts` 22/22 防漂移绿；隔离 home 端到端退出 0（64ms） |
| 4 | S4 核查 + 全量门禁 | **完成** | 834 tests / smoke 91-0 / eval:search 8-8 / eval:capability PASS / eval:quotes PASS / payload 12,283 / instructions 1,976-2,038 / release-check --no-tag OK |
| 5 | Phase 2 门禁复核（P0 修复 + A 案断言） | **完成 / GO** | 843 tests / smoke 93-0 / 三套评测 / 预算三上限 / release-check OK / work profile 真实 CLI exit 2 |

**阶段验证明细**

- 阶段 0：`docs/omem-v0.5-Roadmap.md`（Current 索引）、`docs/archive/omem-v0.4-议题计划.md`（Archive 索引）；CHANGELOG 断链已修。
- 阶段 1（S1）：`automation-mark-readonly.test.ts` 7/7；既有 guide-budget / quote-coverage / score-ladder / evidence-layers / 预算测试 53/53 绿。评审要求的「固定 fixture 双向钉」「字段级不变」「S1-c 复用 verify --quotes」均落地。
- 阶段 2（S3）：`guide-budget.test.ts` 11/11、`guide-empty-state.test.ts` 2/2；假出口改为真实 hidden id + 可执行 `session_id` 通道。
- 阶段 3（S2）：`watch-once.test.ts` 7/7、`install-hooks-readonly.test.ts` 2/2、`cli-args.test.ts` 22/22；隔离 home 端到端退出 0。四项缺口（退出语义、提交合并、hook 纪律、work profile）全部补齐；未引入常驻 daemon。
- 阶段 4（S4）：现状核查通过，README 补降权说明；全量门禁全绿。

依赖顺序：0 → 1（S1-a→b→c）→ 2 → 3 → 4。S4 为核查项，不新增模块。

## 一、结论先行

五个痛点归并为 **4 个议题**——痛点 1+2 同根（sessions 证据有效性裁定）合并为 S1；痛点 3 独立 S2；痛点 4 为 S3；痛点 5 为 S4。

v0.5.0 定位「**可信度可观测 + 上下文预算**」，收 **S1 + S3 两个 P0**（P0 占 50%），S2/S4 列 P1 分阶段推进。

三条全团一致的红线（不因用户提出而破例）：
1. **常驻 daemon = 全版本 NO-GO** —— 破「无 daemon / 索引每次启动派生 / 无锁」三条不变量；A 案仅作架构对比留档，**v0.5.0 与 v0.6 均不实施**，改为按需 hook + `--watch-once`（静默窗即退出，**有界驻留**、无跨进程锁）。注意：`--watch-once` 在静默窗内确实盯着采集器目录，不能称「零驻留」——否则 v0.6 评审会把它当先例引用。
2. **主动遗忘模块 = NO-GO** —— `stale × 0.5` 已是可检索性衰减（可逆遗忘），是特性不是缺陷；硬删仅 `omem redact --yes`。
3. **不为 token 问题新增 MCP 工具** —— payload 仅余十几字符，加工具 +700~900 字符不成立；先做零每轮税的渲染优化，当期**不碰** `RULE_*` / `initialize.instructions` / `save_memory` 契约（AGENTS.md:27）。

## 二、五个痛点 → 根问题与裁决

| # | 用户痛点（原文要点） | 真实根问题 | 裁决 | 落点 |
|---|---|---|---|---|
| 1 | 一个 session 十几轮，如何裁定有效真实信息 | 不是"挑哪句"，是"哪条来自 ## user、哪条是助手自述/命令块/反问"不可观测 | GO（并入 S1） | 只读派生 `evidenceClaims()`，不改 confidence |
| 2 | 自动化任务 sessions（发邮件/抓热点/写日记）算不算有效 | 自动化产物与用户真实陈述混在同一个待办队列 | GO（并入 S1） | 双信号门槛 → PROCESS.md **只读打标** `(likely-automation)`；不自动写 `skip.json`，由人判后显式 `omem skip` |
| 3 | 想和 codegraph 一样简单有效，考虑常驻进程，要架构师 | 用户要的是"少手动 sync"，不是"必须 daemon" | **按需 GO / daemon 全版本 NO-GO** | S2：hook + `omem sync --watch-once`（静默窗即退出）；daemon A 案仅留档，v0.5/v0.6 均不实施 |
| 4 | 大量原始文档让处理 PROCESS.md 的 Agent token 过度消耗 | 全文注入的固定税，不是缺一个读取工具 | **部分 GO**（S3 收缩） | 分区裁剪 v0.4.0 已做、属回归；真缺陷是隐藏组假出口（必修）。全量首 40 字摘要经实测与 45KB 预算冲突，移出 v0.5.0；新工具待腾挪并证实高频重复读取 |
| 5 | 多 sessions 映射单 topic，证据越攒越多，要不要遗忘 | 证据链增长与"可检索性衰减"是两个不同的问题 | **核查 + 文档**，遗忘 NO-GO | S4 降级：衰减呈现 v0.4.0 已在所有输出面（`formatStaleness`），只补一句降权说明；不新增模块 |

## 三、关键决策 AB（架构师产出，团长裁决）

### 3.1 痛点3：常驻进程 A vs B

| | A 常驻 daemon | B 按需触发 + 轻量 hook（**采纳**） |
|---|---|---|
| 形态 | `fs.watch` 递归 11 根（9 采集器，qoder/codebuddy 各 2 根）→ 事件去重 → scanSessions → refreshGuide | 客户端 Stop/PostToolUse hook 或 `omem sync --since` 单次；可选 `--watch-once` 静默窗退出 |
| 不变量冲击 | 破「无 daemon / 派生视图 / 无锁」；引入常驻内存、自愈、Windows watcher 稳定性、与 CLI sync 双写 | **有界驻留**（静默窗内仍盯着目录，窗到即退）、无跨进程锁；复用 `collector.ts:202` 的 `content_hash` 跳过 |
| 运维 | 需自启 + 日志 + PID | 无 |
| 与 codegraph 可比性 | 无（codegraph 也无 daemon） | 对齐「按需重建」体验 |
| 故障模式 | 漏事件 / 事件风暴 / 双写 | hook 未触发 → 手动 sync（现状已可接受） |

**裁决 B，A 案仅留档**。理由：唯一同时守住三条不变量；用户要的"简单有效"由 hook + `--watch-once` 满足，不需要后台常驻。**v0.5.0 与 v0.6 均不实施后台常驻进程 / 跨进程锁 / 后台生命周期**——不再保留"v0.6 opt-in daemon"的口子。`--watch-once` 是**有界驻留**（静默窗内盯着目录、窗到即退）的单次运行，复用 `collector.ts:202` 的 `content_hash` 跳过；我把它**提到 v0.5.0 当期 P1**（与产品主理人的 P1 延后分歧点，仅此一项提前）。

**S2 落地前必须补齐四项**（评审核实 `serve.ts:15`、`pipeline.ts:300`、`sync.ts:88,98` 后确认，均为缺口）：① **退出语义**——先全量扫描 → watch → 静默窗无事件 → 复扫确认 → 退出，加硬上限时长防慢泄漏变常驻，事件去抖/风暴抑制；② **提交合并**——现在每次 run 一笔 `omem: sync …`（`pipeline.ts:300`），watch 循环须合并提交窗口，否则 git 历史被切碎；③ **hook 接线走 install 六条写纪律**——默认不装、显式 `--hooks`、失败不拖垮宿主；④ **work profile 边界**——`assertExportAllowed` 只挂在 `omem backup`（导出），`omem sync` 采集不受拦截，hook 自动采集在 work profile 下会照常写本地库，必须明确写进文档或加拦截，不能悬空。

另：`codegraph 无 daemon` 属外部项目说法，**不作本项目的决策依据**（决策依据是三条不变量）；性能验收 ≤2s / P95 ≤200ms 须在新路径复测，不沿用旧结论。

### 3.2 痛点4：token 优化 A vs B

| | A 渲染优化（**当期采纳**） | B 交互改造（延后） |
|---|---|---|
| 手段 | **仅修隐藏组假出口 + 补可执行性断言**（详见 3.2c）；分区裁剪已在 v0.4.0 实现（`guide.ts:551-563`），属回归 pin 不是新增 | 加 `read_guide(section,offset,limit)` 或 `search_memory(scope="guide")` |
| 每轮税 | 零 | 有（新工具/参数进 payload） |
| 成本 | 仅改 `process/guide.ts` 一条提示文案 + 测试 | 加工具 +700~900 字符；payload 当前 12,283/12,300 余十几字符，不成立 |
| 前置 | 无 | 先把 description 内联的 `RULE_*` 改引用短句腾 ~1,400 字符，且须同步 `mcpInstructions`（AGENTS.md:27 同一契约） |

**裁决 C = 当期只做 A，且 A 已收缩为「修假出口 + 补断言」**。B 的启用条件写死：腾挪完成 **且** 证实 PROCESS.md 被重复读取占比高；优先复用现有 scope，不新增工具。

**3.2a 砍掉「首 40 字摘要行」（评审核实：原方案算术自相冲突）**：`guide.ts:80-84` 的实测依据是 546 会话行 ≈22.9 KB、全文件 ≈31.6 KB（**0 隐藏**）。若全量每行加 40 字符摘要：ASCII ≈ +22.9 KB → ≈**54.5 KB**；CJK 按 3 字节/字符 ≈ +66.6 KB → ≈**98 KB**——双双远超 45,000 B 上限，降级阶梯会立刻把今天的「0 隐藏」变成大面积隐藏，与 S3 目标完全相反。**否决全量摘要**。可行的替代（若仍要做）：只加在折叠行上——把 `(same-user-text: N)` 纯计数换成「共享 user 文本首 40 字」，信息增益真实、体积近似中性，且须实测字节入验收；否则 S3 就收缩为仅修假出口，token 问题交给 S1 的自动化打标（减少无效会话占据清单）。

**3.2b 游标 vs 分批窗口（架构师上报，团长裁决：分批，无游标）**：当期按项目指纹分组 + 分批窗口，复用现有 `guide_batch` 与 `remaining` 计数；**不引入游标参数**。理由：① 当前无游标，加上要给 `search_memory` 增参数，payload 余量仅十几字符；② 须同步 `initialize.instructions` 契约（AGENTS.md:27）；③ PROCESS.md 是每次重建的派生视图，游标对无状态视图收益有限。pin `tests/mcp-probe.mjs`、默认 2 工具、instructions ≤2048、payload ≤12,300。

验收**按结果而非参数**：每轮渲染首批 `guide_batch` 组；吸收后自动暴露下一批；`remaining` 单调递减至 0 且为明确终止态；被预算隐藏的组必须给**真正可执行**的下一步；tools/list 参数面不变、payload 余量 ≥17。若实证"无法读完剩余批次"，游标转 v0.6 前置并走变更登记——这是唯一的翻案条件。

> **S3 发现的实际阻塞点（架构师源码复核，必须修）**：`guide.ts:276` 现文案「Narrow the topic, or `search_memory(topic="<name>")` for the rest」是**假出口**——`search_memory(topic=...)` 走文档检索、取不到会话原文；`scope=sessions` 又不读 `project`，隐藏会话没有任何 MCP 读取通道。唯一真出口是 CLI `omem search --sessions <query>`（本地扫全部 transcript，可按用户原话定位）。S3 必须把该行改为指向 CLI（或在证实"分组扫描"确为高频诉求后，才把游标列为 v0.6 前置）；并新增断言：每个 hidden 组提示里出现的工具名，其参数组合必须能取到会话原文。相关既有 pin：`guide-budget.test.ts` 的 hidden 标记恒等式（`shown + hidden + unassigned == 窗口会话数`）、空 sessions 空态不得抛异常。

### 3.3 痛点5：遗忘

三方一致 NO-GO。事实依据：`evidence` 已由 `mergeEvidence` 限 8 条 / 2000 字符；`evidence_current` 隔离历史链（D1 不过滤）；`stale × 0.5` 就是可检索性衰减；硬删只有 `redact`。人类记忆调研（Richards & Frankland 2017）支持"衰减而非删除"。时间衰减参数默认关，避免 `verify` 账本漂移。

## 四、v0.5.0 议题定义

| 议题 | 定义 | 验收（可测） | 级 | 依赖 |
|---|---|---|---|---|
| **S1 证据裁定** | 只读派生会话证据 claims + 自动化会话双信号打标 | 固定 fixture **双向**钉：自动化 prompt 样本必标、人工**实质性陈述**必不标（口径不是"人工 `## user` 不得被标"——自动化定时 prompt 常也是人写的）；单信号一律不标、≥2 信号才标；**③ 是唯一能独立成立的强信号，④/①/② 均为辅助**（④ 单独成立会把长助手回复误标为自动化例程，与「人工实质性陈述必不标」冲突；此口径以 `automation.ts:100` 实现为准，见 `omem-v0.5-测试保障方案.md` 裁决 B），因信号①（user 段占比<20%）在 Claude Code 类会话是常态、①+②正则噪声大；漏标留 v0.6 调阈值；每条 evidence 可回溯 session + userKey；`classifySession` 返回 `signals: string[]`（规则编号 + 文本特征，如 `user-ratio=0.12`），PROCESS.md 行尾紧凑渲染、完整依据写 `logs/`；**未人工 `omem skip` 前 `evidence`/`evidence_current`/`confidence`/`status` 逐字段不变**，用字段级断言不只靠 git diff | **P0** | 基线冻结、`session-store.ts` |
| **S3 假出口修复** | 修 `guide.ts:276` 隐藏组假出口 + 补可执行性断言 | `PROCESS.md` ≤45,000 B、tools payload ≤12,300 且余量 ≥17 均为**现状回归 pin**（v0.4.0 已达标）；隐藏组提示里出现的工具+参数组合必须真能取到会话原文；降级只砍展开层，**不删头部、`RULE_*` 或 instructions 原文**；空 `sessions/` 走 `No topics are waiting.` 空态不抛异常 | **P0** | `tool-budget.test.ts` 钉 12,300 |
| S2 采集体验 | hook + `--watch-once`；工具描述触发条件式 | 显式触发可用、默认工具仍 2 个、描述 ≤2,048 字符；`--watch-once` 有界驻留、硬上限时长、提交合并、hook 默认不装、work profile 边界明确；性能在新路径复测 | P1 | S1 |
| S4 衰减呈现 | 核查 + 文档补一句降权说明（**不新增模块**） | 现状 pin：`stale × 0.5`（`search.ts:84,99`）、`formatStaleness` 已在 MCP/CLI/review/MEMORY-INDEX 渲染 `not reviewed (cooled)`（`lifecycle.ts:17-21`）、evidence 8 条/2000 字符（`entry.ts:230-235`）、硬删仅 redact | P1（v0.6） | S1 |

**负向清单（不做）**：daemon 默认化、SQLite/向量库/KG、auto-delete、`verified` flag、第三把 hash、默认 MCP 扩工具、规则提取复活、按语义过滤 evidence、时间衰减默认开。

## 五、Roadmap（三阶段）

| 阶段 | 主题 | 关键议题 |
|---|---|---|
| **v0.5.0** | 可信度可观测 + 上下文预算 | S1 证据裁定（自动化打标 + 溯源）、S3 预算渲染、S2 的 `--watch-once` |
| **v0.6.0** | 自动化采集质量 | S2 全量 hook 多端适配、S4 可逆遗忘呈现、token B 案（若证实高频重复读取）；**不引入任何常驻 daemon** |
| **v1.0** | 体验与规模化 | 多端上下文导出、采集器扩展、统一评测基线、跨主题证据关联 |

递进逻辑：v0.4 让信任数字可审计 → v0.5 让证据来源与预算可观测 → v0.6 让采集自动化且不失真 → v1.0 规模化。

## 六、v0.5.0 演进路线（依赖顺序）

1. **基线冻结**：不变量测试点名 + payload 12,283/12,300 实测 → 验收：清单签字。
2. **S1-a 证据 claims**（去噪提示，非裁定）：`collect/session-store.ts:376-387` 的 `evidenceUserText()` 复用 `sectionRuns()`，新增只读 `evidenceClaims(body)`——只取 `## user`、剥 metadata 围栏、命令块/反问句列 low-signal 提示、同 `evidenceUserKey` 跨轮只记首次。**不自动裁定、不自动提分**，产出只写 `logs/` → 验收：人工样本一致率 100%。
3. **S1-b 自动化打标**（只读，不自动丢弃）：`collect/session-store.ts:311-365 sectionRuns` 与 `collector.ts:202` 的 `content_hash` 跳过之间加 `classifySession(digest,body) → { likelyAutomation, signals }`，信号＝① user 段占比 <20% ② 首句命中 发邮件/抓热点/写日记/定时 正则 ③ 同 key 跨 ≥3 session 且 started 近周期 ④ messages 高但用户文本单一。**≥2 信号且 ③ 成立**才在 PROCESS.md 行尾标 `(likely-automation)`；单信号一律不标；**③ 是唯一强信号，④/①/② 为辅助**（①是 Claude Code 常态、①+②噪声大、④ 单独会误标长对话）。**不自动写 `skip.json`**——人工看到标记后显式跑 `omem skip <id> --reason duplicate`（CLI 已存在，`guide.ts:46-52 SkipRecord` 支持 `reason`），才从第〇节移出待办；原文与会话文件不动。判定依据写 `logs/`，字段级断言 `evidence`/`evidence_current`/`confidence`/`status` 在人工 skip 前逐字段不变 → 验收：固定 fixture 双向钉（自动化 prompt 必标 / 人工实质陈述必不标）、漏标留 v0.6 调阈值。
4. **S1-c 溯源 = 增强 `verify --quotes`，不另起视图**：`score.ts:410-476` 已建好 `sessionId → 剥净 ## user 文本` 的池子，只补报「命中 session id（+userKey）」即可 → 验收：逐条 evidence 可复核到来源会话，零新增工具/模块。
5. **S3 假出口修复**：只改 `guide.ts:276` 一条文案 + `guide-budget.test.ts` 两个断言 + 新增可执行性断言；分区裁剪与 45,000 B / 12,300 双上限属 v0.4.0 现状，作回归 pin 不再立新增项。
6. **S2 轻量采集**：hook + `--watch-once` → 验收：显式触发可用、默认工具仍 2 个。
7. **回归 + 门禁发布**：`npm test` + smoke + 三套评测全绿、不变量用例逐条绿 → go/no-go。

## 七、go/no-go 门槛

- **测试**：`npm test` + `tests/smoke.sh` 全绿；不变量用例逐条绿。
- **DoD 点名用例**：
  - **源码已核实的既有 pin**（架构师已读源码确认存在，作为不可回归基线）：`session-id` 读取文件而非 `searchSessions` 扫全库、`evidenceForScore` 历史链与当前层分层、`core/index.ts` 的 session slots 结构、`session-store.ts` 的 `evidenceUserText`、`tools.ts` 的 `tool-payload`/`annotations` 与 `mcp-probe.mjs`、instructions ≤2048 与 payload ≤12,300、`guide.ts:SkipRecord` 支持 `reason`。
  - **v0.5.0 拟新增**（当前不存在，随对应议题落地，不可误当成已有回归基线）：`automation-mark-readonly`（只读打标不改字段）、`guide-empty-state`（空 sessions 空态）；外加架构师要求的 15.2/15.3 参数边界与 15.4 字段级断言补强。
- **评测**：裁定一致率 100%；`eval:search` 8/8、`eval:capability` 全绿、`eval:quotes` PASS 无回归。
- **token 预算**：instructions ≤2,048 字符；payload ≤12,300 且余量 ≥17；PROCESS.md ≤45,000 B。
- **不变量**：无 daemon / 无硬删 / 无第三 hash / 无 verified flag / 无规则提取 / 默认工具仍 2 个。
- **性能**：`sync` 1100 会话 ≤2s；session_id 读取 P95 ≤200ms；MCP stdout 零日志。

任一不满足 → no-go。

## 八、三方案矛盾与裁决记录

| 分歧点 | 选品洞察师 | 产品主理人 | 架构师 | 团长裁决 |
|---|---|---|---|---|
| daemon 默认化 | NO-GO | NO-GO，降 v0.6 | NO-GO，选 B | 一致 NO-GO；**全版本不实施**，A 案仅留档（评审纠正：v0.6 opt-in 口子已删） |
| 痛点3 watch 时点 | 0.5.0 当期上 | S2 列 P1 延后 v0.6 | 当期 hook + `--watch-once` | `--watch-once` 提到当期 P1（**有界驻留**、复用 content_hash）；全量多端 hook 延后 |
| 优先级 | 痛点4 先行 | S1+S3 并列 P0 | 痛点1/2 纯函数 + 痛点4-A 当期 | S1 + S3（已收缩为假出口修复）两个 P0（50%）；S2 的 watch-once P1 |
| 主动遗忘 | NO-GO | NO-GO，降 v0.6 | NO-GO，不新增模块 | 一致 NO-GO；S4 降为核查 + 文档（衰减呈现 v0.4.0 已有） |
| token B 案 | 推荐轻量分层 | 未指定 | C=A 当期、B 待腾挪 | 采纳 C；B 启用条件写死（腾挪 + 重复读取占比证据） |

## 九、项目档案（更新）

- 项目名称与定位：omem — git 原生个人 AI 记忆层
- 平台选型：npm CLI 包 + stdio MCP server；无数据库、无 daemon
- 技术栈：TypeScript / Node ≥22.5 / Vitest / git；运行时仅 MCP SDK + node-zstd
- 当前阶段：**v0.5.0 全量发布执行中（用户 2026-11-22 明确授权「直接全量发布 v0.5.0」＝A 案，推翻 B 案推荐）**
- 已完成产出：v0.4.0（`465faf8`，tag 已推）；v0.5.0 提交 `3eac868`；Phase 2 修复提交 `0f37814`；[`omem-v0.5-测试保障方案.md`](./omem-v0.5-测试保障方案.md)（GO）；[`omem-v0.5-上线发布方案.md`](./omem-v0.5-上线发布方案.md)（Phase 3 方案 + 回滚四情形）
- 下一步：阶段 0（版本/文档/门禁）→ 阶段 1（push + 精确 tag）→ 阶段 2（npm publish 到 latest）→ Phase 4 运维保障
- **发布前实测（2026-11-22）**：远端 main / tag 均停在 `465faf8`（本地领先 2 笔）；`npm whoami --registry=https://registry.npmjs.org` 返回 **E401**（登录态失效）；`npm dist-tag ls` 快照 `beta: 0.3.1` / `latest: 0.3.2`，证实 0.4.0 未发包；`package.json` 已 bump 0.5.0、CHANGELOG 已转正
- **验收口径更正（团长裁决 B）**：§4 与 §6.3 的「第二信号限 ③/④」以实现为准，改为「③ 唯一强信号，④/①/② 为辅助」——④ 单独成立会把长助手回复误标为自动化例程，与「人工实质性陈述必不标」冲突。此更正记于测试保障方案第〇节。
- 架构决策摘要：常驻 daemon 破三条不变量，改按需 hook；token 先做零每轮税渲染优化；遗忘用既有 stale 降权，不新增模块
- 里程碑时间线：v0.4.0 发布 2026-11-22；v0.5.0 计划日期待定
- 技术债务清单：~~自动化会话打标~~ 已做（S1）；~~隐藏组假出口~~ 已修（S3）；~~多端 hook 基础~~ 已做（S2，全量多端待 v0.6）；~~work profile 退出码 P0~~ 已修；~~A 案 7 处断言~~ 已补；token B 案待腾挪；真实语料识别准确率 / 漏标门槛归 v0.6
- **评审更正记录（2026-11-22）**：原稿 4 处「v0.4.0 已做却当新增」的误记已改（分区裁剪、stale 衰减呈现、预算 pin、工具描述长度）；1 处算术冲突已否决（全量首 40 字摘要 → ASCII 54.5 KB / CJK 98 KB 破 45,000 B）；1 处真缺陷保留（假出口）。另修正「零驻留」→「有界驻留」、「9 根」→「9 采集器 / 11 根」、「人工 `## user`」→「人工实质性陈述」、S1-c 落点为增强 `verify --quotes`、S2 补四项落地缺口、`codegraph 无 daemon` 不作决策依据、性能数字须新路径复测。全部经源码 + 实测核对属实，无一条反驳。

## 十、阶段复盘卡（Phase 3 → Phase 4）

- 完成度：100%（前置清单、三阶段流程、四种回滚、合规、灰度、里程碑、AB 二选一、go/no-go 齐备）
- 阻塞：3 项硬阻塞（version 未 bump / 本地领先远端 2 笔 / 是否发包未决策），发版 **NO-GO**
- 下阶段：确认发版形态与授权 → 逐项执行 → Phase 4 运维守护师衔接监控告警与应急

## 十一、下一步

v0.5.0 代码门禁 **GO**，发布门禁 **NO-GO**（待决策，非缺陷）。建议先确认「是否发包」——沿用 0.4.0 做法则仅打 tag + 推远端；若发包再定 A/B 形态。所有发版动作逐项单独授权。v0.4.0 上线后 48 小时回访节点尚未到期（11:58 推送），到时回来核对远端 tag 与用户反馈。
