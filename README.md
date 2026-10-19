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

公开测试版本：`0.1.0-beta.2`（`npm install -g @jeeinn/omem@beta`）。beta 期间的破坏性变更不保证兼容，正式版会先完成真实会话数据的质量验证。

**beta.1 → beta.2 的破坏性变更**（升级前请先看，行为变化不小）：

| 变更 | beta.1 | beta.2 |
| --- | --- | --- |
| 默认产物 | 规则抽取的片段写进 `knowledge/` | 会话对话原文写进 `sessions/`，`knowledge/` 只放结论 |
| `omem run --tier rules` | 可用 | **报错退出码 1**（规则抽取已移除） |
| 配置 `default_tier = "rules"` | 触发规则抽取 | 按 `agent` 处理（`omem init` / `omem run` 会提示你改成 `"agent"`） |
| `omem install` 非交互（CI/管道） | 自动全装 | **报错，必须显式 `--target`** |
| `omem redact --source <s>` | 直接删 | **默认只预览，必须 `--yes` 才删** |
| 配置 `exclude_keywords` | 存在（但已不生效） | **已移除**；`omem init` / `omem run` 会提示删掉残留行 |

升级后已落盘的旧规则碎片不会被自动清理，用 `omem redact --source rules --yes` 一次性删除（先不加 `--yes` 看预览）。

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

Git 数据仓只在首次（`omem init` 或第一次 `omem sync`）建立；此后每次 `omem sync` 会把本次改动提交为一笔 `omem: sync <时间>`，所以 `git log` 里每一笔都能回溯到具体哪次同步动了哪些记忆。

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
| `omem pause` / `omem redact --id <id>` / `omem redact --source <s> [--yes]` | 暂停加工 / 硬删一条 / 按来源批量硬删（**默认只预览，必须 `--yes` 才删**） |
| `omem snapshot` | 手动快照（push 前自动快照，滚动保留 7 份） |
| `omem serve` | MCP server（stdio；由 install 写入的配置自动拉起） |
| `omem audit [--tail N]` | 使用日志尾部（默认 20 条 JSONL：commit / redact / run / sync 等事件） |

退出码：`0` 成功（含冲突已处理）/ `1` 用法错误 / `2` 后端不可用或策略拒绝（如 work profile 禁导出）。

## 数据布局

```
~/.omem/
├── config.toml              # 唯一配置入口
├── sessions/<agent>/<session_id>.md    # L0 原文
├── knowledge/<domain>/<YYYY>/<id>.md   # L1 主题活文档：同一 topic 一份 active，旧版 superseded
├── PROFILE.md                          # L2 预留，这一版不生成
├── PROCESS.md                          # 档 2 引导（派生，不进 git）
├── archive/<domain>/<YYYY>/<id>.md     # 归档层（L3）
├── index/                   # SQLite + FTS5（派生缓存，删了可 rebuild）
├── snapshots/YYYY-MM-DD/    # 快照（滚动保留 7 份）
└── logs/                    # JSONL 使用日志
```

一条记忆的 frontmatter 在原有字段上增加 `topic` 与 `source_sessions`。同一 `topic` 同时只有一份 active。索引列同时存**文件内容哈希**与**归一化正文 content-hash**。

## 记忆生命周期

生命周期四层（热层 / active / stale / archived）和上面的原文层、活文档层不是同一套编号。机制仍是：显式取代 `supersede` > 确认刷新 `reconfirm` > 时间衰减（V0.1 不做）。**永不自动删除。**

## 执行流程

