# omem V0.1 实施计划（MVP）

> **归档**（2026-10-26）：对应工作已经落地。本文只留作记录，不再作为开工依据。现行行为以 [`docs/archive/omem-V0.1技术规格草案.md`](omem-V0.1技术规格草案.md) 和源码为准。
>
> 版本：v1.0 · 日期：2026-10-15 · 状态：**已批准，实施中**
> 上位文档：`docs/` 下四份规划文档（产品规划 v0.4 / 评估报告 v1.4 / 技术规格 v0.2-draft / 组件复用清单 v1.0）
> 本文职责：把上述文档转化为**可执行的工程计划**——目录结构、模块拆分、开发顺序、验收标准。

---

## 1. MVP 需求边界（四文档综合裁定）

裁定规则（沿用规格 §12）：战略（做什么/不做什么）以**评估报告 v1.4** 的"不做清单"为准；接口（命令/工具/数据契约）以**技术规格 v0.2-draft** 为准；产品规划 v0.4 为背景与愿景。

### 1.1 In-scope（V0.1 必做）

| # | 能力 | 具体内容 | 文档依据 |
|---|---|---|---|
| 1 | **md 事实源存储** | `knowledge/<domain>/<YYYY>/<id>.md`，一条记忆一个文件；frontmatter 15 字段契约（id/type/domain/profile/status/confidence/verified/source/session_id/created/supersedes/superseded_by/last_confirmed/confirmations/tags/project） | 规格 §2.1/§2.2 |
| 2 | **可重建索引** | SQLite + FTS5 trigram；content-hash 一致性；外部编辑检测→增量重建；`omem rebuild` 全量重建 | 规格 §2.3；评估 4.4-4 |
| 3 | **采集：仅 Claude Code** | 只读解析 `~/.claude/projects/**/*.jsonl`，Unified Session Schema，过滤 sidechain/summary | 评估 4.2；规格 §7 |
| 4 | **加工四档（默认零配置）** | 档 0 规则抽取（默认，产 `verified:false` 候选）；档 1 Agent `save_memory`；档 2 Agent 协作加工引导（`--tier agent` 打印引导）；档 3 自带 API key 可选开关（默认关）。**首次运行零 key 提示** | 规格 §9.4；评估 4.4-3 |
| 5 | **MCP 最小工具面** | `search_memory`（query/domain/project/detail，top-3 摘要行 <300 token）+ `save_memory`（幂等 content-hash 去重）；`memory_feedback` 默认不列（`OMEM_MCP_TOOLS=feedback` 开启）。返回附时效标注 | 规格 §8；评估 4.2/4.4-7 |
| 6 | **被动注入热层** | `MEMORY-INDEX.md`（≤80 行，派生视图，rebuild 时重生成） | 规格 §2.1；规划 5.4-3 |
| 7 | **上下文导出** | `omem context --for claude-code\|cursor\|codex\|plain` | 评估 4.2/4.5 |
| 8 | **SyncBackend 抽象 + GitBackend** | `omem sync`（pull→push 一条命令）/ `status` / `use` / `remote`；冲突只报告不自动合并（`.conflict.md` 另存，本地版保留）；webdav/dir 后端 V0.2（接口预留，调用给可操作提示） | 规格 §5；评估 4.9 |
| 9 | **生命周期四层三机制** | L0 热/L1 active/L2 stale（降权 ×0.5 + 时效标注）/L3 archived（默认不进结果）；supersede（V0.1 必做）+ reconfirmation（轻量）；**永不自动删除**；`omem gc` 只标记；`omem redact` 唯一硬删 | 规格 §4 |
| 10 | **CLI 全命令面** | init/install/run/add/search/review/gc/rebuild/context/sync/profile/pause/resume/redact/snapshot/serve/audit；退出码 0/1/2 语义 | 规格 §7 |
| 11 | **install 自动接线** | 客户端注册表（9 类，workbuddy 路径本机已核实）；只 merge 不覆盖、先备份、原子写、幂等、JSONC 容错降级；marker-fenced 指令段写入 `~/.claude/CLAUDE.md` | 规格 §6 |
| 12 | **安全基线** | 脱敏正则（OpenAI/Anthropic key、JWT、PEM，NOTICE 署名 lore）；禁区（exclude_paths/keywords）；work profile 禁导出/同步；指令式语气低权（防投毒第一关）；每日快照滚动保留 7 份 | 评估 4.2/4.5/第 8 章 |

