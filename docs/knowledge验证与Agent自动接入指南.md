# knowledge 验证与 Agent 自动接入指南

> 姊妹篇：`docs/记忆可信度的人工核实与Agent协作手册.md`（聚焦「可信度」这一条线）、`docs/手动测试指南.md`（CLI 全量手工测试）。
> 本文回答三个问题：**knowledge 里到底有什么**、**在 Cursor 里说什么能让 Agent 去整理它**、**怎么让 omem 被自动调用**。

本文所有命令均基于 `0.1.0-beta.2`。

---

## 1. 先搞清楚 knowledge 里现在有什么

`knowledge/` 是**结论层**，`sessions/` 是**会话原文层**。beta.2 起默认只往 `sessions/` 写原文，结论要等 Agent（或 `omem add`）写回。所以「knowledge 是空的」在 beta.2 是**正常状态**，不是故障。

四层验证，从快到慢：

| # | 命令 | 看什么 | 正常长什么样 |
|---|---|---|---|
| 1 | `omem context --for cursor` | 热层 MEMORY-INDEX（≤80 行派生视图） | `active 12 / stale 0 / superseded 1 / archived 0` + 每条一行摘要 |
| 2 | `omem search "<查询词>"` | 能不能召回 | 命中条目 + `confidence` + 时效标注 |
| 3 | `omem review` | 未确认队列（`verified: false`） | beta.2 下应为空或很少（结论都来自 add / MCP，不来自规则抽取） |
| 4 | `omem audit [--tail N]` | 最近 20 条使用日志（JSONL） | `{"event":"commit","status":"written","source":"manual","redacted":0,...}`；`redacted > 0` 说明有密钥被拦下 |

想看原始条目，直接读 md（事实源，明文）：

```bash
ls ~/.omem/knowledge/*/*/          # 按 domain / 年份分组
cat ~/.omem/knowledge/coding/2026/<id>.md
```

一条记忆 = 一个文件，frontmatter 里 `source` 字段说明它是怎么来的：`manual`（`omem add`）、`agent`（MCP `save_memory`）、`llm`（`--tier api`）、`rules`（**已移除，只剩历史遗留**）。

**验证清单（建议跑一遍，5 分钟）**：

```bash
omem context --for cursor          # 热层有没有内容
omem search "你最近一次的真实决策"  # 能不能召回它
omem audit                         # 使用日志：commit/redact/run 等事件，看 redacted 是否 > 0
omem redact --source rules         # 仅预览：还有多少 beta.1 遗留的规则碎片
```

最后一条**不加 `--yes` 只打印预览**（beta.2 起的安全设计），确认是那批垃圾后再加 `--yes` 删。

---

## 2. 让 omem 被"自动调用"的三条路径（由弱到强）

这是本文最关键的一节。**omem 不会自己触发任何事**——它不调用模型，只是把工具和数据摆在那里。要不要用，取决于宿主 Agent 的上下文里有没有「该用了」的信号。

| 路径 | 强度 | 落地方式 | 代价 |
|---|---|---|---|
| **A. MCP 工具描述** | 弱 | `omem install --target cursor` 后工具自动出现在列表里 | 模型可能全程不主动调 |
| **B. 客户端规则文件** | 中 | 把记忆索引写进项目规则，每轮对话自动在上下文里 | 项目级需每个仓库放一份 |
| **C. 你在 prompt 里明确说** | 强 | 本文 §3 的模板 | 每次要手动说 |

### A. MCP 工具描述（install 后自动生效）

```bash
npm install -g @jeeinn/omem@beta
omem install --target cursor       # 非交互终端必须显式 --target
```

装完重启 Cursor，工具列表里会出现 `search_memory` / `save_memory`。它们的描述里已经写了触发条件——这是目前**唯一跨客户端通用的自动钩子**：

- `search_memory`：*「Call this tool before answering whenever the user mentions past preferences, historical decisions, previous project experience, or environment configuration, or whenever you are unsure whether the user has told you something before.」*
- `save_memory`：*「Call when the user explicitly asks to remember something, or when the session produces a stable preference / decision / environment configuration / pitfall experience.」*

**局限（诚实说）**：描述里**没有提到 `PROCESS.md`**。也就是说，Agent 不会主动去读待蒸馏会话——档 2 目前只能靠你（路径 C）或规则文件（路径 B）触发。这是已知的自动化缺口，见 §5。

### B. 客户端规则文件（推荐，一次配置长期生效）

`omem context --for cursor` 的输出**已经是合法的 Cursor 规则文件**（带 `alwaysApply: true` 的 frontmatter）：

```bash
cd <你的项目>
mkdir -p .cursor/rules
omem context --for cursor --out .cursor/rules/omem.mdc
```

产出的 `.cursor/rules/omem.mdc` 长这样：

