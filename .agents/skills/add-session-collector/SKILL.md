---
name: add-session-collector
description: >-
  为 omem 增加只读会话采集器，把新 Agent 的会话转成 Unified Session Schema 并注册进 scanSessions。
  在接入 Qoder、Kimi、WorkBuddy、Cursor、Claude Code 或其他平台的会话、新增 collector、改 omem run 扫描范围时使用。
  不用于 MCP install 接线。
---

# 增加会话采集器

加工层只认 `SessionDigest`。新平台只加一个只读适配器，并在注册表挂一行。不要改抽取规则来迁就某种 JSON。

已注册：`claude-code`、`workbuddy`、`cursor`。对照 `src/collect/` 里同形态的那个，不要从零发明目录布局。

## 先分清两件事

- **会话采集**（本技能）：`omem run` 读会话文件，产出记忆。入口是 `src/collect/collector.ts`。
- **MCP 接线**：`omem install` 写客户端配置。入口是 `src/install/clients.ts`。用户没要求接线时不要改它。

## 硬约束

- 只读。解析器用 `readFileSync` / `readdirSync` / `statSync`。禁止写入、截断、删除对方的会话、SQLite、`mcp.json`、指令文件。
- 探查本机真实会话时只打印字段名、类型、条数。不要把正文、密钥写进仓库、测试输出或回复。
- 单测和冒烟禁止扫用户真实目录。配置用绝对路径；`~` 开头才会吃环境变量。
- 某个采集器的目录不存在时只记一条提示，不能让 `scanSessions` 提前返回、丢掉其他采集器。
- 损坏行跳过。没有有效消息时 `parse` 返回 `null`。
- 子代理、推理、工具调用、工具结果、快照、摘要行不进入 `messages`。只留 user / assistant 的纯文本。

## 工作流

复制这份清单再做：

```
- [ ] 1. 只读确认会话落在哪、一行 JSON 有哪些键
- [ ] 2. 写 list + parse，映射到 SessionDigest
- [ ] 3. 注册到 collector、config、pipeline 的环境变量提示
- [ ] 4. 合成 fixture 单测；流水线测试把新目录指到不存在的路径
- [ ] 5. 冒烟用空目录挡住真实主目录
- [ ] 6. npm test 通过。若要做本机验证，只复制到临时目录并核对源文件哈希
```

### 1. 确认格式

在对方数据目录里找会话文件（常见是 `*.jsonl`）。用脚本统计：行类型、顶层键、`content` 是字符串还是数组、文本块的 `type`。不要打印 `text`。

对照现有三种，选最接近的写法：

| 采集器 | 列表 | 一行里怎么认消息 |
| --- | --- | --- |
| `claude-code` | `<root>/<project>/*.jsonl`，不递归 | `type` 为 `user` / `assistant`；正文在 `message.content`。跳过 `summary`、`isSidechain`、`tool_use` |
| `workbuddy` | 同上，一层 | `type === "message"`，`role` 在顶层；正文块是 `input_text` / `output_text`。跳过 `reasoning`、`function_call`、快照 |
| `cursor` | `<root>/<project>/agent-transcripts/<id>/<id>.jsonl` | 无 `type`。`role` + `message.content[]` 里 `type === "text"`。不列 `subagents/` |

### 2. 适配器文件

新建 `src/collect/<id>.ts`。文件头一行中文注释，说明会话路径和过滤规则。

```ts
export function listXxxSessions(root: string, opts?: { since?: Date }): SessionFile[]
export function parseXxxFile(path: string): SessionDigest | null
```

`SessionFile` 用 `src/collect/claude-code.ts` 里的类型。`SessionDigest` / `UnifiedMessage` 用 `src/collect/types.ts`。

字段约定：

- `agent` 用稳定短 id，与注册表一致，例如 `qoder`。
- `session_id` 默认是文件名（去掉 `.jsonl`）。行内若有自己的 id，消息上的 `session_id` 与 digest 保持一致。
- `msg_uuid` 优先用对方的消息 id，否则 `` `${sessionId}#${行号}` ``。
- `content` 只拼接文本块。工具参数不要留在字符串里。
- 有 `cwd` 时才调用 `resolveProjectFp(cwd)`（它只读 `git config`）。没有 cwd 则 `project_fp` 为 `unknown`，不要为了指纹去写 git。
- 时间缺失时用稳定的占位 ISO，不要用 `new Date()`，避免同一文件每次解析出不同 digest。

### 3. 注册

按这个顺序改，缺一处 `omem run` 就扫不到或测试会扫进用户主目录。

1. `src/collect/collector.ts`：`COLLECTOR_IDS` 追加 id；`getCollector` 增加分支。路径以 `~` 开头时用 `rootFrom(configured, 'OMEM_<ID>_PROJECTS')`。列表函数不要误用别的采集器的过滤器。
2. `src/core/config.ts`：`OmemConfig.collect`、`defaultConfig`、`fromParsed`、`serializeConfig` 各加 `xxx_projects`，默认 `'~/.xxx/projects'`（以你核实的真实目录为准）。旧配置缺这个键时回退默认值。
3. `src/process/pipeline.ts` 的 `ROOT_ENV` 加上该 id → `OMEM_<ID>_PROJECTS`。缺目录的提示从这张表来。
4. `src/cli.ts` 的 `run` 描述、`README.md` 命令表、`docs/手动测试指南.md` 第 2 节、`AGENTS.md` 模块表，补上这个采集器名字。各写一句，不要重写文档。

不要把新采集器写进 `omem install` 的客户端表，除非用户同时要求 MCP 接线。

### 4. 测试

`tests/unit/<id>-collector.test.ts`：在临时目录写合成 JSONL，不要提交真实会话。

- 保留的用户句还在；工具、推理、子代理标记不在。
- 解析前后 `size` 与 `mtimeMs` 不变。
- 若格式与 Claude Code 不同，`parseSessionFile` 对该文件返回 `null`。
- 用 `extractFromDigest` 确认用户句能进规则抽取。合成句沿用「以后都用手写 SQL」，与现有 fixture 一致。

`tests/unit/collector.test.ts`：`COLLECTOR_IDS` 断言加上新 id；`scanSessions` 用临时绝对路径扫到它。再断言「目录不存在时，其他采集器的 digest 仍在」。

`tests/unit/pipeline.test.ts` 的 `isolateOthers`：把新的 `*_projects` 指到不存在的目录。否则 `defaultConfig()` 会去扫开发者机器上的真实会话。

### 5. 冒烟与本机验证

`tests/smoke.sh` 在隔离 `OMEM_HOME` 之后导出 `OMEM_<ID>_PROJECTS`，指向一个空目录（可放在 `.omem-test/` 下，跑完即删）。冒烟不得读取 `~/.qoder`、`~/.kimi` 或其他真实会话目录。

本机验证只在用户明确要求时做，沿用 `tests/live/verify-local.mjs`：

- 复制到临时目录再解析。
- `omem run` 的环境变量全部指向副本或空目录。
- 结束时比对源文件 SHA-256，以及对方的配置文件大小和 mtime。
- 临时目录在 `finally` 里删除。

## 完成标准

- `getCollector('<id>')` 返回该适配器；未知 id 仍抛「未知采集器」。
- `npx vitest run tests/unit/collector.test.ts tests/unit/<id>-collector.test.ts tests/unit/pipeline.test.ts` 通过。
- 会话源文件没有任何写入。
