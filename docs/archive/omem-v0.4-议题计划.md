# omem v0.4.0 议题计划（Phase 1 立项定义产出）

> 状态：待用户拍板 ｜ 日期：2026-11-22 ｜ 基线：v0.3.2 + 本轮两 commit（`b844d81` 评测基线、`5d96ace` as_of 历史视图）
> 工作方式：全栈智造专家团**单模块模式（只要计划）**。Phase 1 三成员并行，团长整合裁决。未改产品代码、未提交、未发布。

## 一、结论先行

v0.4.0 定位 **「边界修复 + 可信度可观测」**，不建议做成大版本：

- **必须当期 1 项**：T1 引文覆盖率可观测（P0）——唯一价值 GO，走 CLI/CI 报告，不占 MCP payload。
- **技术债 1 项**：I-3 instructions 瘦身——优先级**待定**，不占当期必修位（定性裁决见第六节）。
- **可选 B 方案 1 项**：T2 时间语义（P1）——价值未量化，需你拍板是否进当期。
- **可延后 2 项**：T3 多跳 SF、T5 review 语义澄清。
- **否决 1 项**：T4 重构失真护栏单独立项——属类比推断且冲撞「一主题一活文档整篇覆盖」不变量，降级为文档级说明。

P0 占比 100%（1/1）；若你选 B 加入 T2（P1），则 P0 占 50%（1/2），仍满足 ≤60% 门槛。

## 二、三要素（产品主理人拍板，团长确认）

| 维度 | 结论 |
|---|---|
| 做什么系统 | omem v0.4.0（git 原生个人 AI 记忆层，npm 包，CLI + MCP） |
| 面向谁 | 自建 Agent 的开发者（终端重度用户非本版优先） |
| 核心目标 | 可信度可观测——北极星＝引文原文子串命中率 100% 且 build log 可复现；**不新增信任分数** |

## 三、必须当期

| 议题 | 定义 | 价值 | 验收标准（可测） | 优先级 |
|---|---|---|---|---|
| **T1 引文覆盖率可观测** | 校验 `evidence_current` 引文为源文档原文子串、统计覆盖率、写 build log | 守引文可信底线，防幻觉引文 | 评测集原文子串命中率 = 100%；build log 输出覆盖率；<100% 构建失败并列未命中项；只报告不改源文档；legacy 文件（无 `evidence_current`）不误判 | **P0** |

**T1 技术路径**（研发师方案）：复用 `process/score.ts:60-64 evidenceIn`、`:181-187 anchors.matched`；`scoreEvidence` 增 `quoteCoverage`，经 `mcp/tools.ts:834-839 audit` 入日志；阈值 `quote_ratio_min` 仅由 `verifyConfidence`（`:339-371`）读取，产 `coverageDrifts` + `appendLog('verify')`。走 CLI/CI 报告，**不扩 MCP 工具面**（当前 12,283/12,300，余量 17）。

**团长四项技术裁决**（研发师提出待定，此处拍板）：

| 决策点 | 研发师建议 | 团长裁决 | 依据 |
|---|---|---|---|
| 原文子串判定 | 严格 raw `includes`（区别于计分用的 `evidenceIn` 归一化） | **采纳严格**；两谓词并存，`evidenceIn` 保持计分口径不变 | 验收门槛字面是「原文子串命中率 100%」；归一化会放过非逐字引文，等于静默降门槛；不是造第三把 hash |
| 零引文条目（0.35 ungrounded） | 单列、不计入分母 | **采纳单列不计数**，报告里保留计数让人看见 | 0.35 ungrounded 是合法档位；算未命中会让 CI 永久失败，等于强制所有条目必须有引文，与证据阶梯冲突 |
| 失败退出码 | 2（政策拒绝桶） | **确认两层，不合并**：① `omem verify --quotes` 单独跑覆盖率失败 → exit 2（政策拒绝，`AGENTS.md:35`）；② `release-check.mjs` 把该失败收进 failures 后，脚本自身 → exit 1（`:133-135` 既有约定） | 两层语义不同：前者是命令对调用方的判定，后者是发布脚本的汇总退出码；合并会破坏既有 `release:check` 行为 |
| 承载形式 | 新增 `omem check-quotes`（第 15 条命令） | **改为 `omem verify --quotes` opt-in 旗标，不新增命令** | v0.2 刻意把命令面从 18 条收敛到 13 条（FF09）；verify 本就是「报告不改写」语义；opt-in 旗标仅给出时改退出码，无旗标时 `cmdVerify` 行为完全不变，不破坏研发师担心的既有语义 |

