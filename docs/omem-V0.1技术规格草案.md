# omem V0.1 技术规格（草案）

> 版本：v0.3-draft · 日期：2026-10-15 · 状态：**已批准实施，V0.1 代码已落地**
> 上位文档：`跨Agent记忆知识库-规划评估与MVP设计_v1.4.md`（评估报告定战略，本文定战术）
> v0.3：§5.3 拉取前改为自动提交（不用 stash）；§7 删除与 §5.5 矛盾的退出码 3。文件名未改。
> v0.2 新增：**§4 记忆生命周期（过时记忆怎么处理）**、**§9 加工与模型（为什么需要 API key，以及零配置路径）**，并据 codegraph 实测修订 §6 接入方式与 §8 MCP 工具面。

---

## 1. 范围与非目标

### 1.1 目标

验证一个假设：**单工具（Claude Code）会话 → 加工 → 跨 Agent 检索，能否稳定打赢三个 dumb baseline**（无记忆 / Claude Code auto memory / 手工 MEMORY.md）。

### 1.2 非目标（写死以免漂移）

| 不做 | 原因 |
|---|---|
| **GUI / 桌面壳** | 命令行一条命令足够。GUI 是 V0.3 才有条件讨论的事 |
| 自建同步服务器（relay） | 运营责任与成本不可承受，**任何版本都不做** |
| 自建合并算法 | md 分文件使冲突面天然小，冲突另存 `.conflict.md` 交给人读 |
| **自动删除记忆** | 事实源是 git 仓库，git 不丢历史。见 §4 |
| 浏览器扩展采集 | brittleness + ToS 风险；V0.2 用导出文件/API 路径替代 |
| 向量检索 | V0.1 用 FTS5 trigram；向量是 V0.2 可选开关 |
| 团队 / 多用户 | 明确排除 |

### 1.3 用户边界

- **V0.1 服务**：使用两个及以上 Agent 的开发者。
- **V0.1 排除**：非开发者（只用一款桌面 AI 产品、无 git 环境）。理由见评估报告 4.9.2。
- **排除不等于放弃**：§5、§6 的两笔接口税就是为 V0.2 能低成本纳入他们做准备。

### 1.4 体验基准：对齐 codegraph

用户指定体验基准为 **codegraph**（`github.com/colbymchenry/codegraph`）。其可验证特征：
零配置、零 API key、零外部服务、Rust + tree-sitter 解析、SQLite + FTS5、MCP 默认只暴露 1 个工具、
文件监听增量自动同步（2000ms 去抖）、`install` 自动检测并接线 9 类 Agent、自带 bundled runtime。

**omem 的体验承诺**：安装后**不出现任何 key 提示**，首次运行立即可用；质量提升是可选的第二步。

---

## 2. 数据模型：md 是事实源，索引随时可扔

### 2.1 目录布局

```
~/.omem/
├── config.toml              # 唯一配置入口
├── knowledge/               # ★ 事实源：唯一需要备份的东西
│   └── <domain>/<YYYY>/<id>.md
├── archive/                 # 归档条目（见 §4），仍在版本控制内
├── index/                   # 可重建（omem rebuild），不进版本控制
│   └── omem.db
├── snapshots/               # 每日快照兜底，滚动保留 7 份
└── MEMORY-INDEX.md          # 热层派生视图（≤80 行），由 knowledge 生成
```

**一条记忆 = 一个文件。** 这条约束是后续所有便宜特性的来源：git diff 可读、冲突面小、Obsidian 直接打开、误删单条不影响全局。

### 2.2 frontmatter 契约

```yaml
---
id: 2026-10-15-a1b2c3
type: preference | fact | decision | experience
domain: coding
profile: work | home
status: active | stale | superseded | archived      # 见 §4
superseded_by: <id>                                 # status=superseded 时必填
confidence: 0.0–1.0
verified: false              # 人工确认前恒为 false
last_confirmed: 2026-10-15T14:00:00+08:00
confirmations: 0
source: rules | agent | llm | manual                # 见 §9
session_id: <原始会话标识>
created: 2026-10-15T14:00:00+08:00
supersedes: [id, ...]
tags: [auth, postgres]
---
正文 3–10 句，纯 Markdown。
```

### 2.3 一致性原则

