# `omem process` 命令方案

> 状态：现行决策（与源码同步）。动机来自 2026-11-06 实测：`omem sync --tier api` 总是先扫采集器，再 drain API 队列，把「只想加工存量」和「采集」绑死；非本机端点默认 `timeout_ms=60s` 时，小会话也会出现 `transport_failed`（超时），被误读成抽取失败。

## 1. 动机

产品事实：

- `omem sync` 的默认路径是**零模型**：采集会话 → 写 `sessions/` → 刷新 `PROCESS.md`。
- API 档是**可选旁路**：用 OpenAI 兼容端点从待加工队列抽出活文档。
- 把 API 加工挂在 `sync --tier api` 上，只为「命令面收敛」：用户跑 `sync --tier api --limit 3` 时采集器仍会先扫一遍，心智模型错误，日志也混杂。

决策：

| 命令 | 职责 |
| --- | --- |
| `omem sync` | 只采集 + 刷新 `PROCESS.md`；**永不调模型** |
| `omem process` | 只 drain API 待加工队列；**不扫采集器** |

二者互不依赖：可以先 sync 再 process，也可以只 process 已有 `sessions/`。

## 2. 命令契约

```text
omem process [--limit N] [--base URL] [--model NAME] [--dry-run] [--since 7d|YYYY-MM-DD] [--session <id>]
```

| 项 | 约定 |
| --- | --- |
| 输入 | 已落盘的 `sessions/` + 会话索引里的 `api_state`（`materializeQueue`） |
| 不做 | 不调用任何 collector / `scanSessions` |
| dry-run | 打印端点、队列深度、粗估 token；**零网络、不改 `api_state`** |
| 成功提交文案 | `omem: process N session(s), M document(s)`（不是 `sync`） |
| 退出码 | 同现有：0 成功；1 用法；2 端点不可用 / 策略拒绝 |
| 置信度 | 仍走 `scoreApiDoc`，封顶 `SCORE_API_CAP`（0.75） |
| 脱敏 | 仍经 `redactSecrets`（commit 路径） |

实现：从 `runPipelineAsync` **抽出**共享的 `runApiProcess(...)`（队列 + 抽取 + 落盘 + 刷 guide），禁止复制粘贴一份第二实现。`omem process` 与兼容路径都调用它。

## 3. 从 `sync --tier api` 迁移

| 旧用法 | 新行为（本版本） |
| --- | --- |
| `omem sync --tier api …` | 打印 deprecation 警告，**只跑 process**（不采集），指向 `omem process` |
| `omem sync`（无 `--tier`） | 永远只采集；`process.default_tier = "api"` **不再**让裸 sync 调模型，并提示改用 `omem process` |
| `omem sync --tier agent` | 与无 `--tier` 相同（显式 agent） |
| `omem sync --tier rules` | 仍 UsageError（已移除） |

下一版可改为：`--tier api` 直接拒绝并只提示 `omem process`。本版保留薄包装，避免存量脚本一夜断裂。

诊断入口从 `omem sync --tier api --dry-run` 改为 **`omem process --dry-run`**（错误 hint、Next 段、文档一律对齐）。

## 4. 非目标

- 不恢复 `--tier rules` / 规则抽取。
- 不引入向量库、daemon、或第二套队列存储。
- 不把 API 加工绑回 sync「为了命令面少一条」。
- 不在本方案里改默认超时数值（60s 非本机 / 300s 本机仍由 `resolveApiConfig` 决定）；README 推荐非本机端点显式加大 `timeout_ms`。
- 不在 Summary 行强制表面「最后一次 transport 错误」（nice-to-have，可另开任务）。

## 5. README API 配置指引（要点）

完整文案落在仓库根 `README.md`「结论从哪来」一节，本处只钉契约：

1. **入口**：`omem process`（不是 sync）。
2. **base**：云端必须 `https://…/v1`；本机回环免 key。
3. **key**：只经 `OMEM_API_KEY`（或安装方注入的环境变量）；**不要**写进 `config.toml`——`omem backup` 会把配置推进数据仓 git。
4. **model / limit / timeout_ms / max_input_chars**：配置或 CLI 覆盖；非本机建议 `timeout_ms` 提到 `120000`–`300000`（SenseNova 等 flash 端点在小会话上仍可能卡满默认 60s）。
5. **`--dry-run`**：看端点与队列，不发请求。
6. **出站警告**：非本机时终端已提示「会话正文会离开本机」；业务内容不脱敏，只有通用密钥形态会 redact。
7. 示例覆盖本机 Ollama 与 OpenAI 兼容云端（含 SenseNova 风格 https base）。

## 6. 测试计划

| 覆盖 | 断言要点 |
| --- | --- |
| 单元：`runApiProcess` | dry-run 零网络；`--limit`；队列 / 隔离 / 中止；git 提交信息含 `process` |
| 单元：`omem process` CLI | 不扫采集器即可加工存量；`--limit` 透传 |
| 单元：`omem sync` | 永不调模型；`--tier api` 打印 deprecation 且不采集；`default_tier=api` 的裸 sync 只采集并提示 |
| 守门：`cli-surface` | 命令表 14 条含 `process`；诊断入口改为 `omem process --dry-run` |
| 文案：`run-summary` / `endpointUnavailableError` | Next / hint 指向 `omem process` |
| smoke | 保留 sync 采集冒烟；可加 `process --help` / `--dry-run` 出口；文档一致性随 README 更新 |
| 非协商 | Markdown 事实源、API 置信度封顶、verify 只报告、默认 MCP 工具面不变、无密钥入库 |

验收：`npm test` 绿；触及 CLI / docs 时 `npm run smoke` 绿；PR 不含任何真实 API key。