实现落点据此调整：`src/commands/verify.ts:56-59` 的 if/else 链加 `--quotes` 分支调用 `verifyQuoteCoverage`（放 `src/process/score.ts`，紧邻 `verifyConfidence:339`），层选择复用 `entry.ts:254-256 evidenceForScore`，绝不改 `evidence` 历史链（D1）；日志走 `appendLog(home,'quote-coverage',{...})`（`core/log.ts:7`，JSONL 落 `logs/omem.log`，不进 git＝build log）。新测 `tests/unit/quote-coverage.test.ts`：逐字命中 / 仅标点差异算未命中 / 层选择 current vs legacy / 零引文单列 / 退出码 / 日志行；`tests/smoke.sh` 加一例；`tool-budget.test.ts` 保持绿。

**研发师定稿补充的三处防错细节**（必须写进实现 spec，否则 fixture 会假绿）：
- 严格检查**不能用 `index.sessionSlots().lowerUserText`**——它已被 `evidenceUserText(...).toLowerCase()` 处理（`:273`），小写化会放过大小写变体，破坏「逐字」语义；必须从 `files.sessions(home)` 读原文，经 `evidenceUserText` 只剥 metadata、不小写。
- 命中范围要**扫描全库会话**（`fs.walk` 会话 md），不是只查 `session_id` 那一篇；真实语料里引文常来自 `source_sessions`。
- 过滤集合 = `active && source === 'agent' && confirmations === 0`；`ratio === 0` 时返回 `quote_coverage: null` 单列，**不写 100%**（零引文被跳过，不是达标）。

**发布门落点**（研发师源码复核）：项目无 `.github/workflows`，现成门槛是 `scripts/release-check.mjs`（`:133-135` 汇总 failures → `process.exit(1)`）与 `package.json` 的 `prepublishOnly` / `release:check`。该文件 `:18-20` 要求「断言逻辑抽成纯函数并导出，由 `tests/unit/release-check.test.ts` 钉判据」——因此判定逻辑放 `score.ts` 纯函数、CLI 只渲染 + 退出码，再并入 `release-check` 的 failures，而非只跑一遍看退不退出。

**第六项裁决（I-3 计量口径）：按字符，不按字节。** 选定 B（软约定）后计量口径随之定为字符数，因为现有护栏 `tests/mcp-probe.mjs:69` 用的就是 `instr.length`（JS 字符口径），沿用既有口径、不引入第二套计量。字节读数（2,733~2,799）仅备查。I-3 既降技术债，此项为「未来真要修时」的口径，不阻断 v0.4.0 发布。

**第五项技术裁决：校验对象 = 仓库内固定 fixture**（拍板，采纳研发师推荐）。门槛「100% 可复现」必须针对 `tests/eval/` 下固定引文 fixture（体例参照 `search-capability.json`），脚本设隔离 OMEM_HOME 跑 `--quotes`，绝不读用户真实 `~/.omem`——后者既不可复现，又违反 `AGENTS.md`「开发/测试永不读写真实 OMEM_HOME」红线。既有 `verify-confidence.test.ts` / `evidence-layers.test.ts` / `evidence-text.test.ts` / `score-ladder.test.ts` 必须保持绿。

## 四、关键决策 AB：T2 时间语义是否进当期