### 1.2 Out-of-scope（V0.1 明确不做）

| 不做 | 原因 | 去向 |
|---|---|---|
| GUI / 桌面壳 / 审查 UI | 命令行够用；Obsidian/VS Code 即审查 UI | V0.3 按数据决断 |
| 自建同步 relay 服务器 | 运营责任不可承受 | **永不** |
| 自建合并算法 | md 分文件冲突面天然小 | 永不（`.conflict.md` 交人读） |
| 自动删除记忆 | git 不丢历史；"记忆自己消失"制造恐惧 | 永不 |
| 向量检索 / 本地 embedding | 不背 100MB–2.2GB 模型分发 | V0.2 可选开关（golden set 对比后定） |
| 其他 Agent 采集器（Cursor/Codex/浏览器扩展） | 格式漂移风险；单工具验证假设 | V0.2+（适配器接口预留） |
| 跨会话全局合并 / 冲突消解自动化 / 时间衰减 | 个人记忆规模小，检索即过滤；衰减易误伤 | V0.2 再评估 |
| 团队/多用户、get_skill、memory_feedback 默认列、审计 UI | 范围收窄 | V0.3 生态化 |
| MCP sampling | Claude Code Issue #1785 未关闭，V0.1 不可用 | 持续跟踪 |

### 1.3 唯一核心验证目标

> **单工具（Claude Code）会话 → 加工 → 跨 Agent/跨会话检索，能否稳定打赢三个 dumb baseline**（无记忆 / Claude Code auto memory / 手工 MEMORY.md）。
> MVP 不是产品，是**实验装置 + 个人工具**（评估 4.1）。三道闸门：G1 技术可行（W2）/ G2 质量（W8）/ G3 外部（W12）。

---

## 2. 技术 Spike 结论（2026-10-15 实测，G1 第一项）

| 待验问题 | 结论 | 影响 |
|---|---|---|
| Node 22 内建 `node:sqlite` 是否可用？ | ✅ 可用（需 `--experimental-sqlite`；SQLite 3.51.2）。**不采用 better-sqlite3**——避免 Windows 原生编译风险，零原生依赖 | 运行时用 `bin/omem.js` 包装器自 re-exec 注入 flag |
| FTS5 trigram 对中文是否有效？ | ✅ 有效，但是**子串/短语匹配语义**：查询 ≥3 字符走 `MATCH '"..."'`（多词以引号 AND）；**<3 字符（2 字关键词）必须 LIKE 兜底** | 规格 §4.4 决策 1 预判正确；搜索模块实现双路降级 |
| npm registry 可达？ | ✅ `@modelcontextprotocol/sdk@1.32.1` 可装 | MCP server 用官方 TS SDK |
| 多词查询语义 | trigram 下 `"A B"` 要求 A、B 连续共现；按空白切分后逐词加引号得 AND 语义（符合个人记忆检索直觉） | 查询构造规则写入 search 模块 |

**遗留待验（不阻塞编码）**：规则抽取召回率（并入 Q1 对照组）；真实 Claude Code JSONL 样本回归（本机无 `~/.claude/projects` 时用合成 fixture + 标注"未经真实数据验证"）。

---

## 3. 项目目录结构

### 3.1 代码仓库（本仓库，X:/omem）

