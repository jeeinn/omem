# omem

**你的记忆是一个 git 仓库，不是一个数据库文件。**

omem 是本地的个人 AI 记忆层：一条记忆一个 Markdown 文件，SQLite 只是可以删掉重建的索引。MCP 让多个客户端共用同一份记忆。

- 默认零配置：`omem sync` 把对话原文放进 `sessions/`，结论由 Agent 写回 `knowledge/`
- 采集只读：Claude Code、WorkBuddy、Cursor、千问办公（QwenWork）、豆包办公（Doubao）、CodeBuddy 等 9 个平台的会话目录，不改对方的文件
- Markdown 是事实源，Obsidian 里改完，下次访问会吸回索引
- `omem backup` 用 git 做备份和跨机器同步；冲突只报告，不自动合并
- 不自动删除。硬删只有 `omem redact`
- MCP 默认只暴露 `search_memory` / `save_memory`

分层、数据流和目录见 [技术架构](./ARCHITECTURE.md)。

## 状态

V0.1，公开测试版 `0.1.0-beta.5`（`npm install -g @jeeinn/omem@beta`）。beta 期间不保证兼容。尚未用真实会话做完质量验证。

从 beta.4 升级时命令名变了：

- 采集会话用 `omem sync`。`omem run` 已删除
- 备份数据仓用 `omem backup`。它不再叫 `omem sync`
- `omem pause` / `omem resume` 已删除
- `omem review` 默认只列出最近 10 条；`omem review <id>` 打开正文

备份只交付 git。WebDAV 与本地目录后端还没有。从 beta.1 升级时：规则抽取已移除，`knowledge/` 只放结论；`omem install` 在非交互环境必须带 `--target`；`omem redact --source` 默认只预览。旧规则碎片用 `omem redact --source rules --yes` 删掉。

包名带 scope 是因为 npm 认为裸名 `omem` 与已有包太像。安装后命令名仍是 `omem`。CLI 输出是英文，本文和 `docs/` 是中文。

## 环境

- Node.js ≥ 22.5（内建 `node:sqlite`，无需原生编译）
- git（仅 `omem backup` 需要；没有 git 时给出安装提示，不抛栈）

唯一需要原生二进制的依赖是 `@toondepauw/node-zstd`——DeepSeek Harness 的会话是 zstd 压缩的，采集时要解压。它提供预编译包（Windows / macOS / Linux，x64 与 arm64），不需要本地编译工具链。

## 安装

```bash
npm install -g @jeeinn/omem@beta
omem init
```

数据在 `~/.omem`，可用 `OMEM_HOME` 换位置。

### 多机同步

第一台机器：

```bash
omem init
omem backup remote git@gitee.com:you/omem-backup.git
omem backup          # pull（空远端，跳过）→ push（发布分支）
```

后续机器（**用 `--clone`，不要直接 `init`**，否则两边历史不相干会 pull 失败）：

```bash
omem init --clone git@gitee.com:you/omem-backup.git
omem sync            # 采集本机会话
```

如果某台机器已经有了不相干的本地历史，`omem backup pull` 会自动用 `--allow-unrelated-histories` 合并；也可以手动重置：

```bash
omem init --force --clone git@gitee.com:you/omem-backup.git   # 丢弃本地 git，重新从远端克隆
```

Windows 上若 MCP 起不来，把客户端配置改成用 node 直接启动：`"command"` 填 `node.exe` 绝对路径，`"args"` 为 `["<全局 node_modules>/omem/bin/omem.js", "serve"]`。

## 快速开始

```bash
omem install
omem sync --since 30d
omem review --ui                # 浏览器里勾选，一次提交
omem review --confirm <id>      # 也可以命令行确认单条（支持 id1,id2 批量）
omem add "部署时 docker 镜像构建失败，改用国内源后恢复" --type experience
omem search "镜像拉取"
omem backup remote git@github.com:you/omem-memory.git
omem backup
```

`omem install` 默认只预选路径已核实的客户端。非交互环境要写 `omem install --target claude-code,cursor`。不在列表里的客户端用 `omem install --print-config generic`。千问办公（QwenWork）、豆包办公（Doubao）、DeepSeek Harness 与 Qoder IDE 的 MCP 配置在应用内部管理，没有可写文件：`omem install --target qwenwork,doubao,deepseek,qoder` 会打印应用内添加指引（设置 → 连接器 / MCP，或在会话里让 agent 添加 `omem serve`）。

CodeBuddy 的 MCP 配置在 `~/.codebuddy/mcp.json`（中文版 `~/.codebuddycn/mcp.json`），是普通 JSON 文件，可以直接写：`omem install --target codebuddy`。

接入后，会话里可以直接用 `search_memory` / `save_memory`。`memory_feedback` 要用 `OMEM_MCP_TOOLS=feedback` 才打开。

`add` 和 `sync` 不自动 commit。`omem backup` 在拉取前会把未提交改动收成一次提交，冲突时保留本地版，远端版写成 `.conflict.md`。

## 采集器支持列表