| | **A（推荐）DEFER 到 v0.5.0** | **B 进 v0.4.0** |
|---|---|---|
| 范围 | 本版只做 T1 | 加 `time_raw/time_norm/time_precision/time_uncertain` 四扁字段 + 禁 `new Date()` 补记忆时间 |
| 收益 | 短周期可交付、风险低 | as_of 从「提交时点」扩展到「事实有效期」 |
| 成本 | — | 动 `Frontmatter` + `FM_ORDER`、所有写入路径、`EntryRow` 投射、新测 |
| 风险 | — | 价值未量化；与 as_of 提交时点语义重叠；触碰 Frontmatter 契约；选品师警告「易滑向结构化抽取/状态机」 |
| 证据性质 | — | 竞品实践（WhaleYing），**非论文实证** |

**团长推荐 A**：omem 的 as_of 已按 git commit 时点工作，文档内时间字段是另一套语义，两者说明书尚未厘清；在「事实有效期」需求未量化前加四个字段，属过度设计（FF09）。若你选 B，需先明确：你要的是「提交时点」还是「断言何时为真」？

## 五、可延后 / 否决

| 议题 | 结论 | 理由 |
|---|---|---|
| T3 跨主题多跳 SF | DEFER v0.5.0+ | MemoryAgentBench 实证全行业最高 28%，攻关投入产出不定 |
| T5 review --confirm 语义澄清 | DEFER v0.5.0+ | 测试效应实证「读后确认≠主动回忆」，0.9 是「人看过」承诺非真值；先定指标口径 |
| T2 时间语义 | DEFER（若选 A） | 见第四节 AB |
| I-3 instructions 瘦身 | 技术债，优先级待定，不占当期 | 2KB 是源码注释里的内部兼容约定（`instructions.ts:23`），非 MCP 协议硬限制；唯一护栏 `mcp-probe.mjs:69` 只查非空、无长度断言。研发师精确实测（不含插值）：静态 2,690 字符 / 2,700 字节；最坏非 ASCII home 两插值 +105 字节 / +75 字符。按字符口径需静态 ≤1,933 字符（砍 757 / 28%），按字节口径 ≤1,879 字节（砍 821 / 30%）——不是「顺手改文案」的低成本项。降级不为「合规必修」，避免虚构硬边界论证。`tools.ts` 不 import `RULE_*`，与 T1 可独立推进、对 12,283 payload 零影响；但 `RULE_EVIDENCE`/`RULE_CONFIDENCE`/`RULE_MULTIHOP` 与 `context/export.ts` 的 marker 段共用，缩短常量会同时改写导出标记，触碰 AGENTS.md「instructions 与 save_memory description 是同一契约」，不能靠删规则句达标——此为其不宜当小修的第二理由 |
| **T4 重构失真护栏** | **NO-GO 单独立项** | Bartlett/Loftus 是人类记忆心理学，LLM 整篇重写是否等价「序列再生」无实证；「无新证据不得改写」直撞整篇覆盖不变量。**仅保留文档级说明**：在 PRD/manual 写清整篇重写漂移风险 + git diff 审计方法，不得写成实证结论 |

## 六、三方案矛盾与裁决记录

| 分歧点 | 选品洞察师 | 产品主理人 | 全栈研发师 | 团长裁决 |
|---|---|---|---|---|
| 议题数 | 只 1 个 GO | 修订后 2 项 | 3 项技术路径 | 1 项当期（T1）+ I-3 降技术债 + 1 项 AB 待拍板 |
| T2 时间语义 | DEFER（成本中高） | 修订版 DEFER | 列当期 | DEFER（推荐 A），待用户确认 |
| T4 重构护栏 | NO-GO，保留 git diff 审计并入 T1 | NO-GO，仅文档级 | 加 warning 走 `warnings[]`（提示不拒绝） | 否决代码改动；降级为文档说明（依据：类比推断不改产品行为） |
| T1 覆盖率策略 | GO | P0、<100% 构建失败 | AB 选 B「verify 报告+日志」 | 采纳 B：硬拒绝会打断写回并堵死 0.35 ungrounded 自愈路径 |
| I-3 定性 | 未涉及 | 修订版列当期 P1「硬边界合规」；后质疑软硬 | 按 PM 更正列 P1，给出 740 字符压缩方案 | 核实源码后裁定为软约定：降技术债、优先级待定、不占当期。理由：无协议硬限、无长度测试、超标仍全绿 |
| T1 承载形式 | 走 CLI 报告 | 未指定命令 | 新增 `omem check-quotes`（第 15 条） | 改为 `omem verify --quotes`，守住 v0.2 命令面收敛决策（FF09） |