- **md 权威，索引是缓存。** 任何时刻删掉 `index/omem.db` 都必须能用 `omem rebuild` 完整恢复。
- 每条保存 content-hash；外部编辑（Obsidian 改了文件）由 watcher 或下次访问检出 → 增量重建；重建期间降级 grep。
- 借鉴 codegraph 的 **connect-time catch-up**：MCP server（重）连时先做 `(size, mtime)` + content-hash 对账，吸收 server 未运行期间发生的改动（终端操作、其他编辑器、上次会话退出后的修改）。

---

## 3. 分发与安装

| 项 | 决定 |
|---|---|
| 分发 | `npm i -g omem`（V0.1 直接交付 npm 包） |
| 技术栈 | **TypeScript**（依据见 §10） |
| runtime | 不要求用户预装 Node（后续可用 bundled runtime 或平台二进制） |
| 零配置 | 首次运行立即可用，**不要求 API key**（见 §9） |

---

## 4. 记忆生命周期：过时记忆怎么处理

> 这是"rebuild 之后旧文档怎么办"的正面回答。**核心原则：永不自动删除。**
> 事实源是 git 仓库，git 不丢历史；自动删除既违背这个哲学，也会制造"我的记忆自己消失了"的恐惧。

### 4.1 竞品怎么做（2026-10 核查）

| 项目 | 做法 | 评价 |
|---|---|---|
| **Zep / Graphiti** | **双时间模型（bi-temporal）+ 边失效**：每个事实带 `valid_at`/`invalid_at` 与 `ingested_at`；新事实到来**不删旧边**，只把旧边标 `invalid_at`，保留完整历史 | **最强**。同时支持"现在什么是真的"与"三年前我以为什么"。代价：图谱异步构建，新事实可能滞后 |
| **agentmemory** | 4 层整合 + 衰减 + 自动遗忘 | 最完整，但"自动遗忘"对 md 事实源不可接受（等于自动删文件） |
| **Letta / MemGPT** | 分层：core（常驻上下文）/ archival / recall，上下文溢出时挤压到 archival | **分层思路可抄**，它解决的是"上下文预算"而非"数据过期" |
| **mem0** | 被动提取，无显式生命周期 | 弱 |
| **supermemory** | 自动遗忘 | 同上 |
| **Hippo** | 衰减加权 | 简单衰减 |
| **Heirloom** | 无生命周期管理，只有手动 `redact` 硬删 | 最弱——**是我们的差异点之一**（1.4.2 已记：它连 LLM 蒸馏都没有，更别提生命周期） |
| **codegraph**（非记忆类但最相关） | **不删旧数据**。三层新鲜度保证：① 文件监听 + 去抖增量同步；② **per-file staleness banner**——MCP 响应引用了待更新内容时前置 `⚠️`，让 agent 直接读原文件取实时内容；③ connect-time catch-up | **"过时"的正确解法：不是删除，而是把新鲜度显式暴露给消费者，由它决定** |

**结论：记忆过时的真正风险不是占空间，而是污染检索结果**（把三年前的错误偏好当成现在的）。所以核心动作是**降权 + 显式标注**，不是删除。

### 4.2 我们的方案：四层 + 三机制

| 层 | 位置 | status | 行为 |
|---|---|---|---|
| **L0 热** | `MEMORY-INDEX.md`（派生） | — | ≤80 行，常驻上下文，每次 rebuild 重新生成 |
| **L1 活跃** | `knowledge/**/*.md` | `active` | 参与常规检索，正常权重 |
| **L2 冷却** | 同上 | `stale` | 检索降权（建议 ×0.5），MCP 返回带时效标注 |
| **L3 归档** | `archive/**/*.md` | `archived` | 默认不进结果，`--all` 才含；仍可 diff、可回滚 |
| **X 删除** | — | — | 仅用户 `omem redact` 硬删（**唯一**真正删除途径） |

三个机制，按可靠性排序：

1. **显式取代（supersede）— V0.1 必做。**
   新条目声明 `supersedes: [id]` → 旧条目自动置 `status: superseded` 并回填 `superseded_by`。
   这是 Graphiti 边失效的 md 版实现：**确定性、可解释、可逆、零额外存储**。