1. `omem init` 建库并打开空索引，然后默认扫描 Claude Code、WorkBuddy、Cursor。剥掉系统包装后，每个会话写成 `sessions/<agent>/<session_id>.md`。这一步不写 `knowledge/`。`--no-scan` 只建库。
2. 会话索引在写入原文时更新。结论索引要等 `knowledge/` 里有条目。`omem search` 只查结论；`omem search --sessions` 查原文。
3. 结论按主题写入 `knowledge/`：`save_memory` 或 `omem add --topic`。该主题已有 active 文档时必须带 `supersedes`，否则拒绝并返回旧 id。`omem run --tier api` 仍默认关闭。检索默认只看 active 活文档；`omem search --sessions` 才查原文。已经落盘的规则碎片用 `omem redact --source rules --yes` 一次性硬删（不加 `--yes` 只预览）。
4. `omem init` / `omem run` 把尚未吸收进活文档的会话按主题写入 `PROCESS.md`（每批最多 5 个主题，并尽量给出该组当前活文档 id 供 `--supersedes` 使用）。omem 不调用模型。整理这份队列的对话本身不要存成新主题。常驻后台的 `omem watch` 与 L2 画像排在 V0.2（见 `docs/omem-V0.2技术规格草案.md`）。
5. 置信度在写入时按依据打分，条目仍是未确认：user 段里对得上的原文从 0.55 起，两个会话都能对上则 0.75，对不上封顶 0.35。对话里的 `confirm_ids` 只到 0.8，不标 `verified`。`omem add` 或 `omem review --confirm` 才到 0.9 并标已确认。

## 加工四档（默认零配置）

1. **规则抽取已移除。** `omem run --tier rules` 直接报错。配置里残留的 `default_tier = "rules"` 按 agent 处理。`exclude_keywords` 已从配置中删除：既不过滤条目，也不过滤会话原文（残留的旧配置行会被忽略，`omem init` 与 `omem run` 会点名提示删掉）。
2. **Agent 主动保存**（默认开）：MCP `save_memory`。有依据时自动打分，仍是未确认。
3. **Agent 协作引导**（默认档）：采集原文并写 `PROCESS.md`，由本地 Agent 读文件后写回结论。
4. **自带 API key**（可选，默认关）：`omem run --tier api`，OpenAI 兼容接口。

MCP sampling 在 V0.1 不可用。

## 定时采集（可选）

omem 没有常驻后台进程：新会话要被看见，得跑一次 `omem run`（幂等——内容没变的会话会被跳过，不会重复落盘）。真实仓（约 950 个会话）一次全量跑约 8 秒，所以交给系统调度即可，不必自己写守护进程：

```bash
# Linux / macOS（每 30 分钟）
*/30 * * * * /path/to/omem/scripts/collect.sh >> /tmp/omem-collect.log 2>&1
```

```powershell
# Windows：每 30 分钟跑一次（cmd 内执行，注意内层引号要转义）
schtasks /Create /TN "omem-collect" /SC MINUTE /MO 30 /F ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\path\to\omem\scripts\collect.ps1\""
```

`scripts/collect.ps1` 与 `scripts/collect.sh` 只是 `omem run` 的薄封装（支持 `--since 7d` 与 `--dry-run`，退出码透传），幂等性由 omem 自己的 content-hash 对账保证。这两个脚本随仓库分发，**不在 npm 包里**。

两点提醒：

- 定时任务会重写 `PROCESS.md`。写入是原子的（临时文件 + rename），不会读到半截内容，但 Agent 手里正在读的那一版可能已经过期——要么错开加工时段，要么把间隔调到 30 分钟以上。
- 采集只补原文，不写结论。队列涨得比消化得快是常态，别指望定时采集替你做蒸馏。

## 从源码开发

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest：217 个单元用例（26 个文件）
npm run smoke      # 端到端冒烟：60 项断言（隔离 OMEM_HOME）
```

测试栈：Vitest 3（forks pool + `--experimental-sqlite` execArgv 注入）+ bash 冒烟 + 裸 JSON-RPC MCP 探针（同时断言 stdout 纯净——日志只走 stderr）。

## 安全基线

- 写入前脱敏：Anthropic/OpenAI key、GitHub token、AWS AKIA、JWT、PEM、通用口令（正则吸收 lore 的检测模式，MIT，见 NOTICE）
- 禁区路径：`exclude_paths`
- **已知取舍**：脱敏只覆盖**能用通用正则表达**的密钥形态。领域相关的中文敏感词（薪资、身份证号、手机号、内网代号）**没有过滤机制，会原样落盘**。`exclude_keywords` 已移除，不要指望它生效——敏感内容请在写进会话前自行处理
- work profile 默认禁同步/导出（退出码 2），`OMEM_PROFILE_LOCKED` 锁定
- 指令式语气低权 + 同会话多重印证封顶 0.6——候选信号低但可用
- 冲突只报告不自动合并；远端版另存 `.conflict.md`，本地版保留

## 许可

MIT（见 LICENSE）。第三方组件归属与许可证见 [NOTICE](./NOTICE)。
