# omem V0.2 技术规格（草案）

> 版本：v0.1-draft · 日期：2026-10-19 · 状态：**草案，未开工，不改变 V0.1 已交付的任何行为**
> 上位文档：`omem-V0.1技术规格草案.md`（已批准实施，V0.1 代码已落地）；迁出来源：`omem-V0.1-改进计划.md` §7「明确不做」表
> 本版范围：**只展开 `omem watch` 一条**（补的是"采集新鲜度"）。其余 V0.2 条目（WebDAV / 本地目录后端、其他 Agent 采集器、向量检索可选开关）在本文只登记、不写契约。
> 触发本文的原因：2026-10-19 只读核查发现新鲜度保证只做了一半，且这一半的缺口被误认为是"规模优化"。

---

## 0. 结论先行

- **新鲜度要分两层看。** 索引新鲜度（已有文件被改）在 V0.1 已经解决：启动时 catch-up + **每次 MCP 工具调用前** catch-up（`src/mcp/server.ts:15-31`）。没解决的是采集新鲜度——catch-up 只对账已入库的路径，从不扫 `~/.claude/projects` 等源根，所以**新会话只有 `omem run` 能看见**。
- **先验证收益，再谈实现。** 真实仓（约 950 个会话）`omem run --dry-run` 全量约 7.7 秒，用系统定时任务 15–30 分钟跑一次就能拿到八成收益、零新代码（README「定时采集（可选）」已给出落地方式）。建议先跑一周，用待加工队列的消化速度判断值不值，再决定是否动工。
- **本文档是"决定要写"时的施工依据**，不是开工令。

### 0.1 实测基线（2026-10-19，真实仓 `~/.omem`）

| 项 | 值 |
| --- | --- |
| 会话 / 活文档 | 952 / 26（另 212 条无项目指纹的 unassigned） |
| `omem run --dry-run` 全量耗时 | ≈ 7.7s（957 个候选，940 未变） |
| 待加工队列 | 44 个主题 / 931 条未吸收会话 |
| 索引体积 | 57MB，其中 53MB 是 `sessions` 的 FTS5 trigram（源文 16MB，约 3.4x） |
| 源侧文件 | 1144 个 `.jsonl`，其中约 187 个解析不出 digest 被静默丢弃 |

---

## 1. `omem watch`

### 1.1 定位与非目标

**目标**：把源根里新增或更新的会话自动捞进 `sessions/` 并增量入索引，让"新会话多久能被检索到"不再依赖用户记性。

**非目标（写死以免漂移）**：

| 不做 | 原因 |
| --- | --- |
| 加工 / 蒸馏 | 档 2 仍由 Agent 主导，omem 不调用模型 |
| 写 `knowledge/`、自动 `supersede` | 活文档的取舍要人确认，见 §1.3 副作用一 |
| 自动 git 提交 | 提交归 `omem sync`，避免把"写入历史"变成隐式行为 |
| 递归 `fs.watch` | 三个采集根都在 AppData 目录树里，监听句柄开销与事件风暴不划算；改用**轮询 + 去抖**（去抖窗口参考 codegraph 的 2000ms） |

**与 `omem serve` 的关系**：serve 是 stdio MCP server，生命周期跟着客户端进程；watch 是本机后台进程。两者可并存，单写者由 SQLite WAL + 进程锁保证。

### 1.2 行为契约

1. 启动时读 config，全量扫一次三个采集根建立基线（沿用 `scanSessions`：content-hash 未变即跳过，不重复落盘）。
2. 之后每 `interval_sec` 扫一次；同一文件的连续变更在 `debounce_ms` 窗口内合并成一轮。
3. 只处理 content-hash 变化的会话：写 `sessions/<agent>/<session_id>.md` → upsert 会话索引 → **不触发全量 catch-up、不重写 `MEMORY-INDEX.md`**。
4. 每轮写一条 `event: watch` 日志（scanned / written / skipped / unparsed / elapsed_ms），`omem audit` 可见。
5. 单实例：`locks/watch.lock` + PID；第二个实例打印"已在运行（pid N）"并以退出码 **1** 结束。
6. 停止：SIGINT / SIGTERM 优雅退出，释放锁与 SQLite 句柄（Windows 上不释放会导致临时数据仓删不掉，已在 V0.1 的 `cmdSync` / `cmdSearch` 上踩过 EBUSY）。

### 1.3 三个已知副作用的处置

