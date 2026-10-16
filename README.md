# omem

**你的记忆是一个 git 仓库，不是一个数据库文件。**

omem 是一个 git 原生的个人级 AI 记忆层：一条记忆 = 一个 Markdown 文件，事实源永远明文可读、可 diff、可 `git log` 审计；SQLite/FTS5 只是可随时删除重建的派生索引；MCP 让各个 AI 客户端（Claude Code、WorkBuddy、Codex……）共享同一份记忆。

- 零配置、零 API key：默认把完整对话采集进 `sessions/`，结论由 Agent 写回；首次运行不出现任何 key 提示
- Markdown 事实源：Obsidian 里直接改，下次访问自动检出重建索引
- 备份/跨机器/版本历史/diff 审计/人类可读冲突解决——`md + git` 一次全部拿到
- 永不自动删除：supersede 显式取代、reconfirm 确认刷新、`omem redact` 是唯一硬删入口
- MCP 最小工具面：默认只暴露 `search_memory` / `save_memory`

## 状态

V0.1 MVP（TypeScript）。**尚未经过真实 Claude Code 会话数据验证**——抽取规则基于合成 fixture 调校，召回率待实测。同步后端只交付 GitBackend；WebDAV（非开发者主路径）与本地目录后端排在 V0.2。

公开测试版本：`0.1.0-beta.1`（`npm install -g @jeeinn/omem@beta`）。beta 期间的破坏性变更不保证兼容，正式版会先完成真实会话数据的质量验证。

> 包名带 scope 的原因：npm 的 typo-squatting 保护认为裸名 `omem` 与已存在的 `mem` / `pem` / `open` / `viem` 过于相似（发布时返回 403）。用 scope 后**命令名依然是 `omem`**，安装后 `omem init` / `omem serve` 的用法不变。

CLI 全部输出（帮助、错误、命令结果、MCP 工具描述）为英文单语；`docs/` 技术文档与本 README 保持中文。

## 环境要求

- Node.js ≥ 22.5（使用内建 `node:sqlite`，自动带 `--experimental-sqlite` 重 exec，无需原生编译）
- git（仅同步功能需要；`omem sync` 未检测到 git 时给出可操作提示而非栈追踪）

## 安装

```bash
npm install -g @jeeinn/omem@beta
omem init
```

`omem init` 在 `~/.omem`（可用 `OMEM_HOME` 覆盖）建好数据仓骨架与 `config.toml`。

> Windows 上若客户端报 MCP server 启动失败（多见于 spawn 无法解析 npm 生成的 `omem.cmd`），把 MCP 配置改成直接用 node 启动：
> `"command": "<node.exe 绝对路径>"`，`"args": ["<全局 node_modules>/omem/bin/omem.js", "serve"]`。

## 快速开始

```bash
# 1. 接一个 AI 客户端：交互式勾选（空格切换、a 全选、回车确认）
omem install
#    默认只预选路径已核实的客户端（cursor / workbuddy），其余由你决定
#    非交互环境（CI / 管道）必须显式指定，否则报错：omem install --target claude-code,cursor
#    客户端不在支持列表里：omem install --print-config generic 打印通用 mcpServers 片段

# 2. 采集历史会话原文（默认档 agent：写入 sessions/，并生成 PROCESS.md）
omem run --since 30d

# 3. 让当前 Agent 按 PROCESS.md 写结论；要盖已确认章再用 review
omem review --confirm <id>

# 4. 手工记一条
omem add "部署时 docker 镜像构建失败，改用国内源后恢复" --type experience

# 5. 检索
omem search "镜像拉取"

# 6. 备份 / 跨机器
omem sync remote git@github.com:you/omem-memory.git
omem sync            # pull → push；冲突只报告，远端版另存 .conflict.md，本地版保留
```

客户端接入后即可在会话中直接使用 MCP 工具 `search_memory` / `save_memory`（`memory_feedback` 用 `OMEM_MCP_TOOLS=feedback` 开启）。

## 命令面

| 命令 | 作用 |
| --- | --- |
| `omem init` | 建数据仓并默认采集会话原文到 `sessions/`（`--no-scan` 只建库） |
| `omem install` | 交互勾选客户端并写入 MCP 配置（六条写入纪律）；`--target a,b` 跳过交互、`--print-config <id\|generic>` 只预览、`--list` 列全部 |
| `omem run [--since 7d] [--tier agent\|api]` | 采集对话到 `sessions/` 并写 `PROCESS.md`。`--tier rules` 已移除 |
| `omem add <content>` | 手工添加（自动脱敏、幂等去重） |
| `omem search <query> [--detail] [--sessions] [--domain X]` | 默认只查结论；`--sessions` 只查对话原文 |
| `omem review [--confirm <id>]` | 审阅队列。`--confirm` 把该条标为已确认并把置信度提到 0.9 |
| `omem gc [--days N]` | 标记 stale（直接标记，只标记不删除） |
| `omem rebuild` | 从 Markdown 全量重建索引（删 db 也能恢复） |
| `omem context --for claude-code\|cursor\|codex\|plain` | 导出记忆为客户端上下文 |
| `omem sync [status\|remote <url>\|pull\|push\|use <backend>]` | git 同步（V0.1 唯一后端） |
| `omem profile [home\|work]` | 档案切换；work 档默认禁同步/导出 |
| `omem pause` / `omem redact --id <id>` / `--source rules` | 暂停加工 / 硬删一条 / 按来源批量硬删旧规则碎片 |
| `omem snapshot` | 手动快照（push 前自动快照，滚动保留 7 份） |
| `omem serve` | MCP server（stdio；由 install 写入的配置自动拉起） |
| `omem audit` | 安全审计（脱敏命中、禁区、低权候选统计） |

