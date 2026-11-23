# docs 索引

先读 **Current**，再按需翻 **Archive**。Archive 只作背景，**不是开工依据**。

事实优先级：**源码** > `AGENTS.md` > `README.md` / `ARCHITECTURE.md`。冲突时对外文档向源码与 `AGENTS.md` 对齐，不得反向改代码迁就过时文案。

## Current（现行）

| 文档 | 用途 |
| --- | --- |
| [`README.md`](../README.md) | 对外入口：安装、命令、信任模型与使用方式 |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | 现行分层、数据流、生命周期与检索口径 |
| [`AGENTS.md`](../AGENTS.md) | Agent / 贡献者不变量与模块边界 |
| [`CHANGELOG.md`](../CHANGELOG.md) | 版本变更记录（Keep a Changelog 格式） |
| [`omem-v0.5-Roadmap.md`](./omem-v0.5-Roadmap.md) | v0.5.0 期开工依据（已交付，留作回溯）：五痛点议题、依赖顺序、验收与 go/no-go 门槛 |
| [`omem-v0.5-测试保障方案.md`](./omem-v0.5-测试保障方案.md) | v0.5.0 期质量保障（已交付）：量化门禁、用例矩阵、A 案断言补齐与复核（**GO**） |
| [`omem-v0.5-上线发布方案.md`](./omem-v0.5-上线发布方案.md) | v0.5.0 期上线发布（已交付）：前置清单、三阶段流程、四种回滚、合规与灰度；v0.6.0 沿用同一套流程 |
| [`手动测试指南.md`](./手动测试指南.md) | CLI 手工回归 |
| [`记忆可信度的人工核实与Agent协作手册.md`](./记忆可信度的人工核实与Agent协作手册.md) | 人工过目与 Agent 协作测可信度 |

产品边界（不变）：omem 管生命周期 / 安全写入 / 检索基础设施；语义归 Agent。非目标仍是：无向量库、无知识图谱、无 SQLite、无常驻 daemon、无自动遗忘、无文件锁。MCP 工具面按「最小必要集」维护：只读诊断类可以进（`omem_status`），写入类或重复 CLI 命令的不进，每次新增都要记录体积代价（`tests/unit/tool-budget.test.ts`）。

## Archive（背景 only）

已迁入 [`archive/`](./archive/) 的规划、一次性格评审与过时实测。详见 [`archive/README.md`](./archive/README.md)。

本轮从 `docs/` 根目录迁入的主要包括：

- `omem-v0.3-implementation-plan.md` — v0.3 工程决策与 S0–S6 进度；证据分层已在源码和 `AGENTS.md`
- `omem-重构方案-路B.md` — v0.2 决策与进度；不变量已在 `AGENTS.md`
- `omem-process-command-plan.md` — `omem process` 与 sync 拆分；命令已在源码和 README
- `omem-0.3.md` — 2026-11-05 架构评审（方向仍可参考，字段级 P0 已被否决或重设计）
- `omem-MCP改进建议核查与行动计划.md` — beta.7 时代 MCP 核查
- `2026-10-28-*` / `2026-10-29-*` — 三方协同与 beta.8/9 实测、规划、验收