```
---
description: omem personal memory index (auto-generated, do not edit)
alwaysApply: true
---

# MEMORY-INDEX (omem hot layer · auto-generated, do not edit)
> Generated ... · active 12 / stale 0 / superseded 0 / archived 0

- [2026-10-16] 部署时 docker 镜像构建失败，改用国内源后恢复 — confirmed just now · #experience #coding · `2026-10-16-fe9e6a`
```

`alwaysApply: true` 意味着**每次对话都自动注入**，不需要你开口。热层有 ≤80 行上限，代价可控。

**beta.3 起，规则文件不再只是索引快照**：文件末尾附带一段 marker-fenced 的「omem usage instructions」，明确告诉 Agent 两件事——①提到历史偏好/决策/环境配置时先查记忆再回答；②会话收尾时主动回顾并把稳定结论调 `save_memory` 写回（含 `PROCESS.md` 与 evidence 规则）。也就是说，**「自动总结」的触发信号现在跟着规则文件走**，不再只依赖 MCP 工具描述。

**缺点**：这是**快照**，不是实时的。记忆变了要重跑一次命令。想让它在每个项目都生效，得在每个仓库各放一份（或在 §4 的 User Rules 里加一条「启动时先跑 `omem context --for cursor`」）。

其他客户端：

| 客户端 | 文件 | 命令 |
|---|---|---|
| Cursor | `.cursor/rules/omem.mdc`（项目级） | `omem context --for cursor --out .cursor/rules/omem.mdc` |
| Claude Code | `~/.claude/CLAUDE.md`（全局） | `omem install --target claude-code` 会写 marker 段 |
| Codex | `AGENTS.md` | `omem context --for codex` |
| 其他 | 任意 | `omem context --for plain` |

### C. 每轮 prompt（最强，也最可控）

见 §3。

---

## 3. Cursor 里可直接粘贴的 prompt 模板

### 模板 1：让 Agent 去蒸馏 PROCESS.md（档 2 的核心动作）

> 适用场景：`omem run` 之后，`~/.omem/PROCESS.md` 里列着待加工会话。**这是把会话原文变成 knowledge 结论的主路径。**

```
请帮我整理 omem 的待加工会话。

步骤（严格按顺序，不要跳步）：

1. 读 ~/.omem/PROCESS.md。里面列出最多 5 个还没有结论的会话，每个都给了文件路径。
2. 逐个读那些文件。文件很长就分几次读，不要把全文贴回对话里。
3. 对每个会话，只把「值得跨会话记住」的东西写回，调用 save_memory，参数这样给：
   - content：一条一个结论，3-10 句，只留结论、丢掉过程，不要编造没说过的话
   - type：preference / fact / decision / experience 四选一
   - session_id：PROCESS.md 里该会话的 session id
   - evidence：从该会话文件的 "## user" 段里**原样复制至少 12 个字符**。
     不要引用 "## assistant" 段，也不要自己改写——这直接决定置信度打分。
   - supersedes：只有当新结论明确取代旧结论时才传，值是 PROCESS.md 里列出的旧条目 id。
     不传的话新旧两条会同时有效。
4. 全部写完后问我一次：全部确认 / 部分确认 / 都不确认。我同意哪些，你就
   调用 save_memory 只传 confirm_ids（那些条目会提到 0.8，但不会标 verified）。
5. 不要自己把条目标成 verified。verified 只能来自 omem add 或 omem review --confirm。

最后报告：写了几条、各自 id 与置信度、跳过了哪些会话及原因。
```

**为什么强调 evidence**：`save_memory` 的置信度是算出来的，不是写死的——user 段对得上 **0.55**，两个会话都能对上 **0.75**，对不上**封顶 0.35** 并打 `ungrounded`。evidence 写错（引 assistant 段、或自己改写）会直接把分数打到 0.35。

### 模板 2：开工前先查记忆（验证召回率）

```
在开始之前，先用 search_memory 查一下这三件事，把结果念给我听：
1. 我这个项目的历史决策
2. 我提过的偏好（代码风格、工具选择、流程习惯）
3. 我踩过的坑

查不到就直接说"没有"，不要编。
```

这条同时是**召回率的手工验证**——如果明明记得说过却查不到，说明索引或分档有问题，值得回头查 `omem search` 是否命中（中文查询至少 3 个字，走 FTS5 trigram）。

### 模板 3：会话结束时保存

```
这次会话里有值得长期记住的东西吗？如果有，分成 preference / fact / decision /
experience，一条一个结论，用 save_memory 存进去。存完告诉我存了什么、置信度多少。
不确定的不要存。
```

### 模板 4：核实已有条目（批量，配合 review）

见 `docs/记忆可信度的人工核实与Agent协作手册.md` §2 的路径 A 模板。核心约束是**先读 md 全文再判断**、**拿不准就跳过**、**不要让 Agent 确认它自己刚写的条目**。