```
omem/
├── bin/
│   └── omem.js                # ESM 包装器：re-exec 注入 --experimental-sqlite
├── src/
│   ├── cli.ts                 # 入口：参数解析、命令分发、退出码
│   ├── commands/              # 13 个命令，一个文件一个命令
│   │   ├── init.ts install.ts run.ts add.ts search.ts review.ts
│   │   ├── gc.ts rebuild.ts context.ts sync.ts profile.ts
│   │   ├── pause.ts redact.ts snapshot.ts serve.ts audit.ts
│   ├── core/                  # 与命令无关的核心域
│   │   ├── config.ts          # config.toml（TOML 子集）读写 + 默认值
│   │   ├── paths.ts           # OMEM_HOME 解析、目录骨架
│   │   ├── entry.ts           # Frontmatter 契约 + md 序列化/解析 + title/summary 派生
│   │   ├── store.ts           # knowledge/archive md 文件 CRUD、原子写
│   │   ├── index.ts           # SQLite FTS5：schema/upsert/catch-up/rebuild
│   │   ├── search.ts          # 检索引擎：trigram MATCH + LIKE 兜底 + stale 降权
│   │   ├── lifecycle.ts       # supersede/gc/reconfirm/MEMORY-INDEX 生成/时效标注
│   │   ├── redact.ts          # 密钥脱敏正则（NOTICE 署名 lore）
│   │   ├── profile.ts         # work/home profile 守卫
│   │   ├── snapshot.ts        # 每日快照 + 滚动保留 7 份
│   │   └── log.ts             # JSONL 使用日志（MCP 调用/run 摘要）
│   ├── collect/
│   │   ├── types.ts           # Unified Session Schema
│   │   ├── claude-code.ts     # ~/.claude/projects JSONL 解析（只读）
│   │   └── collector.ts       # 采集器注册表 + 扫描（V0.1 仅 claude-code）
│   ├── process/
│   │   ├── rules.ts           # 档 0：规则抽取（正则 + 模板 + 指令式语气低权）
│   │   ├── pipeline.ts        # 会话→候选→条目：脱敏/禁区/profile 过滤/去重/落盘
│   │   ├── guide.ts           # 档 2：Agent 协作加工引导（打印式，零配置）
│   │   └── api.ts             # 档 3：OpenAI 兼容 API 加工（默认关）
│   ├── sync/
│   │   ├── backend.ts         # SyncBackend 接口 + 注册表 + 错误类型
│   │   └── git.ts             # GitBackend（init/push/pull/status，冲突 .conflict.md）
│   ├── mcp/
│   │   ├── server.ts          # MCP stdio server（官方 SDK）+ connect-time catch-up
│   │   └── tools.ts           # search_memory/save_memory/memory_feedback 定义与处理
│   ├── install/
│   │   ├── clients.ts         # 客户端注册表（9 类路径 + 检测 + 结构形态）
│   │   └── writer.ts          # merge-only 写入：备份/原子写/幂等/JSONC/marker 段
│   └── context/
│       └── export.ts          # omem context --for <agent> 四目标
├── tests/
│   ├── smoke.sh               # 端到端冒烟（隔离 OMEM_HOME）
│   └── mcp-probe.mjs          # 裸 JSON-RPC 探针：initialize/tools/list/tools/call
├── docs/                      # 四份规划文档 + 本实施计划
├── package.json tsconfig.json .gitignore README.md NOTICE
```

### 3.2 运行期数据目录（~/.omem，由 `omem init` 创建；测试用 `OMEM_HOME` 隔离）

```
~/.omem/                       # ← 这整个目录是一个 git 仓库（GitBackend.init）
├── .gitignore                 # index/ snapshots/ logs/ 不进版本控制
├── config.toml                # 唯一配置入口
├── knowledge/<domain>/<YYYY>/<id>.md   # ★ 事实源（进 git）
├── archive/<domain>/<YYYY>/<id>.md     # 归档（仍在版本控制内）
├── index/omem.db              # 可重建索引（omem rebuild）
├── snapshots/YYYY-MM-DD/      # 每日快照，滚动保留 7 份
├── logs/omem.log              # JSONL 使用日志
└── MEMORY-INDEX.md            # L0 热层派生视图（≤80 行，进 git）
```

**关键架构决策**：代码仓库与数据仓库分离。代码仓库管"程序"，数据仓库管"记忆"——后者才是规格所说"事实源是 git 仓库"的本体。

---

## 4. 功能模块拆分

### 4.1 模块总表（标注依赖与对应文档条款）

| 模块 | 职责 | 依赖 | 规模估计 | 文档依据 |
|---|---|---|---|---|
| M0 骨架 | package/tsconfig/cli 分发/config/paths | — | ~250 行 | 规格 §3/§10 |
| M1 数据模型 | entry.ts（frontmatter 15 字段 + YAML 子集）+ store.ts（md CRUD/原子写） | M0 | ~300 行 | 规格 §2.2 |
| M2 索引与检索 | index.ts（三表 + trigram + catch-up）+ search.ts（双路 + stale 降权 ×0.5） | M1 | ~350 行 | 规格 §2.3；评估 4.4-1/4 |
| M3 采集 | claude-code.ts（JSONL 只读解析）+ collector.ts（注册表）+ types.ts（USS） | M0 | ~250 行 | 评估 4.5 采集器 |
| M4 加工 | rules.ts（档 0）+ pipeline.ts（脱敏/禁区/profile/去重）+ guide.ts（档 2）+ api.ts（档 3） | M1 M3 | ~400 行 | 规格 §9.4；评估 4.5 加工器 |
| M5 CLI 核心 | init/add/search/run/review/gc/rebuild | M1–M4 | ~450 行 | 规格 §7 |
| M6 热层与导出 | lifecycle.ts（supersede/gc/reconfirm/INDEX）+ context/export.ts | M1 M2 | ~300 行 | 规格 §4；评估 4.2 |
| M7 同步 | backend.ts（接口/注册表）+ git.ts + snapshot.ts + sync 命令 | M0 M1 | ~400 行 | 规格 §5 |
| M8 MCP | server.ts + tools.ts（2+1 工具、时效标注、调用日志） | M1 M2 M6 | ~300 行 | 规格 §8 |
| M9 install | clients.ts（9 类注册表）+ writer.ts（写入纪律六条）+ marker 段 | M0 | ~350 行 | 规格 §6 |
| M10 收尾 | README/NOTICE/smoke/git commit | 全部 | — | 组件清单 §6 |

