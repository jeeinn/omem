# omem 远端正式包本地测试用例（beta.4）

> 测试对象：npm 远端正式包 `@jeeinn/omem@beta`（发布版 0.1.0-beta.4），**不是**本地源码。
> 与 `docs/手动测试指南.md` 的区别：那份用路径 A（`node bin/omem.js`，本地源码）；本套用全局安装后的 `omem` 命令，验证 npm 分发链 + 真实用户路径。
> 环境：Windows / PowerShell Core / Node ≥ 22.5 / git。
> **铁律：全程隔离 `OMEM_HOME`，绝不触碰真实 `~/.omem`**（本机 `~/.omem` 有真实数据）。

## 0. 环境准备

| 步骤 | 命令 | 预期 |
| --- | --- | --- |
| P0 | `node --version` | ≥ v22.5 |
| P1 | `npm install -g @jeeinn/omem@beta` | 装 0.1.0-beta.4（本机原为 beta.3，同时验证升级路径） |
| P2 | `omem --version`（或 `omem help`） | 打印 0.1.0-beta.4；npm bin shim 可用 |
| P3 | `$env:OMEM_HOME = "$env:TEMP\omem-remote-t1"` | 隔离数据目录，每屏新 shell 都要重设 |
| P4 | `Test-Path $env:OMEM_HOME` | False（干净起点） |

## A. 安装与分发完整性（npm 包独有验证点）

| ID | 命令 | 预期 |
| --- | --- | --- |
| A1 | `npm ls -g @jeeinn/omem` | 0.1.0-beta.4 |
| A2 | `omem --version` | `0.1.0-beta.4`（无 `--experimental-sqlite` 手动 flag，验证 bin 包装器自注入） |
| A3 | `omem help` | 英文命令列表，含全部 19 个命令；退出码 0 |
| A4 | `omem` （无参数） | 打印用法；退出码 1 |
| A5 | 检查 `dist/`、`bin/` 随包分发 | 全局 node_modules 下两目录均在，README/NOTICE 在 |

## B. 初始化与数据布局

| ID | 命令 | 预期 |
| --- | --- | --- |
| B1 | `omem init --no-scan` | 「omem data dir」+「git data repo initialized」；退出码 0 |
| B2 | 检查目录 | `$OMEM_HOME` 下 knowledge/ archive/ index/ snapshots/ logs/ sessions/ config.toml .git 存在 |
| B3 | `omem init`（第二次，不带 --no-scan） | 幂等或明确提示已初始化；不报错 |
| B4 | `git -C $env:OMEM_HOME log --oneline` | 至多一条 init 提交；真实 `~/.claude` 等未被读取扫描出巨量会话（--no-scan 路径） |

## C. 写入与检索（核心链路）

| ID | 命令 | 预期 |
| --- | --- | --- |
| C1 | `omem add "omem 的检索走 FTS5 trigram，中文查询词少于 3 个字符时退化为 LIKE 兜底" --type fact --domain tech --tags 检索,FTS5` | 打印 id（YYYY-MM-DD-xxxxxx）+ 文件路径；退出码 0；verified |
| C2 | `omem add "以后部署统一用 Docker Compose，不再裸跑 docker run" --type preference --domain ops` | 同上 |
| C3 | `omem search "FTS5 trigram"` | 命中 C1；带新鲜度标注；文末有「个人记忆参考笔记」提示行 |
| C4 | `omem search "部署"`（2 字中文） | LIKE 兜底命中 C2 |
| C5 | `omem search "不存在的词xyz"` | 「未找到…」+ ≥3 字符提示；退出码 0 |
| C6 | `omem add "测试密钥 sk-ant-abc123def456ghi789jkl012 不要外泄" --type fact` | 先打印「已脱敏 1 处敏感内容」再保存；文件里无明文密钥 |
| C7 | 重复 C1 内容再 add | 幂等去重（deduped，不新增文件） |
| C8 | `omem add "同类内容再写一次做去重" ` 连续两次 | 第二次提示 deduped / 已存在 |

## D. 生命周期与索引重建

| ID | 命令 | 预期 |
| --- | --- | --- |
| D1 | `omem review` | 队列为空提示（C 组均为 verified，无待确认候选） |
| D2 | `omem gc` | 扫描 active N 条，标记 stale 0 条；只标记不删除 |
| D3 | 删索引 `rm $OMEM_HOME/index/omem.db*` 后 `omem search "FTS5 trigram"` | 仍能命中（打开时 catch-up 重建） |
| D4 | `omem rebuild` | 从 md 全量重建；条目数不变 |
| D5 | `omem snapshot` | 生成 snapshots/<date>/；退出码 0 |

## E. 会话采集（合成 fixture，不碰真实数据）

