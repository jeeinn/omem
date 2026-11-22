# Changelog

本项目的重要变更都会记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/) 2.0.0。

> 发布口径：每个版本对应一个精确 git tag（`v<version>`）。发布前
> `npm run release:check` 校验 dist 与 src 一一对应、无孤儿；`package.json`
> 未 bump 版本、或与 tag 不一致时 `prepublishOnly` 会直接拒绝发布。tarball
> 字节的 md5 含打包时间戳、不可复现，不作为一致性判据。
>
> 0.x 阶段（语义化版本的 initial development）minor 版本可能包含不兼容变更，
> 升级前请读本文件对应章节。

## [Unreleased]

暂无。

## [0.5.0] - 2026-11-22

可信度可观测 + 上下文预算（路线图见 [`docs/omem-v0.5-Roadmap.md`](docs/omem-v0.5-Roadmap.md)）。

> **版本跳跃提示**：`0.4.0` 只打了 git tag、未发 npm 包，本次 `0.5.0` 直接成为 `latest`。
> 从 `0.3.2` 升级会一次性拿到 0.4.0 与 0.5.0 两版变更；0.x 阶段 minor 可能含不兼容变更，
> 升级前请读本文件 `[0.4.0]` 与 `[0.5.0]` 两节。

### 新增

- **会话证据去噪与自动化识别（S1，只读）**：`evidenceClaims()` 按轮次列出 `## user` 段并标出低信号形状（命令块 / 反问句 / 过短），不做语义裁定、不改分；`classifySession()` 用「同指纹跨 ≥3 会话且近似周期」这一硬信号 + 至少一条辅助信号识别自动化例程会话，在 `PROCESS.md` 行尾标 `(likely-automation: …)`，判定依据写 `logs/`。标记不写 `skip` 台账、不删会话、不改任何 frontmatter；人工确认后显式 `omem skip`。
- **引文溯源（S1-c）**：`omem verify --quotes` 逐条报出命中引文的来源会话裸 `session_id` 与 `userKey`，可回溯复核；零新增工具与模块。
- **有界驻留采集（S2）**：`omem sync --watch-once [--quiet-ms N] [--hard-cap-ms N]`——先全量扫描 → 监听采集器根 → 静默窗无事件 → 复扫确认 → 退出；默认静默窗 2s、硬上限 30s（最大 120s），事件去抖抑制风暴，多轮扫描经 `deferCommit` 合并成一次 git 提交。**不是 daemon**：无常驻进程 / 跨进程锁 / 自启配置，watcher `unref()` 保证静默窗到期即退出。`work` profile 下显式拒绝自动入口（合规：避免把公司会话写进本地库），手动 `omem sync` 不变。`omem install --print-hooks` 只读打印接线片段，默认不装、不写客户端规则文件（遵守 install 六条写纪律）。

### 变更

- **可逆遗忘口径澄清（S4，只核查 + 文档，无新模块）**：确认 `stale × 0.5` 检索降权（`search.ts:84,99`）、`formatStaleness` 在 MCP/CLI/review/MEMORY-INDEX 五个输出面呈现 `not reviewed (cooled)`、`mergeEvidence` 8 条 / 2000 字符上限、`omem redact --yes` 为唯一硬删，均已在 v0.4.0 生效。README 补写「可检索性衰减 ≠ 删除」的说明；不引入时间衰减或遗忘算法。

### 修复

- **work profile 拦截的退出码（Phase 2 P0）**：`omem sync --watch-once` 在 work profile 下原抛 `UsageError`，被 `cli.ts` 映射为 exit 1（用法错误）；按 `AGENTS.md:30` 契约，政策拒绝应走 `ProfileBlockedError` → **exit 2**。已改正，并补异常类型、字段级零写盘、CLI 端到端（smoke S19）三重断言。
- **PROCESS.md 隐藏会话的「假出口」（S3）**：预算隐藏组此前提示 `search_memory(topic="<name>")`，但 `topic` 只走文档检索、取不到会话原文，Agent 看到标记也拿不到内容。现改为输出一条**真实被隐藏**的裸 `session_id`，指向已存在的 `search_memory(session_id="<id>")` 通道（零工具面税）；其余会话随本批收缩自动回到清单。Unassigned 隐藏行同样处理。新增断言钉住：提示里出现的工具 + 参数组合必须真能取到 `## user` 原文，probe 必须来自 hidden 集合。

## [0.4.0] - 2026-11-22