2. **确认刷新（reconfirmation）— V0.1 做轻量版。**
   记 `last_confirmed` 与 `confirmations`。被 `detail=true` 取用、或用户在 `omem review` 中确认时刷新。
   这是"用不用"的真实信号，**比按时间衰减准确得多**。
3. **时间衰减（decay）— V0.1 不做，V0.2 再评估。**
   理由：① 个人记忆规模小（<1 万条），检索本身就是过滤；② 自动衰减易误伤（三年前的技术偏好可能仍然有效）；③ "记忆自己淡了"的解释成本高，且与 git 不丢历史的哲学冲突。
   **若要加，也只做降权，绝不隐藏。**

### 4.3 需要"中间层"吗

**要，但它是薄的元数据层，不是新存储层。** 具体只增加：

- frontmatter 5 个字段：`status` / `superseded_by` / `last_confirmed` / `confirmations` / （可选）`valid_until`
- 索引表 2 列：`status`、`last_confirmed`
- `MEMORY-INDEX.md` 作为派生热层——**它本来就是中间层**，不需要另建
- 一个 `omem gc` 命令：**只标记不删除**，扫描后输出报告交用户确认

### 4.4 最关键的一条：把判断权交给消费者

借鉴 codegraph 的 staleness banner，MCP 返回条目时附时效标注，让 Agent 自己判断：

```
[2026-03-12] 用户偏好用 Postgres 而非 MySQL  ——记录于 7 个月前，未再确认
[2026-10-14] 该项目禁用 ORM，必须手写 SQL     ——3 天前确认
```

**为什么不自动衰减更好**：不丢任何信息，而消费者（LLM）完全有能力理解"7 个月前"意味着什么。我们把事实和时效一起给它，而不是替它做决定。

---

## 5. 接口税 #1：SyncBackend 抽象

### 5.1 为什么现在付

V0.2 加 WebDAV 时，若现在硬编码 git，需同时改 CLI、状态查询、冲突处理三处。抽象成本 <1 天，返工数倍。**且非开发者机器没有 git——这不是假设，是硬约束。**

### 5.2 契约

```ts
type SyncBackendId = 'git' | 'webdav' | 'dir';

interface SyncBackend {
  readonly id: SyncBackendId;
  init(): Promise<void>;                          // 幂等
  push(opts?: PushOptions): Promise<SyncReport>;
  pull(opts?: PullOptions): Promise<Conflict[]>;   // 只报告，不自动合并
  status(): Promise<SyncStatus>;
}
```

三条不可违背的约束：

1. **只报告冲突，绝不自动合并。** 冲突文件另存 `<name>.conflict.md`，本地版本保留。
2. **后端不得假设 git 存在。** 检测不到 git 时必须给出 `omem sync use webdav` 的可操作提示，而不是抛栈。
3. **三个后端对上层暴露完全相同的语义。** 新增后端只允许加实现类 + 注册表一行。

### 5.3 三个后端

| 后端 | 版本 | 实现要点 | 覆盖人群 |
|---|---|---|---|
| **git** | V0.1 | `add -A && commit && push` 封装；init 时写入**仓库级** user.name/email（不污染用户全局 git 配置）；未配 origin 时只本地提交并提示。pull 前若有未提交改动，先固化为自动提交（不用 stash：stash 后 ours 等于 base，冲突被推迟到 pop 才爆，本地改动会卡在 stash 里） | 开发者（默认） |
| **webdav** | V0.2 | `PROPFIND` + `PUT`；坚果云 / Nextcloud / NAS。**WebDAV 无版本历史** → 远端维护 `snapshots/YYYY-MM-DD/` 滚动目录，保留 7 份 | **非开发者主路径** |
| **dir** | V0.2 | 指向 Syncthing 文件夹 / U 盘 / OneDrive 目录；近乎复制 + manifest 校验 | 多设备、不信任云端者 |

**优先级**：git（V0.1）→ **webdav（V0.2 优先）** → dir（V0.2 顺带）。

### 5.4 配置与凭据

```toml
[sync]
backend = "git"
[sync.webdav]
url = "https://dav.jianguoyun.com/dav/omem/"
user = "you@example.com"
password = ""            # 必须支持 OMEM_WEBDAV_PASSWORD 环境变量覆盖
[sync.dir]
path = "D:/Syncthing/omem"
```