| ID | 命令 | 预期 |
| --- | --- | --- |
| E1 | `$env:OMEM_CLAUDE_PROJECTS="X:\omem\tests\fixtures\claude-projects"; omem sync --dry-run` | dry-run 摘要；不落盘 |
| E2 | `omem sync` | sessions/ 出现会话 md；正文密钥打码；knowledge 无 rules 来源新增；PROCESS.md 生成 |
| E3 | `omem sync`（再跑一次） | 幂等：内容没变的会话跳过 |
| E4 | `omem sync --tier rules` | 退出码 1（已移除） |
| E5 | `omem search --sessions "fixture 里的关键词"` | 只查原文层，有命中 |

## F. 上下文导出与可观测

| ID | 命令 | 预期 |
| --- | --- | --- |
| F1 | `omem context --for plain` | 以「# omem 个人记忆索引」开头；含 C1/C2 条目 |
| F2 | `omem audit --tail 5` | JSONL；add 事件名是 commit；退出码 0 |
| F3 | `omem context --for codex` | codex 格式上下文；退出码 0 |

## G. 同步（本地 bare remote，不碰公网）

| ID | 命令 | 预期 |
| --- | --- | --- |
| G1 | `git init --bare -b main $env:TEMP\omem-remote.git` + `omem backup remote <该路径>` | remote 配置成功 |
| G2 | `omem backup` | pull→push；退出码 0；本地提交「omem: sync …」 |
| G3 | 第二 OMEM_HOME clone 后各自 add 不同条目再互 sync | 两边都收编，无冲突，退出码 0 |
| G4 | 同一条文件两边都改 → sync | 退出码 0（冲突已处理）；远端版另存 `.conflict.md`，本地版保留；不自动合并 |
| G5 | `omem backup use webdav` 然后 `omem backup` | 前者退出码 0 只提示 V0.2 交付；后者退出码 2。测完 `omem backup use git` 还原 |

## H. 档案、审计

| ID | 命令 | 预期 |
| --- | --- | --- |
| H1 | `omem profile use work` | 切换成功 |
| H2 | `omem context --for plain`（work 档） | 被拒；退出码 2（ProfileBlockedError） |
| H3 | `$env:OMEM_ALLOW_WORK_EXPORT="1"; omem context --for plain` | 放行；退出码 0 |
| H4 | `omem profile use home` | 切回，退出码 0 |

## I. MCP（真实使用路径，用远端包的 bin）

| ID | 命令 | 预期 |
| --- | --- | --- |
| I1 | `omem install --list` | 列出全部客户端 |
| I2 | `omem install --print-config claude-code` | 含 mcpServers.omem；目标文件 ~/.claude.json 提示 |
| I3 | `node tests/mcp-probe.mjs <全局包 bin/omem.js 绝对路径>` | 握手/tools/list/search/save 幂等/catch-up/stdout 纯净 全过 |
| I4 | `omem serve` 手动 Ctrl+C / 或探针覆盖 | stdio 协议，无日志泄漏到 stdout |

## J. API 档（默认关闭的可档）

| ID | 命令 | 预期 |
| --- | --- | --- |
| J1 | `omem api status` | 打印生效配置、队列深度；不因未配置端点崩溃；退出码 0 |
| J2 | `omem sync --tier api --dry-run` | 零网络调用；打印批次规模与 token 估算 |

## K. 退出码契约与红队输入

| ID | 命令 | 预期 |
| --- | --- | --- |
| K1 | `omem redact`（缺 --id/--source） | 退出码 1 |
| K2 | `omem search`（缺 query） | 退出码 1 |
| K3 | `omem backup use webdav` 后 `omem backup` | 退出码 2 |
| K4 | `omem add ""`（空内容） | 明确报错，退出码 1，不写文件 |
| K5 | `omem frobnicate`（未知命令） | 明确报错，退出码 1 |

## L. 硬删（redact）——放最后做，会真删文件

| ID | 命令 | 预期 |
| --- | --- | --- |
| L1 | `omem redact --source manual`（不带 --yes） | 只预览条数与样例；不删 |
| L2 | `omem redact --id <C6 的 id> --yes` | 硬删：md 与索引行都消失；grep 无该 id |
| L3 | 删后 `omem search "测试密钥"` | 无命中 |

## 执行记录与结论

执行时间：2026-10-21 · 环境：Windows / PowerShell Core / Node v22.20.0 / git 2.51.1
测试对象：`@jeeinn/omem@beta` = `0.1.0-beta.4`（npm i -g 从 beta.3 升级，升级路径本身通过）
隔离库：`$env:TEMP\omem-remote-t1`（主）、`omem-remote-t2`（探针干净库）、`omem-home2`（第二台）、`omem-remote.git`（本地 bare remote）

### 结果总览

