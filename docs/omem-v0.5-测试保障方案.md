# omem v0.5.0 测试保障方案（Phase 2 质量保障产出）

> 日期：2026-11-22 ｜ 基线：`3eac868`（v0.5.0 四阶段实施已提交）｜ 上游：v0.4.0 tag 已推远端
> 产出方式：全栈智造专家团 Phase 2 单模块模式，质量测试官依 `qa-testing.md` 产出，团长整合裁决。
> 上游依据：[`omem-v0.5-Roadmap.md`](./omem-v0.5-Roadmap.md) 第七节 go/no-go 门槛、`AGENTS.md` 不变量。

## 〇、团长裁决（本轮新增）

质量测试官上报 2 个阻塞项、7 处断言缺口。裁决如下，未裁决前不出 go 结论。

### 裁决 A：work profile 退出码 —— **确认为 P0 契约缺陷，待授权修复**

| 项 | 核实结论 |
|---|---|
| 现象 | `src/commands/watch-once.ts:108` 抛 `UsageError` → `src/cli.ts:158` 映射 **exit 1** |
| 契约 | `AGENTS.md:30`：「work profile blocks sync and export by default (`ProfileBlockedError`, **exit code 2**）」；政策拒绝桶恒为 2 |
| 判定 | **属实**。watch-once 的 work profile 拒绝是政策拒绝，不是用法错误；`exit 1` 会让它与"脚本失败"混淆，破坏既有退出码语义 |
| 修法 | `watch-once.ts` 改抛 `ProfileBlockedError`（`src/core/util.ts:101`），文案不变；`watch-once.test.ts` 补 `rejects.toBeInstanceOf(ProfileBlockedError)` + CLI 层 `exit 2` 断言 |
| 状态 | **已修复（2026-11-22 用户授权）**：`watch-once.ts` 改抛 `ProfileBlockedError`（文案改为 `Currently on the work profile: … is blocked`）；`watch-once.test.ts` 补 `toBeInstanceOf` + `exitCode: 2` + 零写盘断言；`tests/smoke.sh` 增 S19 真实 CLI 断言 exit 2。实测 `OMEM_PROFILE=work omem sync --watch-once` → **exit 2** |

> 该缺陷由 `3eac868` 引入，现已闭环。**v0.5.0 go/no-go 转为 GO**（见第七节复核）。

### 裁决 B：③/④ 强信号口径 —— **以实现为准，文档滞后，非缺陷**

| 项 | 核实结论 |
|---|---|
| 分歧 | Roadmap §4/§6.3 写「第二信号限 ③/④」；`automation.ts:100` 实现为 `recurring && signals.length >= 2`，即 **③ 是唯一能独立成立的强信号**，④ 降为辅助 |
| 实现动机 | 实施阶段实测：「msg 数高 + 用户文本短」会把任何有长助手回复的普通对话误标为自动化例程。收紧后固定 fixture 双向钉（自动化必标 / 人工实质陈述必不标）才成立 |
| 判定 | **实现正确、文档滞后**。④ 单独成立会制造误杀，违反 Roadmap 自己写的「人工实质性陈述必不标」 |
| 处置 | Roadmap 两处措辞待下次修订统一为「③ 唯一强信号，④/①/② 为辅助」；本文件先记录裁决，不改已提交的 Roadmap 以免工作区出现半截改动 |
| 验证影响 | CLS-E1 用例应钉 `recurring && signals>=2`，不是「含 ③ 或 ④」 |

### 采纳方案二选一：**A 案（强化门禁与不变量回归）**

| | A 案（采纳） | B 案 |
|---|---|---|
| 成本 | 低：复用 834 tests / smoke / eval，补约 10 条断言 | 高：多平台真实语料、脱敏、人工标注一致率 100% |
| 收益 | 直接守住三条红线与 P0=0 | 提升 S1 裁定准确率 |
| 风险 | 真实语料下的识别准确率 / 漏标未覆盖 | MVP 投入产出比低、语料合规成本高、payload 仅余 17 不允许扩工具 |

理由：v0.5.0 是「可信度可观测」最小增量，三红线与不变量是最高风险面；S1 只读打标不改分、不删数据，误标不致损失；阈值调优本就排在 v0.6「自动化采集质量」（FF09 MVP 优先）。

## 一、量化门禁与命令清单

- **P0 bug = 0**；P1 需清单 + 责任人 + 书面豁免；核心链路通过率 **100%**（S1 只读打标 / S3 假出口 / `verify --quotes` / watch-once 退出 / install 只读）。
- 全量执行率 100%、通过率 ≥95%（基线 **834/834** 不得回退）。
- CLI 形态的「崩溃率」等价阈值：未捕获异常 = 0、`watch-once` 连续 100 轮非零退出率 = 0、活跃句柄残留 = 0。
- 性能：`sync` 1100 会话 ≤2s、session_id 读取 P95 ≤200ms（**新路径复测，不沿用旧结论**）、PROCESS.md ≤45,000 B、payload ≤12,300 且余量 ≥17、instructions ≤2,048。

**退出码两层，门禁判「该 0 时 0、该 2 时 2」**：

| 层 | 命令 | 期望 |
|---|---|---|
| 命令层（政策拒绝） | `omem verify --quotes` 有未命中 / `ProfileBlockedError` / `BackendUnavailableError` | **exit 2**（预期，不判失败） |
| 脚本层（失败） | `npm test` 834、`smoke.sh` 91-0、`eval:search` 8-8、`eval:capability` / `eval:quotes` PASS、`release-check --no-tag` 77 文件 dist:src 1:1、`mcp-probe` stdout 零日志 | 任一非 0 → **no-go** |

## 二、分层矩阵与 DoD 核实

| 层 | 覆盖 | 判据 |
|---|---|---|
| 单测 | automation-mark-readonly 7 / guide-budget 11 / guide-empty-state 2 / watch-once 7 / install-hooks-readonly 2 / cli-args 22 | 全绿 |
| 冒烟 | `tests/smoke.sh` 91 | MCP / install / sync 端到端 |
| 评测 | eval:search 8/8、eval:capability、eval:quotes | 检索与引文无回归 |
| 发布检查 | `release-check --no-tag` | dist 72 与 src 1:1、77 打包文件 |
| 手工回归 | 隔离 home 真实退出 / 非 ASCII home / work profile 零写盘 | 见第五节 |

**Roadmap §7「拟新增」两类均已落地并核实断言名**：`automation-mark-readonly.test.ts`（7 it）、`guide-empty-state.test.ts`（2 it）。既有 pin（dedup-rescore / revision-cas / evidence-layers / score-ladder / process-guide-refresh / collector-isolation / tool-budget / mcp-probe / quote-coverage / instructions-budget）全部存在。

**7 处断言缺口（A 案已全部补齐，2026-11-22）**：

| # | 缺口 | 优先级 | 落地用例 |
|---|---|---|---|
| 1 | metadata 围栏剥离（user 段中间插 `Conversation info` + JSON 围栏）；普通用户 JSON 不误剥；空 body / 短句 / 跨轮重复 | P0 | `automation-mark-readonly` A1 / A1b |
| 2 | 打标前后**字段级**不变（6 字段逐项）+ logs 不落用户原文 + 人工 skip 前不移出待办 | P0 | `automation-mark-readonly` A2 |
| 3 | 零引文 `hits=[]` / `ratio=null` / `n/a`；全引文库有 miss 时不得 100% | P0 | `automation-mark-readonly` A3 / A3b |
| 4 | 多轮 `deferCommit` 合并成 1 笔 `omem: sync --watch-once (N round(s))` + 台账清空 | P0 | `watch-once` A4（真实 git 仓） |
| 5 | 去抖只刷 `lastEvent`、最多首扫 + 一次复扫 | P1 | `watch-once` A5 |
| 6 | watcher 在静默窗/硬上限两条路径都 `close()`；异常路径台账可收走 | P0 | `watch-once` A6 |
| 7 | install 前后客户端配置字节快照一致、无备份/规则文件 | P0 | `install-hooks-readonly` A7 |

新增用例合计 9 条，另加 smoke S19 两条端到端断言。

## 三、新能力风险用例集

模板：编号｜优先级｜前置（隔离 `OMEM_HOME` + 固定 fixture）｜步骤｜预期·判据。正常流 N=8、异常流 E=13（E ≥ N/2）。

**① evidenceClaims 去噪**：`EVC-N1` 3 轮 user（命令块/反问）+ assistant 自述 → claims 恰 3 条、`lowSignal` 正确、助手 0 命中（已有）；`EVC-E1` ⚠ user 段中间插元数据围栏 → text 不含围栏/JSON 键、code point 区间正确、与 `evidenceUserText` 一致（待补）；`EVC-E2` 空 body / 仅 assistant / <12 字短句 / 跨轮重复 / 用户粘贴普通 JSON → 空数组不抛、短句标 `short`、只留首次、普通 JSON 不误剥（`session-store.ts:226` 白名单）。

**② classifySession 双信号**：`CLS-N1` 3 个近似周期（间隔 max/min ≤3）同指纹自动化 prompt → true 且含 `recurring-key`（已有）；`CLS-N2` 人工实质性陈述 → false（已有）；`CLS-E1` ⊘ ①+② 无③ / 恰 2 会话 / 3 会话但抖动 >3 / 间隔为 0 / 仅③无辅助 / ④单独 → 一律 false（按裁决 B 钉 `recurring && signals>=2`）。

**③ 只读打标字段级不变**：`RO-N1` refreshProcessGuide → 行尾 `(likely-automation: …)`、logs 含 `automation-mark`（已有）；`RO-E1` ⚠ 逐字段比对 `evidence` / `evidence_current` / `confidence` / `status` / `session_id` / `source_sessions`（待补）；`RO-E2` skip.json / 会话文件数 / knowledge/ / git log 均不变，人工 `omem skip` 前不移出待办。

**④ 引文溯源 hits**：`HIT-N1` 1 条命中 → `sessionId` 为落盘 id、`userKey` 16 位 hex、notice 含 `session <id>`（已有）；`HIT-E1` ⚠ 零引文 → `ratio=null`、`hits=[]`、`n/a` 非 100%（待补）；`HIT-E2` 引文被多篇包含 / 引用会话不含但全库他处命中 → 报真实来源、不报引用会话自身、不折叠大小写标点。

**⑤ 假出口修复**：`GUI-N1` 隐藏提示含 `search_memory(session_id=…)`、不含 `topic=`、probe ∈ hidden 且 ∉ visible（已有 2 条）；`GUI-E1` ⚠ 把 probe 代入 MCP 协议层 `search_memory(session_id=…)` → 隐含 `scope=sessions`（`tools.ts:527`）返回 quotable segments、无 assistant / 无围栏（现仅底层 `readSessionsById`+`userSegments` 验证，待补协议层）；`GUI-E2` sessions 空 / 0 隐藏 / Unassigned 隐藏 → 空态不抛、0 隐藏不出 probe、Unassigned 给真实 hidden id、会话行不泄绝对路径。

**⑥ watch-once 有界退出**：`WAT-N1` 无事件 `quiet-window` rounds=1；有事件 rounds=2、scans=[1,2] 复扫（已有）；`WAT-E1` 事件风暴 `hard-cap` elapsed ≤ cap、steps <20；`roots=[]` elapsed=0 无 watcher（已有）；去抖 ⚠；`WAT-E2` ⚠⊘ work profile 抛错 + 零写盘（退出码待裁决 A）、git log 仅 1 笔、台账清空、句柄 = 0、临时目录删除无 EBUSY。

**⑦ install --print-hooks 只读**：`INS-N1` exit 0、输出含片段 / `--hard-cap-ms 30000` / work profile / `omem only writes MCP config`（已有）；`INS-E1` ⚠ 调用前后客户端配置字节快照一致、无备份/规则文件、git status 干净（待补）；`INS-E2` 不带旗标 / work profile / 解析失败 → 不触发 hooks、打印手动片段不覆盖。

## 四、回归与兼容性

改 `guide.ts` + `pipeline.ts` 后最可能回归三处：

1. `runPipeline` 的 `beginWriteJournal` / `commitRun` 条件分支（`deferCommit`）→ auto-commit、sync-git「一轮一笔提交」与 `process-guide-refresh`。
2. `renderGuide` 新增打标与隐藏提示吃字节 → `guide-budget` 45,000 B 与 `shown+hidden+unassigned` 恒等式、guide-dedup-skip / guide-queue 会话行。
3. `commitWatchedRun` 与全局写台账 finally 收走 → auto-commit / concurrent-write 台账清空与并发写。

必须保持绿的既有 pin：dedup-rescore / revision-cas / evidence-layers / score-ladder / process-guide-refresh / collector-isolation / tool-budget / mcp-probe（`AGENTS.md` 点名 8 项）。

## 五、多端与环境覆盖（FF10）

omem 是 npm CLI + stdio MCP，无移动端。矩阵 = **Windows / macOS / Linux × Node ≥22.5（22.x 与 23.x 各一）× 非 ASCII home 路径**（instructions 2,038 字符最坏口径）**× profile**（home / work / `OMEM_PROFILE_LOCKED=1`）**× 隔离 OMEM_HOME**（`makeHome` / `cleanupHome`，绝不读写真实 `~/.omem` 与真实采集根）。

Windows 专项：`fs.watch` 句柄 `unref()`+`close()` 后进程必须退出；隔离临时目录 `index.close()` 后删除无 EBUSY；重复 100 轮无残留。

## 六、安全与合规（FF11）

`evidenceClaims` / `classifySession` 读用户原文、`appendLog('automation-mark')` 写 `logs/omem.log`。验证：logs/ 不入库、不外传、不进 git、不进 MCP stdout（`AGENTS.md:31`）；log items 仅含 count / session id / signals，**不落用户原文全文**；落盘前过 `redactSecrets`。

work profile 拦截验证点：抛错 + `knowledge/` 与 `sessions/` 零新增 + git log 无新提交 + 手动 `omem sync` 不受影响 + 退出码（裁决 A 待修）。

## 七、go/no-go 清单

- ☐ P0 = 0
- ☐ P1 有主 / 有书面豁免
- ☐ 核心链路 100%
- ☐ 全量 ≥95% 且 834 不回退
- ☐ 三套评测全绿
- ☐ 预算三上限（payload / instructions / PROCESS.md）
- ☐ watch-once 有界退出 + 零残留
- ☐ install 只读零落盘
- ☐ work profile 拦截
- ☐ MCP stdout 零日志
- ☐ 不变量 6 条（无 daemon / 无硬删 / 无第三 hash / 无 verified / 无规则提取 / 默认 2 工具）
- ☑ **裁决 A 已修复并补断言**（`ProfileBlockedError` / exit 2 / smoke S19 实测通过）

任一不满足 → no-go。**复核结果（2026-11-22）：全部满足 → GO。**

| 门禁 | 实测 |
|---|---|
| npm test | 86 files / **843 tests** 绿（基线 834，新增 9） |
| smoke | **93 passed / 0 failed**（新增 S19 两条） |
| eval:search / capability / quotes | 8/8 · PASS · PASS |
| payload / instructions / PROCESS.md | 12,283/12,300（余 17）· 1,976/2,038 ≤2,048 · ≤45,000 B |
| release-check --no-tag | OK（77 打包文件、dist 72 与 src 1:1） |
| work profile | `ProfileBlockedError` → **exit 2**，零写盘 |
| 不变量 6 条 | 无 daemon / 无硬删 / 无第三 hash / 无 verified / 无规则提取 / 默认 2 工具，全部保持 |

回访节点：发布前 1 周输出回归清单供核对核心链路；上线后 48h 核对远端 tag、非零退出与用户反馈；上线后 1 周核对缺陷趋势反哺研发与产品。

Bug 五要素：复现步骤、环境（OS / Node / OMEM_HOME / profile / 账号）、实际 vs 预期、截图日志、复现概率，缺项无效。

## 八、阶段复盘卡（Phase 2 → Phase 3）

- 完成度：100%（方案齐备、2 阻塞项已裁决、A 案 7 处断言补齐、全量门禁复核通过）
- 阻塞：无（原 P0 已修复闭环）
- 下阶段：Phase 3 上线发布方案（发版仍需单独显式授权）

## 九、下一步

v0.5.0 门禁已转 **GO**。建议进 Phase 3 上线发布方案；发版（commit / tag / push / npm publish）仍需单独显式授权。v0.4.0 上线后 48 小时回访节点尚未到期（11:58 推送），到时回来核对远端 tag 与用户反馈。