退出码：`0` 成功（含冲突已处理）/ `1` 用法错误 / `2` 后端不可用或策略拒绝（如 work profile 禁导出）。

## 数据布局

```
~/.omem/
├── config.toml              # 唯一配置入口
├── knowledge/<domain>/<YYYY>/<id>.md   # 结论记忆：一条一个文件
├── sessions/<agent>/<session_id>.md    # 对话原文（user/assistant），不是结论
├── PROCESS.md                          # 档 2 引导（派生，不进 git）
├── archive/<domain>/<YYYY>/<id>.md     # 归档层（L3）
├── index/                   # SQLite + FTS5（派生缓存，删了可 rebuild）
├── snapshots/YYYY-MM-DD/    # 快照（滚动保留 7 份）
└── logs/                    # JSONL 使用日志
```

一条记忆的 frontmatter 含 15 个字段（id/type/domain/profile/status/confidence/verified/source/session_id/project/created/last_confirmed/confirmations/supersedes/superseded_by/tags）。索引列同时存**文件内容哈希**（catch-up 检出 Obsidian 外部编辑）与**归一化正文 content-hash**（三处写入路径共用幂等去重），两者分工明确。

## 记忆生命周期

四层：L0 热层 `MEMORY-INDEX.md`（≤80 行派生视图）/ L1 active / L2 stale（降权 ×0.5，检索排序可见）/ L3 archived。三个机制：显式取代 `supersede` > 确认刷新 `reconfirm` > 时间衰减（V0.1 不做）。**永不自动删除**——`omem redact` 是唯一硬删入口，且会同步移除索引行。

## 执行流程

1. `omem init` 建库并打开空索引，然后默认扫描 Claude Code、WorkBuddy、Cursor。剥掉系统包装后，每个会话写成 `sessions/<agent>/<session_id>.md`。这一步不写 `knowledge/`。`--no-scan` 只建库。
2. 会话索引在写入原文时更新。结论索引要等 `knowledge/` 里有条目。`omem search` 只查结论；`omem search --sessions` 查原文。
3. 结论只从 `save_memory`、`omem add`，或显式 `omem run --tier api` 进入 `knowledge/`。带 `supersedes` 时旧结论变为 `superseded`，默认检索不再返回。两条相反结论不会自动分出对错。已经落盘的规则碎片用 `omem redact --source rules` 一次性硬删。
4. `omem init` / `omem run` 把尚未产生结论的会话写入 `PROCESS.md`（每批最多 5 个）。omem 不调用模型。下一次打开客户端时，按 install 写入的说明去读这个文件并 `save_memory`。
5. 置信度在写入时按依据打分，条目仍是未确认：user 段里对得上的原文从 0.55 起，两个会话都能对上则 0.75，对不上封顶 0.35。对话里的 `confirm_ids` 只到 0.8，不标 `verified`。`omem add` 或 `omem review --confirm` 才到 0.9 并标已确认。

## 加工四档（默认零配置）

1. **规则抽取已移除。** `omem run --tier rules` 直接报错。配置里残留的 `default_tier = "rules"` 按 agent 处理。`exclude_keywords` 不再拦截写入。
2. **Agent 主动保存**（默认开）：MCP `save_memory`。有依据时自动打分，仍是未确认。
3. **Agent 协作引导**（默认档）：采集原文并写 `PROCESS.md`，由本地 Agent 读文件后写回结论。
4. **自带 API key**（可选，默认关）：`omem run --tier api`，OpenAI 兼容接口。

MCP sampling 在 V0.1 不可用。

## 从源码开发

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest：195 个单元用例（23 个文件）
npm run smoke      # 端到端冒烟：54 项断言（隔离 OMEM_HOME）
```

测试栈：Vitest 3（forks pool + `--experimental-sqlite` execArgv 注入）+ bash 冒烟 + 裸 JSON-RPC MCP 探针（同时断言 stdout 纯净——日志只走 stderr）。

## 安全基线

- 写入前脱敏：Anthropic/OpenAI key、GitHub token、AWS AKIA、JWT、PEM、通用口令（正则吸收 lore 的检测模式，MIT，见 NOTICE）
- 禁区路径：`exclude_paths`。`exclude_keywords` 不再过滤条目或会话
- work profile 默认禁同步/导出（退出码 2），`OMEM_PROFILE_LOCKED` 锁定
- 指令式语气低权 + 同会话多重印证封顶 0.6——候选信号低但可用
- 冲突只报告不自动合并；远端版另存 `.conflict.md`，本地版保留

## 许可

MIT（见 LICENSE）。第三方组件归属与许可证见 [NOTICE](./NOTICE)。