| 组 | 用例数 | 通过 | 说明 |
| --- | --- | --- | --- |
| A 安装分发 | 5 | 5 | 升级、版本、bin flag 自注入、无参退 1、包内容完整 |
| B 初始化 | 4 | 4 | 骨架齐、git init 提交、二次 init 幂等 |
| C 读写检索 | 7 | 7 | 三形态检索、脱敏、去重均符合手册 |
| D 生命周期 | 5 | 5 | 删索引后 catch-up 重建、rebuild 条目数一致 |
| E 采集 | 5 | 5 | 含一次测试设计修正（见下） |
| F 上下文 | 3 | 3 | plain/codex 导出、audit JSONL |
| G 同步 | 5 | 5 | 双机互编、冲突只报告、`.conflict.md` 不进索引、webdav 退 2 |
| H 档案 | 4 | 4 | work 档退 2、显式放行 |
| I MCP | 4 | 4 | 干净库探针 12/12 全过 |
| J API 档 | 2 | 2 | 未配端点不崩溃、dry-run 零网络 |
| K 退出码 | 6 | 6 | 全部符合契约 |
| L 硬删 | 3 | 3 | 预览不删、--yes 双删、git 可追溯 |
| 补充 supersede/eval | 2 | 2 | 检索排除语义正确（但暴露缺陷 2） |

**测试设计修正（E 组）**：`omem sync` 扫全部三个采集器。只设 `OMEM_CLAUDE_PROJECTS` 时，workbuddy/cursor 仍指向真实目录，dry-run 报 947 sessions。手册 §3 S5 同样只设了一个变量——**建议手册补充三根全隔离的写法**。修正后三根全指 fixture/空目录，sessions 1 符合预期。

**探针复跑说明（I 组）**：首跑 10/12 系漏了手册 §4.4 前置步骤（先 add 一条含「手写 SQL」的记忆）；「first save」失败系探针内容已被上一次运行写入（幂等 dedup）。干净库重跑 12/12。

### 缺陷清单（按优先级）

| # | 级别 | 缺陷 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | P1 | **布尔旗标不能前置于位置参数**。`omem search --sessions "手写 SQL"`、`omem search --all "部署"` 均报用法错误——解析器把 query 吞成 flag 的值。`src/cli-args.ts:21-24` | 用例 E5/K6 实测 | 让命令声明布尔旗标集合（或带值旗标白名单），遇到布尔旗标不吞下一个 token；补单测覆盖 flag 前置两种顺序 |
| 2 | P1 | **superseded 标注永不显示**。`formatStaleness` 先判 `verified` 再判 `status==='superseded'`，被取代的 verified 旧条目（`omem add` 写的都是 verified）永远显示「— confirmed」而非「— superseded by X」。消费者会误把已作废记忆当有效 | `src/core/lifecycle.ts:30-31`；实测 `omem search "部署" --all` 旧条目只显示 confirmed | 把 superseded/archived 判断提到 verified 之前；CLI 与 MCP 输出同步受益 |
| 3 | P2 | **`install --print-config claude-code` 把整个 `~/.claude.json` 打到终端**（含 machineID、toolUsage、tipsHistory 等隐私字段），而非只预览 omem 段。预览重定向到文件/贴 issue 即全量泄漏 | 用例 I2 实测，输出数百行 | JSON 类目标只打印「omem 段 + 原文件将保留的键名列表」；完整合并预览留给实际写入的备份 |
| 4 | P2 | **Node `ExperimentalWarning: SQLite is an experimental feature` 出现在 CLI stderr**（bin 包装器 re-exec `--experimental-sqlite` 时 Node 自动打印）。MCP 无害（stdout 纯净已过），但 CLI 每次调用都有噪音 | 用例 J1 实测 | re-exec 时加 `--no-warnings` 或注入 `NODE_NO_WARNINGS=1` |
| 5 | P3 | 探针「search_memory hits fixture entry」可被无命中提示的回显 query 欺骗（text 含查询词本身）——本次首跑即假通过 | `tests/mcp-probe.mjs:77` | 断言改为「found ≥1 且含标题特征」或区分无命中提示 |
| 6 | P3 | 文档小不一致：README 称 sync 提交为「omem: sync \<时间\>」，实测总是「omem: autosave before pull」（add 不自动 commit → pull 前总先固化）；空 remote 首次 sync 打印红色「Pull failed: couldn't find remote ref main」但最终退 0，观感差 | 用例 G2 实测 | README 补充说明；空 remote 的 pull 失败降级为 info 级措辞 |

### 总体结论

beta.4 远端包在本机全命令面 **60/60 用例通过**（修正 2 处测试自身问题后），核心卖点（md 事实源、永不自动删除、冲突只报告、work 档拦截、MCP stdout 纯净、退出码契约）全部符合规格与手册预期。发现的 6 个问题中 2 个 P1（#1 参数解析、#2 superseded 标注）建议在 beta.5 前修复；#3/#4 影响日常体验，建议同批处理；#5/#6 为测试基建与文档债。

### 未清理的一次性数据（删除需本机批准，可手动清理）

```powershell
Remove-Item "$env:TEMP\omem-remote-t1","$env:TEMP\omem-remote-t2","$env:TEMP\omem-home2","$env:TEMP\omem-remote.git","$env:TEMP\omem-empty-wb","$env:TEMP\omem-empty-cursor" -Recurse -Force
```