边界修复 + 可信度可观测（议题计划见 [`docs/archive/omem-v0.4-议题计划.md`](docs/archive/omem-v0.4-议题计划.md)）。

### 新增

- `omem search <query> --as-of <ISO|HEAD~N|sha>`：只读的历史检索视图。检索的是某个时点已提交进 git 的 Markdown，命中行带当时的正文与证据；历史版本显式标注只读、不能当写入基线（`path` 是 `rev:path` 形式的 git 对象引用、磁盘上不存在；`revision` 是 `snapshot:<sha>`，都不能当 `expected_revision` 写回）。仅作用于结论检索，与 `--sessions` 互斥；非 git 数据仓报后端不可用。MCP 侧对应 `search_memory` 的 `as_of` 参数。
- `omem verify --quotes`（v0.4.0 T1）：逐字引文覆盖率审计。校验 `evidence_current`（旧文件无该字段时退回 `evidence`）是否为某篇 `## user` 原文的严格逐字子串——不大小写折叠、不归一化标点，助手的回答永不作证据；命中扫描全库会话（不只 `session_id` 那一篇），避免台账漏记造成假未命中。检查范围是 `active` + `source=agent` + 未经人工过目的条目。合法零引文条目（0.35 ungrounded）单列、不进分母、不判失败；全库零引文时覆盖率显示 `n/a` 而非 100%。结果写入 `logs/omem.log` 的 `quote-coverage` 行；有未命中时该命令退出码 2（政策拒绝），不带旗标时 `verify` 行为与 `0.3.2` 完全一致（永远返回 0）。发布门禁跑 `tests/eval/quote-coverage.json` 固定 fixture（隔离 `OMEM_HOME`），`npm run eval:quotes` 可单独复跑。
- 检索与引文评估基线：新增 `npm run eval:capability`（四能力用例集 + 固定 golden）与 `npm run eval:quotes`（引文覆盖率 fixture）。改动检索行为前先跑基线；评估脚本隔离 `OMEM_HOME`，不扩 MCP 工具面。

### 变更

- Agent 指引进多跳检索口径：新增 `RULE_MULTIHOP` 常量——多跳问题逐个查子问题（关键词 AND 匹配，合成一个查询会零命中），问历史值用 `as_of` 复查同一查询。该常量同时进入 MCP `initialize.instructions` 与 `omem context --for` 的导出标记段。
- MCP `initialize.instructions` / `omem context` 指令文案压缩到 ≤2048 字符（按字符计量，取非 ASCII home 路径的最坏口径）。契约不变：`PROCESS.md` 路径、六步工作循环、三条规则常量都在场；新增 `tests/unit/instructions-budget.test.ts` 同时钉住预算与契约。

## [0.3.2] - 2026-11-13

### 新增

- `evidence_current` 字段：每次写入只放本次提交的引文（没带引文写空数组）。计分与 `omem verify` 在该字段在场时只认这一层；旧文件（无该字段）仍按 `evidence` 复算，直到下一次覆写；补分会换掉当前层。五档分数与去重四边界未改。
- 审阅页分栏显示 Current evidence 与 Historical evidence；检索命中带回当前层。

### 变更

- 写入护栏收口（S1-1）：D3 `expected_revision` 与 D4 `needs-reactivation` 校验移到 content-hash 去重之前；同 topic 的归档 / 冷却文档不再被普通去重吞掉；补分（rescore）会刷新 `PROCESS.md`。
- 覆写后分数下降时，CLI 与 MCP 回执写明 `evidence_current` 换成了这次的引文（没有引文就是空的）；`omem verify` 的漂移行标明复算用的是当前层还是旧链；当前层为空导致的偏高不再说成「会话被删」。
- 计划文档归档：路B 重构方案、`omem process` 方案、v0.3 实施计划移入 `docs/archive/`；现行规则以 `AGENTS.md` 为准。

> **验证口径**：`npm test` 78 files / 786 tests 绿；`tests/smoke.sh` 91 passed / 0 failed。

## [0.3.1] - 2026-11-06

### 新增

- `omem process`：只加工已经落盘的会话队列，不扫采集器；`--dry-run` 零网络；提交说明是 `omem: process …`。

### 变更

- `omem sync` 与 API 加工拆开：`sync` 只采集会话并刷新 `PROCESS.md`，不调用模型；`[process] default_tier = "api"` 也不会让裸 `sync` 去 drain 队列（终端会提示改用 `omem process`）。
- `omem sync --tier api` 仍可用一期：打印弃用警告，并且只跑 process、不再采集；请改用 `omem process`。
- 命令面从 13 条变为 14 条，其余行为与 `0.3.0` 相同。