| ID | 采集源 | 说明 |
| --- | --- | --- |
| `claude-code` | Claude Code | 会话 JSONL，`~/.claude/projects/` |
| `workbuddy` | WorkBuddy | 会话目录 |
| `cursor` | Cursor | 对话记录 |
| `qwenwork` | 千问办公（QwenWork） | 会话目录 |
| `doubao` | 豆包办公（Doubao） | 会话目录，`%LOCALAPPDATA%` |
| `deepseek` | DeepSeek Harness | 会话目录（zstd 压缩，读时解压） |
| `qoder` | Qoder IDE | 国际版 + 中文版双根 |
| `catpaw` | CatPaw | 会话纯文本，`~/.catpaw/projects/` |
| `codebuddy` | CodeBuddy | 会话 JSONL，国际版 + 中文版双根（`~/.codebuddy` / `~/.codebuddycn`） |

每新增一个采集器，在此表追加一行。`omem sync --collectors id,id` 可指定子集；不指定时扫全部。

每个采集器的会话根目录都可以用环境变量覆盖（例如 `OMEM_CATPAW_PROJECTS`、`OMEM_QODER_PROJECTS`）。这主要用于测试隔离——把变量指向临时目录，就不必改动真实会话目录。完整变量名清单见 `src/collect/registry.ts`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `omem init [--force]` | 只建库（数据目录、配置、git 数据仓）。已初始化时提示用 `--force` 重置（删除 `.git` 重新 `git init`）。采集用 `omem sync` |
| `omem install` | 写入客户端 MCP 配置。`--target` 跳过交互，`--print-config` 只预览 |
| `omem sync [--since 7d] [--collectors id,id] [--tier agent\|api] [--limit N]` | 采集会话到 `sessions/`，并更新 `PROCESS.md`。不带 `--collectors` 时扫全部已有目录 |
| `omem api status` | 查看 API 档的生效配置、队列和模型 |
| `omem add <content>` | 手工添加，自动脱敏 |
| `omem search <query>` | 查结论。`--sessions` 查原文，`--detail` 打出正文 |
| `omem review [<id>]` | 待审默认最近 10 条。带 id 打开正文；`--confirm <id\|id,id>` / `--dismiss` / `--stale` 确认、归档或冷却 |
| `omem review --ui` | 起一个本地页面，勾选后一次提交。`--no-open` 只打印链接，`--port N` 指定端口，`--timeout SEC` 改超时（默认 600） |
| `omem topic list [--all]` | 列活文档主题（文档数 / 最近更新 / 置信度 / 标题）。`--all` 额外列出已被合并掉的旧主题 → 现在归到哪个文档 |
| `omem gc [--days N]` | 把长期未确认的条目标成 stale，不删除 |
| `omem rebuild` | 从 Markdown 重建索引 |
| `omem context --for claude-code\|cursor\|codex\|plain` | 给不走 MCP 的客户端导出上下文 |
| `omem backup` | git pull 然后 push。子命令：`status` / `pull` / `push` / `remote` / `use` |
| `omem profile [home\|work]` | work 档默认禁止备份和导出 |
| `omem redact --id <id>` | 唯一硬删。`--source` 默认只预览，`--yes` 才删 |
| `omem snapshot` | 手动快照。backup 前也会自动打，保留 7 份 |
| `omem serve` | MCP server，由 install 写好的配置拉起 |
| `omem audit [--tail N]` | 看 `logs/omem.log` 尾部 |

退出码：`0` 成功（冲突已处理也算成功），`1` 用法错误，`2` 后端不可用或策略拒绝。

## 结论从哪来

默认不调用模型。`omem sync` 只把原文放进 `sessions/`，并在 `PROCESS.md` 里列出还没写进活文档的会话。Agent 读这份文件，用 `save_memory` 或 `omem add --topic` 写回。同一主题已有 active 文档时必须带 `supersedes`。

置信度按证据打：对得上 user 原文从 0.55 起，两个会话印证到 0.75，对不上封顶 0.35。`confirm_ids` 最多到 0.8，不标已确认。`omem add` 或 `omem review --confirm` 才到 0.9 并标 `verified`。

可选的 API 档：`omem sync --tier api`。本机回环端点免 key；云端必须 key，且必须 https。建议 key 放在 `OMEM_API_KEY`，不要写进 `config.toml`，否则 `omem backup` 会把它推进 git 仓库（写入时会警告）。`--limit` 默认 20，非本机的配置值最高 50，只有命令行 `--limit` 能再高。`--dry-run` 不发请求。

```bash
omem sync --tier api --model minicpm5-2b --limit 5
$env:OMEM_API_KEY = 'sk-xxx'
omem sync --tier api --base https://api.deepseek.com/v1 --model deepseek-chat
```

## 主题（topic）

`topic` 是活文档的标识，**可选**，只写在 frontmatter 里，不影响文件路径——`knowledge/coding/2026/` 下既有 `coding` 这个 domain，也可能放着十几个不同主题的文档。

```bash
omem add "连接池上限 20，超过就排队" --topic pool-tuning
omem topic list          # 有哪些主题
omem topic list --all    # 连已经合并掉的旧主题一起看
```