合计约 **3350 行**（含注释），落在规格预估的 3–5k 行区间下半段。

### 4.2 关键接口签名（先定契约，后写实现）

```ts
// 存储（M1）
writeEntry(entry: Entry): Promise<string>          // 返回文件路径
readEntry(path: string): Promise<Entry>
findById(id: string): Promise<{ entry: Entry; path: string } | null>
listEntries(opts?: { includeArchived?: boolean }): Promise<Located[]>

// 索引（M2）
upsertEntry(entry: Entry, path: string): void
catchUp(): { scanned: number; reindexed: number }  // (size,mtime)+hash 对账
rebuild(): { total: number }                        // 全量重建 + 重生成 INDEX
search(q: SearchQuery): SearchHit[]                 // trigram MATCH / LIKE 兜底

// 加工（M4）
extractCandidates(msg: UnifiedMessage, ctx): Candidate[]   // 档 0 规则
runPipeline(opts: RunOpts): RunReport                      // 会话→条目全流程

// 同步（M7）
interface SyncBackend { id; init(); push(); pull(); status(); }  // 规格 §5.2 契约
```

### 4.3 数据契约要点

- **frontmatter 15 字段**：`id`（`YYYY-MM-DD-xxxxxx`）、`type`（preference/fact/decision/experience）、`domain`（coding/general/…）、`profile`（work/home）、`status`（active/stale/superseded/archived）、`confidence`、`verified`（人工确认前恒 false）、`source`（rules/agent/llm/manual）、`session_id`、`created`、`supersedes[]`、`superseded_by`、`last_confirmed`、`confirmations`、`tags[]`、`project`（项目指纹，可选）。
- **一条记忆 = 一个文件**：git diff 可读、冲突面小、Obsidian 直开、误删单条不波及全局（规格 §2.1）。
- **md 权威，索引是缓存**：任何时刻删 `index/omem.db` 都能 `omem rebuild` 完整恢复（规格 §2.3）。
- **MCP 返回附时效标注**：`[2026-03-12] 标题 ——记录于 7 个月前，未再确认`（规格 §4.4），把判断权交给消费者。

---

## 5. 开发顺序（对齐 12 周计划 W3–6「V0.1 核心」）

> 顺序原则：**数据契约 → 存储 → 索引 → 采集 → 加工 → 命令 → 暴露 → 同步 → 收尾**。每一模块完成即自测（`npm run build` + 冒烟命令），不批量埋雷。

| 序 | 模块 | 内容 | 出口自测 |
|---|---|---|---|
| 1 | M0 骨架 | package.json/tsconfig/bin 包装器/cli 分发/config/paths | `omem help` 退出码 0 |
| 2 | M1 存储 | entry 序列化/解析、store CRUD、原子写 | `omem add` + 读回 frontmatter 一致 |
| 3 | M2 索引 | schema/upsert/catch-up/rebuild/search（含 2 字 LIKE 兜底） | `omem search` 中英混合命中；删 db 后 rebuild 恢复 |
| 4 | M3 采集 | claude-code JSONL 解析 + USS + 项目指纹 | 合成 fixture 解析出 N 条 user 消息 |
| 5 | M4 加工 | 规则抽取 + pipeline（脱敏/禁区/profile/去重） | 合成会话抽出候选，密钥串被脱敏 |
| 6 | M5 CLI | init/run/search/review/gc/rebuild/add | 全链路冒烟（tests/smoke.sh 前半） |
| 7 | M6 热层 | MEMORY-INDEX 生成 + context 导出 | INDEX ≤80 行；`--for cursor` 产出 .mdc |
| 8 | M7 同步 | SyncBackend + GitBackend + snapshot | `omem sync` 在临时数据仓 pull/push/status |
| 9 | M8 MCP | server + 3 工具 + catch-up + 日志 | mcp-probe 握手 + tools/call 全通过 |
| 10 | M9 install | 注册表 + writer 六纪律 + marker 段 | `--print-config` 输出正确；重复运行幂等 |
| 11 | M10 收尾 | README/NOTICE/完整冒烟/初始 commit | smoke.sh 全绿 |