> **验证口径**：`npm test` 77 files / 770 tests 绿。

## [0.3.0] - 2026-11-06

npm `latest` 此前停在 `0.1.0-beta.8`；`v0.2.0-beta.1` 只存在于 git tag、没有发到 registry。本版把 v0.2 身份模型与 v0.3 的 S0–S5 一次发到 `latest`。从 v0.1 升级用 `omem init --force` 重建（先自动快照），没有迁移脚本。

### 新增

- 检索命中带回结构化证据与时间信息。
- `expected_revision` best-effort 版本比对（D3）：`search_memory` 的 `revision` 是整份 Markdown 全文 sha256 前 32 位（与 `index.hash` 同口径），写回 `save_memory` / `omem add --expected-revision`；不一致返回 `stale-revision`，不写盘、不提交。读-比-写之间仍有窗口，本版不做文件锁。
- 覆盖已有文档时，回执带 previous / incoming 预览。

### 变更

- 归档 / stale 不会被静默复活：写入 `archived` 或 `stale` 的 topic 返回 `needs-reactivation`，不落盘、不提交；恢复必须显式（CLI `--reactivate`，MCP `reactivate: true`）。`omem review --confirm` 只提置信度，不改 status。
- 去重命中只升不降：正文已存在时，四条件同时成立才重算 `confidence`（同 topic、至少一条 evidence、`confirmations === 0`、分数严格更高），只改 frontmatter、正文一字不动。补采之后把同一正文连同能锚上的引文再发一次，可以把 0.35 补上来。
- `omem redact --topic` 默认只预览；`--yes` 才硬删，并说明 git 历史与远端备份仍在。
- S6（证据分层与评分模型重构）不在本版、推迟到 v0.4：五档阶梯与去重四边界保持 v0.2 口径；人工确认表示这个主题曾被看过，不表示当前正文已被逐项验证。
- npm `latest` 跳到本版；`beta` dist-tag 一并指到 `0.3.0`，避免继续装到 `0.1.0-beta.8`。

### 修复

- `[collect].exclude_paths` 会挡住采集。
- 回执不再指向已删除的命令。

> **验证口径**：`npm test` 77 files / 768 tests 绿；`tests/smoke.sh`（Git Bash）83 passed / 0 failed。发布时 `prepublishOnly` 再跑 `build` + `test` + `release-check`（要求 HEAD 精确 tag 为 `v0.3.0`）。

## [0.2.0-beta.1] - 2026-11-01

> **不兼容（breaking）**：v0.1 的库直接 `omem init --force` 重来（重置 git 前自动打一份快照），**没有迁移脚本**。理由：这一版的目标是把项目变小，搬迁脚本会把旧模型原样搬进新模型。

### 新增

- **topic 就是身份，就是文件名**：路径改成 `knowledge/<domain>/<topic>.md`，frontmatter 里不再写 topic。删掉 `id` 命名空间、年份分桶、`superseded` 状态机与 `supersedes` 入参；`omem add` 与 `save_memory` 的 `topic` 变必填（一次性记忆也一样）。带同一个 topic 再写一次就是整篇覆盖那份文件，版本链交给 git。
- **`omem verify` 做账本复算**：重建内存视图 + 重渲染 `MEMORY-INDEX.md`，并用账本重算每条自动分条目、与落盘值比对；只报告差异、不改写（自动改写会让 git 历史每次抖动，且「谁该赢」不是机器能判的）。
- **写前快照**：覆盖一份已有活文档之前自动打快照（`snapshots/`，滚动保留 7 份）；`init --force` 重置 git 前也打一份。git 历史仍是最终退路。
- **`PROCESS.md` 拆两段**：`## Projects` 收待办（按项目指纹分组，组标题降为 `###`），`## Topics` 收词表并带所属项目——Agent 不再把项目指纹当主题名用。

### 变更