**凭据不得进 git。** 明文密码须在 push 前警告，或强制使用环境变量。

### 5.5 冲突策略（与后端无关）

```
omem sync  →  pull（报告冲突，写 .conflict.md） →  push（提交本地改动）
```

冲突是**事件不是错误**：退出码 0，stdout 明确列出冲突文件与另存位置。
**这条策略能成立完全依赖"一条记忆一个文件"**——Heirloom 的整体 SQLite 快照一冲突就是整库冲突，所以它被迫自造 `.hlm` 合并协议。这一点应写进 README。

---

## 6. 接口税 #2：`omem install`（原 `omem setup`）

> v0.2 修订：命令名对齐 codegraph 改为 `install`，**自动检测为默认行为**（不再需要 `--detect`），
> 并新增"写入 Agent 指令文件"这条原本遗漏的关键动作。

### 6.1 为什么现在付

这是**非开发者唯一可承受的接入形态**。错过了就只能靠 GUI 补，代价高两个数量级。

### 6.2 命令

```bash
omem install                          # 自动检测本机 agent 并接线（默认行为）
omem install --target=cursor,claude   # 指定目标
omem install --yes                    # 非交互（CI / 脚本）
omem install --print-config codex     # 只打印配置片段，不写文件
omem install --list                   # 列出支持的客户端与配置路径
```

### 6.3 客户端注册表

| client | 配置文件 | 结构 | 状态 |
|---|---|---|---|
| `claude-code` | `~/.claude.json` | `mcpServers.omem` | 待核（亦可用 `claude mcp add`） |
| `claude-desktop` | Win `%APPDATA%/Claude/claude_desktop_config.json`；macOS `~/Library/Application Support/Claude/…` | `mcpServers.omem` | 待核 |
| `cursor` | `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json` | `mcpServers.omem` | 待核 |
| **`workbuddy`** | **`~/.workbuddy/mcp.json`** | `mcpServers.omem` | **本机已核实**（不是带点前缀的 `.mcp.json`） |
| `codex` | `~/.codex/config.toml` | `mcp_servers.omem` | 待核 |
| `continue` | `~/.continue/config.json` | `mcpServers` 数组项 | 待核 |
| `zed` | `~/.config/zed/settings.json` | `context_servers.omem` | 待核 |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.omem` | 待核 |
| `cline` | VS Code 插件存储下 `cline_mcp_settings.json` | `mcpServers.omem` | 待核，路径随版本漂移 |

写入内容统一：`{ "mcpServers": { "omem": { "command": "omem", "args": ["serve"] } } }`

### 6.4 必须补的一条：**写入 Agent 指令文件的 marker-fenced 段**

codegraph 在 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` 中写入一段带 marker 的指令，让**子 Agent 与非 MCP harness** 也能学会对应的 CLI 命令。理由很实在：MCP server 自带的指引只能触达主 Agent。

omem 应照做：

```markdown
<!-- OMEM:START -->
## omem（个人记忆）
- 检索记忆：`omem search "<query>"`（等价于 MCP 的 search_memory）
- 保存记忆：`omem add "<content>"`
- 上下文导出：`omem context --for <agent>`
- MCP 工具 search_memory / save_memory 可用时优先用工具。
<!-- OMEM:END -->
```

marker 之间为 omem 托管区，**重跑 install 时按 marker 幂等替换**，绝不破坏用户手写的其他内容。

### 6.5 写入纪律（必须遵守，否则会毁掉用户现有配置）

1. **只 merge 不覆盖**：仅更新 `mcpServers.omem` 一个键。
2. **先备份**：写前复制为 `<file>.omem-backup-<ts>` 并打印路径。
3. **原子写**：临时文件 + rename。
4. **幂等**：已存在则更新 command/args，不重复添加。
5. **格式保留**：允许注释的客户端不得用标准 JSON 解析器粗暴重写；解析失败时降级为"打印手工片段 + 打开路径"，不报错退出。
6. **收尾提示**：告知"请重启 <client> 以加载 MCP 服务"。

### 6.6 前置事实待核

目标桌面产品是否：① 开放 MCP server 配置；② 允许第三方记忆层写入；③ 提供会话导出。
**三者皆不满足的产品，其用户明确不属于可服务范围**（写入路线图的排除规则）。