## 七、不变量红线（全版不可触碰）

不扩 MCP 工具面（余量 17）；不引向量库 / KG / SQLite / daemon；不做 stale 硬删或时间衰减（stale×0.5 降权是特性）；不改一主题一活文档整篇覆盖、冲突只报告、verify 只报告不改写。

研发师标记的四条实现陷阱：① 禁造第三把 hash / 禁写正文改 `body_hash`；② 覆盖率不回写（verify reports, never rewrites）；③ 新检查不得插到 D4/D3 写护栏之前、不得把 dedup 变拒绝；④ uncertain / 覆盖率**不喂 confidence**（无 `verified` 位）。

## 八、发布门槛 go/no-go

1. 四类检索评测 + 2 消融（`tests/eval/search-capability.json`）全通过，对 v0.3.2 无回归；
2. 引文命中率 100% 可复现，build log 覆盖率输出稳定；
3. as_of（ISO / HEAD~N / sha）回归全绿，`rev:path`、`snapshot:sha` 语义不变；
4. 工具面 payload ≤12,300（硬约束）；instructions 2KB 为软约定，不作发布阻断项；
5. P0 缺陷 = 0；第七节不变量全部保持。

任一不满足 → no-go。

## 九、项目档案

- 项目名称与定位：omem — git 原生个人 AI 记忆层，Markdown 事实源 + MCP
- 平台选型：npm CLI 包 + stdio MCP server；无数据库、无 daemon
- 技术栈：TypeScript / Node ≥22.5 / Vitest / git；运行时依赖仅 MCP SDK + node-zstd
- 当前阶段：Phase 1 立项定义完成（三份方案齐备、矛盾裁决完毕）→ 待用户确认议题
- 已完成产出清单：v0.3.2 基线；评测基线 `b844d81`；as_of `5d96ace`；P1-4 文档指引（4 文件未提交）；v0.4.0 议题计划（本文件）＋ Phase 1 三份方案
- 下一步计划：用户拍板两件事（AB 选 A/B、P1-4 是否提交）→ Phase 2 质量测试官出测试保障方案 → 开发与回归
- 架构决策摘要：行形状由 `entryToRow` 单一构造函数产出；历史视图与当前索引共用 `rank`；as_of 命中行 `path=rev:path`、`revision=snapshot:sha` 防误写回
- 里程碑时间线：2026-11-22 Phase 1 完成；v0.4.0 计划上线日期待定
- 技术债务清单：instructions 2,725 > 2,048 软约定（优先级待定，本版不阻断）；工具面 12,283/12,300（本版不新增字段）；T2 时间语义与 T4 重构护栏延后

## 十、阶段复盘卡（Phase 1 → Phase 2）

- 本阶段完成度：100%（三份方案齐备，矛盾已裁决）
- 阻塞问题：T2 是否进当期存在 AB 分歧，已降级为可选项待用户拍板
- 下阶段计划：确认议题清单后调度质量测试官，按参考文件 `qa-testing.md` 出测试保障方案与质量门禁

## 十一、下一步

请你拍板两件事：① 第四节 AB 选 A（推荐）还是 B；② P1-4 的 4 个文档改动是否提交（此前未获授权，仍在工作区）。

确认后进入 Phase 2，建议当日回来核对测试保障方案；v0.4.0 若启动开发，建议上线后 48 小时回来核对回归与引文覆盖率日志。

**待研发师产出**：全栈研发师仍在核对源码与技术路径，其结论到齐后我会更新第三、六节的 implementable 细节再做最终交付。