**副作用一：`PROCESS.md` 竞态**
现象：watch 若顺带刷新队列，会重写 `PROCESS.md`；Agent 正在读它准备 `save_memory` 时，手里的列表可能已经过期（写入本身是原子 rename，不会读到半截内容，但语义会漂移）。
处置：**默认不动 `PROCESS.md`**，队列刷新仍归 `omem run`。若用户显式开 `--process`，则文件头写 `Batch-Revision: <n>`，Agent 提交 `save_memory` 时由 omem 校验 revision 未变；变了就返回带新 revision 的拒绝，要求重读后再写。
待定：revision 是否要进 MCP 工具参数（倾向：不进，靠拒绝信息里的 id 重读）。

**副作用二：sessions trigram 写放大**
现象：索引 57MB 里 53MB 是会话的 trigram FTS，反复重写会放大写入量。
处置：① 只 upsert 变动的会话，禁止任何形式的表重建；② 每轮结束用 `PRAGMA wal_checkpoint(PASSIVE)`，不做每次 truncate；③ 提供背压：`max_write_bytes_per_hour > 0` 时，超阈值就跳过本轮并记 `watch.throttled`（下一轮再试），保证后台进程不会把磁盘写满；④ 体积兜底仍是 `omem rebuild`（`index/omem.db` 删了就能重建）。

**副作用三：静默丢弃的源文件**
现象：`collector.ts:74` 的 `if (!digest) continue` 会跳过解析不出 digest 的源文件，实测约 187 个（16%），用户完全看不见——进了后台就会变成持续噪音。
处置：**先让它可见，再决定要不要修。** `scanSessions` 增加 `unparsed: number`（并在 stderr / 日志里带前几个样本路径），`omem run` 的报告行补 `unparsed N`；watch 侧按「单轮 unparsed 占比 >20% 且连续 3 轮」记一条 `watch.warn`，提示可能是上游格式漂移。

### 1.4 命令面与配置

```
omem watch [--interval 60] [--debounce 2] [--once] [--process]
```

`config.toml` 新增一段（不写不算错，全部有默认值）：

```toml
[watch]
interval_sec = 60          # 轮询间隔
debounce_ms = 2000         # 同一文件的变更合并窗口
update_process = false     # 是否顺带刷新 PROCESS.md（见副作用一）
max_write_bytes_per_hour = 0  # 0 = 不限；>0 触发背压（见副作用二）
```

退出码沿用规格 §7 语义：`0` 正常退出，`1` 用法错误或已有实例在跑，`2` 后端/策略不可用。

### 1.5 验收（挂在 G2 之后，不进 G1）

| # | 用例 | 通过标准 |
| --- | --- | --- |
| W1 | 幂等 | 连跑 3 轮，`sessions/` 文件数、会话索引行数、条目数均不变，无重复行 |
| W2 | 新鲜度 | 新写一个源会话，60s 内 `omem search --sessions` 能查到；`knowledge/` 与 `PROCESS.md` 未被改动 |
| W3 | 背压 | 人为把阈值调小后，日志出现 `watch.throttled`，且索引没有半途写入 |
| W4 | 单实例 | 第二个进程退出码 1，不抢锁、不写索引 |
| W5 | 停服 | SIGTERM 后锁释放；Windows 上临时数据仓可删（EBUSY 回归） |

### 1.6 开放问题（动工前必须回答）

1. **谁负责装这个后台进程？** V0.1 的 `omem install` 只写 MCP 配置；Windows 没有标准的用户级 daemon（launchd / systemd 各一套）。接受「watch 不自动装、用户自己挂」，还是等 V0.2 的 bundled runtime 一起给？我的意见是前者，且必须在帮助文本里写清楚。
2. **与 V0.2 其他后端的关系**：watch 触发的写入是否要在 WebDAV / 本地目录后端上同步落盘，还是只在本地（倾向：只在本地，同步仍归 `omem sync`）。
3. **默认间隔取多少**：60s 是拍的，需要用一周的定时任务数据反推（新会话出现的分布 + 用户对"多久可见"的容忍度）。
4. **`--process` 的 revision 校验要不要落进 MCP 工具契约**：见 §1.3 待定项。

---

## 2. 从 V0.1 改进计划 §7 迁出的条目

| 项 | 原「明确不做」的理由 | 迁出日期 | 现在的状态 |
| --- | --- | --- | --- |
| 文件监听（`omem watch`） | trigram+LIKE 已过 spike；监听是规模优化 | 2026-10-19 | 移入本文档 §1。原触发条件（单库 >1 万条且检索延迟进抱怨前三）保留为**实施**闸门，但不再作为"不做"的理由——缺的是采集新鲜度，不是检索性能 |

其余仍在 §7 的条目（supersede 自动提示、WebDAV / 本地目录后端、向量检索、rebuild 期间降级 grep、负反馈降权、MEMORY-INDEX 进上下文、Rust 重写 / 打包运行时）**维持原判，不在本次迁移范围内**。