---

## 7. CLI 规格

```
omem init                        建库 + 扫描已有会话（规则抽取）
omem install                     自动接线 agent（§6）
omem run [--since D]             加工会话（V0.1 只 Claude Code）
omem search <q> [--detail] [--all]
omem review                      待确认队列（含 stale 提示）
omem gc                          ★ 标记 stale，只报告不删除
omem rebuild                     从 md 全量重建索引
omem context --for <agent>       导出上下文

omem sync                        ★ 拉取 + 推送（一条命令）
omem sync status
omem sync use <git|webdav|dir>
omem sync remote <url>           仅 git

omem profile use work|home       work 默认禁导出
omem pause                       一键停采集
omem redact --id <id>            唯一硬删除途径
```

**退出码**：0 成功（含"有冲突但已处理"，见 §5.5）；1 用法错误；2 后端不可用或策略拒绝。

### 7.1 验收标准（"一条命令够用"）

| 场景 | 命令数 | 时间 | 判定 |
|---|---|---|---|
| 新机器从零到记忆可用 | 3（`npm i -g omem` → `omem install` → `omem sync`） | ≤5 分钟 | 全程**无 key 提示** |
| 日常跨机器同步 | **1**（`omem sync`） | ≤30 秒 | "不做 GUI"能否成立的唯一检验点 |
| 断网时 | 1 | — | 本地提交 + 明确提示，联网后同一命令补推 |

---

## 8. MCP 工具面（对齐 codegraph 的"最小工具面"原则）

| 工具 | 默认 | 说明 |
|---|---|---|
| `search_memory` | ✅ 列出 | `query, domain?, project?, detail?`；top-3 摘要行（<300 token），`detail=true` 才全文。返回附时效标注（§4.4） |
| `save_memory` | ✅ 列出 | 幂等，content-hash 去重 |
| `memory_feedback` | ❌ 默认不列 | 用 `OMEM_MCP_TOOLS=feedback` 开启；用于回传"这条有用/没用"，喂给 §4.2 的确认刷新 |

**借鉴 codegraph**：它默认只暴露 `codegraph_explore` 一个工具，其余用 `CODEGRAPH_MCP_TOOLS` 环境变量开启。
理由与它一致——**工具面越大，Agent 的调用意愿越低**，这是大知识库下的生死问题。

---

## 9. 加工与模型：为什么需要 API key，以及零配置路径

> 用户提问："API key 是什么？为什么需要？难道不能借助本地 agent 的能力直接初始化吗？"
> 本节正面回答。

### 9.1 先把问题拆开：哪一步需要模型

| 环节 | 是否需要 LLM | 说明 |
|---|---|---|
| 采集（解析会话 JSONL） | ❌ | 纯结构化解析 |
| **加工（会话 → 结构化记忆条目）** | ✅ **传统上需要** | 几十 KB 杂乱对话 → `{type, content, confidence}` |
| 索引 / 检索 | ❌ | FTS5 本地 |
| 同步 | ❌ | git / WebDAV |
| 生命周期标记（§4） | ❌ | 规则 + 元数据 |

**所以：key 只服务于"加工"一步，检索与同步完全不需要。**

### 9.2 "借本地 agent"这条路真的存在，但 V0.1 走不通

MCP 规范里有个正好为此设计的原语：**sampling**（`sampling/createMessage`）——server 反向请求 client："请用你的模型帮我做一次补全"。设计意图就是让 server 不必持有 key、不必成为计费方。

**但 2026-10 的实测支持度**：

| client | sampling 支持 |
|---|---|
| **Claude Code** | **不支持**。Issue #1785 自 2025-06 开启，2026-08 仍有 58 条评论未关闭 |
| opencode | 2026-04 已支持（Issue #11948 closed as completed） |
| VS Code MCP client | 部分支持（响应 `modelPreferences`） |

**而 V0.1 恰恰只采集 Claude Code → sampling 在 V0.1 直接不可用。**

即使将来支持，还有三个问题：① 同步阻塞 + 人工批准，加工 20 个历史会话 = 20 次请求；② 模型选择权在 client，server 无法指定轻模型；③ 安全面反转——Unit 42（2026-04）专门分析过 sampling 攻击向量，server 从"被调用的东西"变成"提示我的东西"。