- **没有索引数据库**：SQLite / FTS5 删除，索引改为每次启动从 Markdown 重建的内存视图（`Map<topic, row>`）。会话只索引 `## user` 证据域、按需构建；检索从「SQLite + bm25」换成线性扫描 + 确定性排序（命中词数 → 置信度 → `last_confirmed`）。一并删掉 WAL、跨进程锁、迁移脚本与双 hash 对账。实测：1100 份会话冷启动 `stat` 131 ms、证据域全量扫描 1.4 ms、检索 1–2 ms。
- **信任只有一个数字**：`verified` 字段删除（D2），过目改由 `confirmations > 0` + `last_confirmed` 表达；`save_memory` 的 `confirm_ids` 删除——MCP 侧不再有盖章通道，过目只由人在 `omem review` 里做（提到 0.9）。
- **命令面收敛到 13 条**：删 `eval` / `api` / `audit` / `context` / `gc` / `snapshot` / 主题级审阅策略；`rebuild` → `verify`；`gc` 并入 `review --gc`；`snapshot` 并入 `backup`；`redact --id` → `redact --topic`。
- **印证按独立来源计数**：同一段用户输入被同步两次、或两个采集器收了同一次对话，只算一份（来源会话自己的指纹先占位，副本也不算印证）；两次不同的表达里出现同一句引文，仍算两份。
- **没有 `review.toml`**：主题级审阅策略（`once` / `never`）删除，人工动作只剩过目 / 归档 / 冷却。
- **补丁轮**：列表型旗标兼容 Windows PowerShell shim——`--target` / `--collectors` / `--confirm` / `--tags` 按 `[,\s]+` 切分，逗号与空格两种壳子都认（此前 `omem install --target claude-code,cursor` 会报 `Unknown client: claude-code cursor`，错误信息还看不出真实原因）。
- **补丁轮**：启动成本降了一半——MCP SDK（单独 import 实测 252 ms）与 web 面板（49 ms）改为按需加载；`omem --version` / `omem topics` / `omem review` 从约 490 ms 降到 230 ms（node 裸启动 116 ms）。
- **补丁轮**：会话检索的命中计数零分配优化（`split(t).length - 1` 换成 `indexOf` 循环，排序语义不变）。
- **补丁轮**：采集器不再为「明显不是仓库」的目录 fork git 子进程（cwd 向上找不到 `.git` 就直接用本地指纹兜底，判定口径与 git 自己的仓库发现一致）；合成语料 1100 份实测 `omem sync` 从 88 s 降到秒级。
- **补丁轮**：`omem review --ui` 的等待提示按真实超时显示（3 秒超时不再写成 "timeout 1m"）。
- **补丁轮**：`tests/smoke.sh` 在 Windows 检出下也能真跑（新增 `.gitattributes` 强制 `*.sh` 与 `bin/omem.js` 以 LF 落盘；此前在 `core.autocrlf=true` 的检出里脚本第 8 行就死在 CRLF 上，`npm run smoke` 看着 exit 0、实际一行业务都没跑）。

### 修复

- **补丁轮**：`omem --help` 的文档链接指向实际存在的文件（现为 `docs/README.md` 索引）。
- **补丁轮**：同步后端的文案不再承诺「V0.2 会交付 WebDAV」——git 是本版本唯一可用后端，`webdav` / `dir` 被调用时给出可操作提示（`omem backup use git`）。
- **补丁轮二**：`omem skip <id> --reason <理由>` 静默丢掉旗标值的缺陷修复——`reason` 注册进 `VALUE_FLAGS`（四种合法理由 noise / duplicate / no-value / agent-authored 不再形同虚设）；防漂移守卫补第二条腿：扫 `typeof flags.X === 'string'` 这类读法，要求这些 key 都在 `VALUE_FLAGS` 里。

> **验证口径**：`npm test` 全绿（69 files / 691 tests，补丁轮后 699–702）；`npm run build` 干净；`npm run smoke` 75 passed；`node scripts/release-check.mjs` 在打 tag 后通过（dist 与 src 一一对应、无孤儿、包内容精确）。

## [0.1.0-beta.9] - 2026-10-29

### 新增