**与周计划映射**：序 1–5 ≈ W3–4（采集→加工→存储），序 6–9 ≈ W5–6（命令→暴露→同步），序 10–11 ≈ W6 收尾并进入 W7–8 质量收敛（Q1/Q2 实验的数据采集由 M8 调用日志 + `omem audit` 支撑）。

---

## 6. 验收标准

### 6.1 冒烟清单（tests/smoke.sh，全部自动断言）

| # | 场景 | 断言 |
|---|---|---|
| S1 | `omem init --no-scan`（隔离 OMEM_HOME） | 目录骨架 + config.toml + 空 INDEX 生成；退出码 0 |
| S2 | `omem add` 一条 + `omem search`（≥3 字） | 命中该条；输出含时效标注 |
| S3 | `omem search`（2 字关键词） | LIKE 兜底命中（trigram 不失效） |
| S4 | 外部手改 md → `omem search` | catch-up 检出并返回新内容 |
| S5 | 删 index/omem.db → `omem rebuild` | 条目全量恢复，INDEX 重生成 |
| S6 | `omem run`（合成 fixture） | 产出 verified:false 候选；密钥串被脱敏 |
| S7 | `omem review --confirm <id>` | verified=true，confirmations+1 |
| S8 | `omem gc` | 超 180 天未确认的 active → stale（只标记） |
| S9 | `omem context --for claude-code/cursor` | 分别产出 INDEX 内容 / .mdc |
| S10 | `omem sync status` / `omem sync` | git 数据仓初始化成功；push 后 status ahead=0 |
| S11 | `omem profile use work` → `omem sync` | 拒绝并给出可操作提示（退出码 2） |
| S12 | `omem redact --id` | 文件与索引条目消失（唯一硬删路径） |
| S13 | `omem snapshot` | 生成 snapshots/YYYY-MM-DD/，超 7 份滚动删除 |
| S14 | MCP 探针 | initialize/tools/list/tools/call(search+save) 全通过；stdout 无日志污染 |

### 6.2 工程纪律

- **退出码**：0 成功（含"有冲突但已处理"）；1 用法错误；2 后端不可用/policy 拒绝。
- **零配置承诺**：init→search 全链路不出现任何 key 提示（规格 §1.4）。
- **stdout 纪律**：`omem serve` 的 stdout 只走 MCP 协议；一切日志走 stderr 或 logs/（否则污染 JSON-RPC）。
- **写入纪律**（install）：只 merge 不覆盖、先备份、原子写、幂等、JSONC 容错、收尾提示（规格 §6.5）。
- **git 纪律**：高风险动作（reset 等）不用；初始 commit 前确认 .gitignore 生效。

---

## 7. 风险与回退（实施期）

| 风险 | 等级 | 回退 |
|---|---|---|
| `node:sqlite` 在 Node 22 需 flag，分发体验受损 | P1 | bin 包装器已自 re-exec；长期方案 = bundled runtime（V0.2） |
| trigram 中文召回不及预期 | P1 | 查询 <3 字已 LIKE 兜底；jieba 预分词为 Phase 1 备选（规格 §11 开放问题 1） |
| 无真实 Claude Code 会话样本 | P1 | 合成 fixture 先行，README 标注"未经真实数据验证"；有真机样本后补回归（组件清单 lore 教训） |
| MCP SDK API 漂移 | P2 | 锁定 ^1.32.1；只用低层 Server + types.js 稳定面 |
| 9 类客户端配置路径部分"待核" | P2 | workbuddy 已核实；其余路径写入注册表注释，install --list 明示待核状态 |

---

## 8. 与后续路线的关系

本计划交付 = 12 周计划 W3–6 的"V0.1 核心"出口物（自用闭环跑通）。出口后进入 W7–8 质量收敛：Q1（抽取通过率 ≥80%）、Q2（盲测胜出 ≥15pp）。**G2 不过且两轮调优无改善 → 触发 kill criteria**：收缩为个人 CLI 脚本，停止产品化投入（评估 4.6）。