同一主题同时只有一份 active 文档。要更新它，必须指向当前那份：

```bash
omem add "连接池上限 20，超过排队（补充：不要盲调大）" --topic pool-tuning --supersedes <id>
```

不传 `supersedes` 会被拒绝，`--force` 也不绕过。更新是整篇覆盖：旧版置 `superseded`、文件留在原目录、默认检索不再返回；`source_sessions` 会继承累积，`evidence` 和 `verified` 不继承。

**三种「看不见」的补救**：

| 情况 | 现在会怎样 |
| --- | --- |
| 不知道库里有哪些主题 | `omem search` 的命中行带 `topic:xxx`；`PROCESS.md` 附一份 `## Existing topics` 词表 |
| 新主题和老主题只差一两个字 | 写入时告警「is close to existing "xxx"」，但照常写入 |
| 用新主题取代了别的主题的文档 | 写入时告警「Merged N topic(s) into "xxx"」，并列出消失的主题名 |

最后一种不阻止、只提示：合并本身是合法操作，但那些主题名之后就搜不到了（`omem search --all` 才看得到）。`omem topic list --all` 会给出「旧主题 → 现在归到哪个文档」的映射。

## 图形化审阅（`review --ui`）

积压几十条时逐条敲命令不现实。`omem review --ui` 起一个只绑 `127.0.0.1` 的页面：左边是队列，右边是正文、evidence 和来源会话标题，勾选后点一次 Apply 全部落盘。

```bash
omem review --ui                  # 提示后按 Enter 打开浏览器
omem review --ui --no-open        # 只打印链接，自己开
omem review --ui --topic fm-cmp --timeout 300
```

**分级落章**：批量勾选的天花板不是「确认」，而是「同意」。

| 你的操作 | 结果 |
| --- | --- |
| 勾选，但没展开这条的正文 | `assent`：confidence 保底 0.8，`verified` 仍为 false |
| 勾选，且展开过正文 | `confirm`：confidence 0.9，`verified: true` |

「展开过」由服务端记录（`GET /api/detail/<id>`），前端改不了。这条门槛的目的很直接：`verified` 决定 `MEMORY-INDEX.md` 的排序，应该为它付出阅读成本。批量全选只能拿到 0.8。

其它细节：

- 终端里的 `Enter` 只是「授权打开浏览器」，提交的唯一入口是页面按钮
- `Ctrl+C` 任何时刻都是关闭服务、零写入、退出码 0；超时（默认 10 分钟）同样零写入
- 提交前自动打一次 `snapshot`，保留 7 份
- 页面打开期间条目可能被 Agent 更新：提交时逐条重校验 status，已 superseded 的跳过而不是整批失败

## 定时采集

没有常驻进程。新会话要靠再跑一次 `omem sync`。内容没变的会话会跳过。

```bash
*/30 * * * * /path/to/omem/scripts/collect.sh >> /tmp/omem-collect.log 2>&1
```

```powershell
schtasks /Create /TN "omem-collect" /SC MINUTE /MO 30 /F ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\path\to\omem\scripts\collect.ps1\""
```

`scripts/collect.sh` 和 `collect.ps1` 只是 `omem sync` 的封装，不进 npm 包。定时任务会重写 `PROCESS.md`；Agent 正在读的那一版可能过期，间隔别短于 30 分钟。采集不写结论。

`PROCESS.md` 也会在每次写入结论后（`save_memory` / `omem add`）立即重算，所以 Agent 读到的一定是最新待办，不会重复处理已吸收的会话。这两类写入都不自动 commit——记忆先留在工作区，`omem backup` 才把它提交进 git 历史。

## 开发

```bash
npm install
npm run build
npm test
npm run smoke
```

行为以源码和 `docs/omem-V0.1技术规格草案.md` 为准。已落地的旧规划在 `docs/archive/`。

## 安全

- 写入前按通用形态脱敏：API key、token、JWT、PEM、口令。身份证、手机号、薪资这类内容不会自动过滤
- `exclude_paths` 跳过路径。`exclude_keywords` 已删除
- work 档默认禁止 `omem backup` 和 `context` 导出，退出码 2。`OMEM_ALLOW_WORK_EXPORT=1` 临时放行，`OMEM_PROFILE_LOCKED=1` 锁定档案

## 配置文件

`config.toml` 是唯一配置入口，手写内容会被保留。

- **已失效的键**（比如 `exclude_keywords`、`default_tier = "rules"`）：`omem init` 会点名提示，让你手动删掉那行。它不自动改——自动改会丢掉你手写的未知键。
- **新版本新增的键**（比如新采集器的 `*_projects`）：`omem init` 会把它们补写进去并给出行名，让你看得见、改得动。补写是文本级插入，不会重排你的其他内容。

两个方向都是同一件事：不让「你以为的配置」和「实际生效的配置」长期不一致。

## 许可

MIT，见 [LICENSE](./LICENSE)。第三方归属见 [NOTICE](./NOTICE)。