- **`search_memory` 新增 `session_id` / `offset` / `limit`**：按清单里的裸 id 直接取回 `## user` 段的可复制原文 + 每段字符范围 + assistant 段计数（不进正文）。这是清单去掉路径之后的唯一读取通道。
- **每次写入进本地 git 历史**（`[process] auto_commit = "session"`，默认开）：一次工具调用 / 一次 `omem add` 结束一次提交，提交精确覆盖本次写过的文件（由写入台账在 `atomicWrite` 记账，不再退回 `git add -A`、也不漏掉 `PROCESS.md` / `review.toml` / `config.toml`）；回执的 `vcs.residue` 如实列出本次写之外的脏路径。会话原文的批量入版本仍由 `omem backup` 负责。代价：单次写入多约 0.3–0.43 s（1,101 份会话的数据仓实测 0.22 s → 0.50 s 稳态）。不需要版本历史可设 `auto_commit = "off"`；非 git 数据仓静默跳过并在回执里说明（`vcs` 字段）。
- **`omem --version` 带 short commit**（`0.1.0-beta.9+1a2b3c4`）；`prepublishOnly` 增加版本 / tag 一致性与打包内容断言。
- **`omem add --force` 的强制截断可审计**：磁盘上不留标记（不加 frontmatter 字段、不加 tags），但回执会给出该文件的 id，并把 `truncated:{chars,limit}` 写进 `logs/omem.log` 的 commit 事件——过一周也查得出「这条是被截断的」。
- **grounding 证据域扩到整段**：`## user` 段内任意位置的 `Conversation info / Sender (untrusted metadata)` 围栏块都会被剥掉（真实仓 22 个非段首围栏全部覆盖），用户自己粘贴的代码/JSON 原样保留。

### 变更

- **`omem add` 对超长正文改为拒绝（CLI 行为变更）**：正文超过 `[process] max_content_chars`（默认 2000）时不再静默截断落盘，而是不写入并给出超限量、溢出片段预览与两条出路（压缩到限内重发 / 拆一个更窄的 topic）。要保留旧的截断行为，加 `--force`（截断后落盘，仍是半截事实，只作为逃生口）。为什么改：截断落在尾部，而新事实总在尾部——半截事实会被下一个 Agent 当真事实检索。
- **`save_memory` 同理：超限拒绝、不再截断**：回执四段——超限字数 / 旧文档仍 `active` 且未被改动 / 溢出片段预览（仅回执可见，不落盘）/ 两个出口。
- **`PROCESS.md` 瘦身**：会话行只留裸 `session_id`（不再带绝对路径与采集器名——路径曾占旧体积 50.7%）；`## Existing topics` 全量列出（含 id）；头部与工具描述去重。渲染预算 45,000 B（判据是宿主 `Read` 的 `字符数÷4 > 20000`，45,000 留 44% 余量），超限按固定阶梯降级，每个被裁的组都带自己的 `…N session(s) hidden by the size budget` 标记，`Unassigned sessions` 同样带标记。真实规模（546 会话行 + 58 topic）实测 0 隐藏。
- **`(copy: N)` → `(same-user-text: N)`**：同一 `## user` 指纹的 N 份会话只共享用户说的话，各自的回答不同（实测 25/26 组 assistant 段实质不同）；原文案说「提炼列出的那一份就覆盖全部」，按它操作最多静默丢 24 份独立结论。
- **「已吸收」口径更诚实**：`N unabsorbed` 这个数会变大。此前「已吸收指纹」会把同指纹兄弟组的其余 N−1 份一起移出待办（最多 ≤143 份从未被读取就被标记为已处理）；现在它们仍留在待办里，折进同一行、`same-user-text` 递增，不新增行。
- **supersede 掉一份 verified 文档时，回执写明代价**：旧的 `confidence` 数值与旧 id 都出现在回执里（此前一个字都不提）。

> **验证口径**：`npm test` 全绿（68 files / 716 tests）；`npm run smoke` 74 passed；`node scripts/release-check.mjs` 在打 tag 后通过（dist 与 src 一一对应、无孤儿、包内容精确）；PROCESS.md `Read` 一次读完（真实 1,101 份会话实测 875 行 / 41,230 B ≤ 45,000 B）。

## [0.1.0-beta.8] - 2026-10-28

### 修复

- 清单渲染回归（16.3×）、cap 截断、grounding 元数据可伪证。

> 更早的 `0.1.0-beta.3` – `0.1.0-beta.7` 为快速迭代期，未留档逐版发布说明；变更明细见对应 git tag。

[Unreleased]: https://github.com/jeeinn/omem/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/jeeinn/omem/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jeeinn/omem/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/jeeinn/omem/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jeeinn/omem/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeeinn/omem/compare/v0.2.0-beta.1...v0.3.0
[0.2.0-beta.1]: https://github.com/jeeinn/omem/compare/v0.1.0-beta.9...v0.2.0-beta.1
[0.1.0-beta.9]: https://github.com/jeeinn/omem/compare/v0.1.0-beta.8...v0.1.0-beta.9
[0.1.0-beta.8]: https://github.com/jeeinn/omem/compare/v0.1.0-beta.7...v0.1.0-beta.8
