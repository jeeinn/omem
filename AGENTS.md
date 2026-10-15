# AGENTS.md

给在本仓库里改代码的代理。用户可见行为以源码和 `docs/omem-V0.1技术规格草案.md` 为准；README 是对外说明，改行为时一并更新。

## 项目

omem 是 git 原生的个人级 AI 记忆层（V0.1，TypeScript，Node ≥ 22.5）。一条记忆 = 一个 Markdown 文件。`knowledge/` 与 `archive/` 是事实源；`index/omem.db`（SQLite + FTS5 trigram）是可删除、可 `omem rebuild` 的派生索引。MCP 让多个客户端共享同一份记忆。

运行期数据在 `OMEM_HOME`（默认 `~/.omem`）。开发、测试、冒烟一律使用隔离目录，禁止读写用户真实的 `~/.omem`。

## 不可违背

- **永不自动删除。** `gc` 只把条目标成 `stale`（检索降权 ×0.5）。硬删只有 `omem redact`，且必须同时删 Markdown 与索引行。归档是移到 `archive/` 并置 `status=archived`，文件仍留在版本控制里。
- **冲突只报告。** 同步不自动合并。远端版本另存 `.conflict.md`，本地版本保留。遍历记忆文件时跳过 `*.conflict.md`。
- **Markdown 是事实源。** `store` 不缓存，每次读盘。外部编辑（如 Obsidian）靠 connect-time catch-up 吸收：`(size, mtime)` 快路径，文件内容哈希慢路径。
- **两种哈希不要混用。** 文件内容哈希检出外部编辑；归一化正文 `contentHash`（`body_hash`）做三处写入路径的幂等去重。
- **自动加工产物恒为 `verified: false`。** 只有用户显式 `omem add` / `review --confirm` 才标已确认。指令式语气（「必须 / 一律 / 永远」）置信度减半并打 `low-weight`。
- **写入前脱敏。** 入库路径必须过 `redactSecrets`。禁区是 `exclude_paths` 与 `exclude_keywords`。
- **work profile 默认禁止同步与导出**（`ProfileBlockedError`，退出码 2）。放行只认 `OMEM_ALLOW_WORK_EXPORT=1`。`OMEM_PROFILE_LOCKED=1` 锁定档案。
- **MCP stdout 只走协议。** 日志写 stderr 或 `logs/omem.log`。默认工具只有 `search_memory` / `save_memory`；`memory_feedback` 由 `OMEM_MCP_TOOLS=feedback` 打开。不要扩大默认工具面。
- **install 六条写入纪律：** 只 merge `mcpServers.omem`（或该客户端对应的一个键）、先备份、原子写、幂等更新、解析失败则打印手工片段而不覆盖、收尾提示重启客户端。
- **git 配置只写数据仓本地。** 禁止改用户全局 git config。检测不到 git 时返回可操作提示（`BackendUnavailableError`），不要抛裸栈。

退出码：`0` 成功（含已处理的冲突）、`1` 用法错误（`UsageError`）、`2` 后端不可用或策略拒绝。

## 模块

| 路径 | 职责 |
| --- | --- |
| `bin/omem.js` | 启动包装：缺 `--experimental-sqlite` 时 re-exec；Windows 上动态 import 必须用 `file://` URL |
| `src/cli.ts` `src/cli-args.ts` | 命令分发。被 import 时不得自行 `process.exit`（`OMEM_CLI_ENTRY`） |
| `src/commands/` | 一个命令一个文件，返回退出码 |
| `src/core/` | 条目、路径、配置、存储、索引、检索、生命周期、档案、脱敏、快照 |
| `src/collect/` | 会话采集。已注册 `claude-code`、`workbuddy`、`cursor`，都只读。新平台见下方「技能」 |
| `src/process/` | 加工：`rules`（默认）/ `pipeline` / `guide`（agent）/ `api`（默认关） |
| `src/mcp/` | stdio MCP server 与工具实现 |
| `src/install/` | 客户端注册表、配置写入、TOML 子集 |
| `src/sync/` | `SyncBackend`。V0.1 只实现 `GitBackend`；`webdav` / `dir` 抛出「尚未交付」 |
| `src/context/export.ts` | 非 MCP 客户端的上下文导出 |
| `tests/unit/` | Vitest。`tests/smoke.sh` 与 `tests/mcp-probe.mjs` 是端到端 |

frontmatter 是扁平 YAML 子集（字符串 / 数字 / 布尔 / 字符串数组），字段顺序见 `src/core/entry.ts` 的 `FM_ORDER`。配置是 `config.toml` 的 TOML 子集，只保证 omem 自己写出的文件无损往返。

记忆路径：`knowledge/<domain>/<YYYY>/<id>.md`，id 形如 `2026-10-15-a1b2c3`。类型只有 `preference | fact | decision | experience`。

## 命令

```bash
npm install
npm run build          # tsc → dist/；发布物从 dist 跑，改 src 后先 build
npm test               # vitest，forks + --experimental-sqlite
npm run smoke          # bash tests/smoke.sh，自带隔离 OMEM_HOME
```

Node 使用内建 `node:sqlite`，不要引入 `better-sqlite3` 或其他原生模块。运行时依赖只有 `@modelcontextprotocol/sdk`。

## 代码约定

- ESM、`NodeNext`：仓库内 import 写 `.js` 后缀。`strict: true`。
- 文件头用一行中文注释说明职责，并在必要时引用规格章节（`规格 §x.y`）。用户可见文案用简体中文。
- 持久化写入走 `atomicWrite`（临时文件 + `rename`）。CLI 与 MCP 路径用同步 IO。
- 新命令：在 `src/commands/` 实现，在 `src/cli.ts` 的 `COMMANDS` 注册 `desc` / `usage` / `run`，补单元测试。
- 新同步后端或采集器：实现接口并在注册表加一行；未交付的 id 返回可操作错误，不要留空实现。新的会话采集器先读 `.agents/skills/add-session-collector/SKILL.md`。
- 产品行为不要自行发明。V0.1 不做时间衰减、不做 WebDAV/本地目录同步、不做 MCP sampling。

## 技能

仓库根的 `.agents/skills/<name>/SKILL.md` 是跨客户端技能目录（[Agent Skills](https://agentskills.io/specification)）。Cursor、Claude Code、Codex 等都从这里发现技能。不要把项目技能放进 `.cursor/skills/`。

| 技能 | 何时读 |
| --- | --- |
| `.agents/skills/add-session-collector/SKILL.md` | 为 Qoder、Kimi 或其他 Agent 增加只读会话采集 |

## 测试

- 用 `tests/unit/helpers.ts` 的 `makeHome()` / `cleanupHome()` 建临时库，测完删除。
- 单测 import `src/`，不要 import `dist/`。覆盖 `src/cli.ts` 时直接调用导出的 `main()`，不要把模块当进程入口。
- 索引相关测试依赖 FTS5；改 `vitest.config.ts` 时保留 `pool: 'forks'` 与 `--experimental-sqlite`。
- 动到 MCP、install 写入或同步时，除单测外跑 `npm run smoke`。MCP 探针要断言 stdout 无日志。
- 不提交 `dist/`、`node_modules/`、`.omem-test/`。