---

## 4. 让 Cursor 全局生效（User Rules）

项目级 `.cursor/rules/omem.mdc` 要每个仓库放一份。想全局生效，用 Cursor 的 **User Rules**（Settings → Rules → User Rules，全局、跨项目）。把这段贴进去：

```
## omem 个人记忆

你有一个长期记忆库 omem，事实源是 ~/.omem/knowledge 下的 Markdown，可通过 MCP 工具
search_memory / save_memory 访问。

开工时：如果用户提到过去的偏好、历史决策、项目经验或环境配置，或者你不确定他是否说
过某件事，先用 search_memory 查，不要凭空假设。查不到就明说没有。

收工时：如果这次会话产生了稳定的偏好 / 决策 / 环境配置 / 踩坑经验，用 save_memory
存下来，一条一个结论。evidence 必须从该会话的 user 段原样复制至少 12 个字符。

如果用户让你整理记忆，先读 ~/.omem/PROCESS.md，那里列着待蒸馏的会话。

不要自己把条目标成已确认（verified），也不要凭印象造 evidence。
```

User Rules 是 UI 里的文本，没有文件路径，所以要手动粘贴一次。

---

## 5. 当前缺口（诚实清单）

| 级别 | 缺口 | 影响 | 规避 |
|---|---|---|---|
| ~~P1~~ | ~~MCP 工具描述里没提 `PROCESS.md`~~ | — | **已修复**（beta.3）：`save_memory` 描述补了「会话收尾主动回顾」与 `PROCESS.md` 指引 |
| ~~P1~~ | ~~`omem context` 输出不带写回指令~~ | — | **已修复**（beta.3）：四个 target 的输出都附带 marker-fenced 指令段（读条件 / 写条件 / evidence 规则 / verified 边界） |
| **P1** | `omem install` 只写 MCP 配置，**不写任何客户端的规则文件**（claude-code 的 CLAUDE.md marker 段是唯一例外，且只在选中它时写） | Cursor / WorkBuddy 装完只有工具、没有指令 | 手工跑 `omem context --for cursor --out .cursor/rules/omem.mdc` |
| **P2** | 指令段是「提示」不是「强制」：模型仍可能不执行写回（尤其会话被用户直接关掉时） | 自动总结不保证 100% 触发 | 关键内容用 §3 模板 3 明确问一句；或 User Rules（§4）双保险 |
| **P2** | `omem context --for cursor` 是快照，记忆更新后不会自动同步 | 规则文件会过期 | 重跑一次；或在项目里加个 git hook |
| **P2** | `memory_feedback` 默认不暴露（要 `OMEM_MCP_TOOLS=feedback`），且 `helpful: false` 只写日志不降权 | 「负面反馈」是空承诺 | 需要降权用 `omem review --stale` / `--dismiss` |
| **P2** | 热层 MEMORY-INDEX 上限 80 条 | 记忆多了以后 `alwaysApply` 的规则文件会变长 | 归档老条目，或只放高置信度条目 |

> 修订记录（beta.3）：原两条 P1 缺口（MCP 描述缺 `PROCESS.md`、规则文件不带指令）已按「方案 A」修复——`src/context/export.ts` 增加 `INSTRUCTIONS` 常量段并注入全部四个 target，`src/mcp/tools.ts` 的 `save_memory` 描述补触发条件；测试同步更新（202 个单测全绿）。本表的 install 写规则文件缺口仍在。

---

## 6. 端到端验证（10 分钟跑完）

```bash
# 1. 已有记忆能被召回吗
omem search "你最近一次的真实决策"

# 2. MCP 工具在 Cursor 里出现了吗：重启 Cursor，新开对话问：
#    「用 search_memory 查一下我的历史偏好」
#    能查到 = 工具接上了

# 3. Agent 能把结论写回去吗：在 Cursor 里跑 §3 模板 1，然后看：
omem context --for cursor          # 新条目出现在热层了吗
omem search "<刚写进去的结论关键词>"  # 能召回吗

# 4. 可信度对不对：看刚写的条目 frontmatter
#    confidence 0.55 = evidence 对上了 user 段
#    confidence 0.75 = 多个会话印证
#    confidence 0.35 + ungrounded = evidence 没对上，检查是不是引了 assistant 段
#    verified 应该是 false（只有 omem add / review --confirm 才置 true）

# 5. 规则文件生效了吗：新开一个 Cursor 对话，什么都不说，问
#    「你知道我有哪些长期偏好吗」——如果它能答出来，alwaysApply 生效了
```

任何一步不通，按 `docs/手动测试指南.md` 的排障表查。最常见的是 MCP 启动失败（Windows 上 npm 生成的 `omem.cmd` 被 spawn 时 EINVAL / ENOENT），兜底是把 MCP 配置改成 `node.exe` 绝对路径 + `bin/omem.js`。