### 9.3 codegraph 为什么能零 key？——它根本不做推理

这是最该抄的一点。codegraph README 原文："**No data leaves your machine. No API keys. No external services. SQLite database only.**"——它只做解析、建图、检索，**推理留给 Agent 自己的模型**。

**omem 可以走同一条路**：把"加工"从"omem 调 LLM"改成"**由 Agent 在使用时完成**"。

### 9.4 推荐：四档加工，默认零配置

| 档 | 机制 | 配置 | 质量 | V0.1 |
|---|---|---|---|---|
| **0. 规则抽取**（默认） | 正则 + 模板从会话提高信号句（"以后都用 X" / "别再用 Y" / "我决定…" / "改成…" / "因为…所以…"），生成候选条目，标 `verified:false`、低 `confidence` | **零** | 低但可用 | ✅ 必做 |
| **1. Agent 主动保存**（默认开） | Agent 会话中自行调 `save_memory`；omem 负责去重与组织 | **零** | 取决于 Agent | ✅ 必做 |
| **2. Agent 协作加工**（可选） | omem 提供 CLI/MCP 引导，让 Agent 批量加工历史会话——**这才是"借本地 agent 能力"的真正落地方式** | **零** | 中 | ✅ 做 |
| **3. 自带 API key**（可选，默认关） | 配置 OpenAI 兼容 key + 轻模型批量加工 | 需 key，¥5–20/月 | 高 | ⭕ 可选开关 |
| **4. MCP sampling**（未来） | 借宿主模型 | 零 | 高 | ❌ V0.1 不可用；**持续跟踪 claude-code Issue #1785** |

**关键承诺**：首次运行不出现任何 key 提示。规则抽取产出的是**候选条目**（`verified:false`），用户在 `omem review` 中确认——质量不够，但"有东西"胜过"要配置"。想提质再 `omem config set model …`。

### 9.5 开放问题

规则抽取的召回率到底多少？这需要一个真实实验：用自己的 20 个会话，对比"规则抽取结果"与"LLM 抽取结果"，看前者能覆盖多少高价值条目。**这个实验应并入 Q1（抽取通过率 ≥80%）作为对照组**——它直接决定档 0 是否够用作默认。

---

## 10. 技术栈决断：V0.1 用 TypeScript

| 维度 | TypeScript（选） | Rust（后续） |
|---|---|---|
| 分发 | npm 直接满足 | 需平台包，链路复杂 |
| 验证速度 | 快 | 慢 |
| FTS5 | better-sqlite3（**需先验证 trigram 是否编译进该发行版**；否则换 Node 22+ 内建 `node:sqlite`） | rusqlite bundled 可控 |
| MCP | 官方 TS SDK 成熟 | rmcp 待评 |

**Rust 化触发条件（任一）**：① 验证通过且检索/解析成为可测瓶颈；② 冷启动或包体积进 beta 前三抱怨；③ 需直接吸收 Heirloom 的零模型混合检索。
**不可让步**：SyncBackend 与数据模型必须保持语言无关（§2、§5），否则换语言等于重写。

---

## 11. 开放问题（评审时必须定）

1. **FTS5 trigram 对中文是否有效** —— G1 闸门第一项，半天 spike。
2. **better-sqlite3 是否编译了 FTS5** —— 同上。
3. **规则抽取的召回率**（§9.5）—— 决定零配置默认档是否成立。
4. **WebDAV 国内可用性** —— 坚果云 WebDAV 是否对个人免费、限速多少。
5. **千问办公等是否开放 MCP** —— 决定非开发者市场是否真实可达。
6. **work/home profile 自动判定** —— V0.1 先显式切换，避免过度设计。
7. **stale 阈值** —— 多久未确认降权？V0.1 先给保守值（180 天）并允许配置。

---

## 12. 与评估报告的关系

| 文档 | 职责 |
|---|---|
| `跨Agent记忆知识库-规划评估与MVP设计_v1.3.md` | 为什么做、做什么、不做什么、何时判定失败 |
| **本文** | 接口长什么样、命令长什么样、验收标准是什么 |

两文冲突时，**以评估报告的"不做清单"为准**（战略），以本文的"接口定义"为准（战术）。
