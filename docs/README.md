# docs 索引

先读 **Current**，再按需翻 **Archive**。Archive 只作背景，**不是开工依据**。

事实优先级（与 `docs/omem-v0.3-implementation-plan.md` 一致）：**源码** > `AGENTS.md` / 路B §14 / 本索引所列现行决策文 > `README.md` / `ARCHITECTURE.md`。冲突时对外文档向源码与决策文对齐，不得反向改代码迁就过时文案。

## Current（现行）

| 文档 | 用途 |
| --- | --- |
| [`README.md`](../README.md) | 对外入口：安装、命令、信任模型与使用方式 |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | 现行分层、数据流、生命周期与检索口径 |
| [`AGENTS.md`](../AGENTS.md) | Agent / 贡献者不变量与模块边界 |
| [`omem-v0.3-implementation-plan.md`](./omem-v0.3-implementation-plan.md) | **v0.3 工程决策与实施进度**（S0–S5 已完成；S6 推迟 v0.4） |
| [`omem-重构方案-路B.md`](./omem-重构方案-路B.md) | **v0.2 决策记录**（topic 即身份、去 SQLite、命令面收敛等）；§14 为 v0.2 实施进度，并指向 v0.3 计划 |
| [`releases.md`](./releases.md) | 版本发布记录 |
| [`手动测试指南.md`](./手动测试指南.md) | CLI 手工回归 |
| [`记忆可信度的人工核实与Agent协作手册.md`](./记忆可信度的人工核实与Agent协作手册.md) | 人工过目与 Agent 协作测可信度 |

产品边界（不变）：omem 管生命周期 / 安全写入 / 检索基础设施；语义归 Agent。非目标仍是：无向量库、无知识图谱、无 SQLite、无常驻 daemon、无自动遗忘、无文件锁、不扩默认 MCP 工具面。

## Archive（背景 only）

已迁入 [`archive/`](./archive/) 的规划、一次性格评审与过时实测。详见 [`archive/README.md`](./archive/README.md)。

本轮从 `docs/` 根目录迁入的主要包括：

- `omem-0.3.md` — 2026-11-05 架构评审（方向仍可参考，字段级 P0 已被否决或重设计）
- `omem-MCP改进建议核查与行动计划.md` — beta.7 时代 MCP 核查
- `2026-10-28-*` / `2026-10-29-*` — 三方协同与 beta.8/9 实测、规划、验收
