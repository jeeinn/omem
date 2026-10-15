# omem V0.1 改进计划 v1.1（按用户审查修订 · 待复审）

> 日期：2026-10-15 · v1.1 修订：响应用户审查（19:39）——主线不变，五处走偏点已改。
> 状态：**v1.1 已实施**（2026-10-15）。P0-1 只用合成 fixture 跑通度量，真实会话标注仍按 D3/D4 并行，未写入 baseline.json。

## v1.0 → v1.1 修订记录

| # | 审查意见 | 修订 |
|---|---|---|
| R1 | P0-1 不该挡住 P0-2 | §8 依赖图改为 P0-1 ∥ P0-2 独立并行；理由：recall 跑 extractFromDigest 不落盘，与 commitEntry 无关；收口的回归靠单测+冒烟，不靠 golden set；真实会话标注并行推进，无样本时先用合成 fixture 跑通度量 |
| R2 | 子串召回不是 Q1 | §2.2/2.3 重写：自动数字记基线，CI 只卡「低于已记录基线」；Q1 保持人工判断（新增 `omem eval sample` 导出供标注）；删除第一天就上 `--min-recall 0.8` 闸门的设计 |
| R3 | supersede-hint 不写 tags | §4.2 删除本轮 hint；只做三个显式入口。hint 的后移条件写入 §7（独立字段、同项目、高重叠、不取相似度第一名） |
| R4 | generateMemoryIndex 不进每次 commitEntry | §3.1 加 `refreshIndex` 开关（默认 true；pipeline 传 false，run 结束时刷一次——维持现状） |
| R5 | 文档只改正文不改文件名 | §6 改为内容内版本号 v0.3-draft + 文首变更记录；明确不动文件名（被实施计划等文档引用） |
| R6 | §3.3 冒烟编号错误 | S11 实为 work profile 拒 sync；写入回归改为 S2/S6/S7/S14（已核实：S2=add+search，S6=run，S7=review --confirm，S14 探针覆盖 save_memory 首存+幂等） |
| R7 | D1 加 --force | 人工 add 被禁区/代码密度拦截时打印原因 + 留 `--force` 绕过策略过滤（不绕脱敏与去重）；D1 转为已裁定 |

---

## 0. 评审核实结论：9 条论断全部属实（v1.0 已核实，未变）

证据表见 v1.0（git 5d0d076）。要点：评估层缺失 / 三写入路径分裂（add、save_memory 不过禁区与代码密度）/ supersede 无入口且检索不排除 / MCP 新鲜度只在连接时 / MEMORY-INDEX 未进客户端上下文 / 文档 5 处不一致（规格 §7 退 3 与 §5.5 退 0 自相矛盾等）。

---

## 1. 改进项总览

| 优先级 | 项 | 一句话 | 量级 |
|---|---|---|---|
| **P0-1** | 评估层 | `omem eval recall` 自动基线 + `omem eval sample` 人工标注通道；Q1 是人工判断，自动数字只作回归信号 | 1–2 天（人肉标注可并行） |
| **P0-2** | 写入路径收口 | 脱敏/禁区/代码密度/去重/落盘/索引收成 core 一次提交，三通道共用；热层刷新带开关 | 0.5–1 天 |
| **P0-3** | supersede 显式入口 | add --supersedes / save_memory.supersedes / review --confirm --supersedes；检索默认排除 superseded，--all 带回 | 1 天 |
| **P1-1** | MCP 新鲜度 | search/save 入口轻量 catch-up，不等重连 | 0.5 天 |
| **P1-2** | 文档对齐 | 规格 3 处 + README 2 处，只改正文 | 0.5 天 |
| P2 | MEMORY-INDEX 进客户端上下文 | 等 context 导出被真实使用验证后再补 | 后移 |

---

## 2. P0-1 评估层（与 P0-2 并行，不互相挡）

### 2.1 golden set

- 位置：`tests/eval/golden/`（会话脱敏副本）+ `tests/eval/annotations.json`。
- 规模：先 10 条，扩 20 条再谈 G2 结论。**真实会话标注是人工活，与 P0-2 的开发并行推进**；样本没就绪时，先用现有合成 fixture 把度量链路跑通（fixture 数字不进基线文件，仅验证管道）。
- 隐私纪律：入仓前过 `redactSecrets` + 人工复读；或按决策点 D4 放本地目录。

### 2.2 两条命令，两种语义（R2 核心修订）

```text
omem eval recall [--golden <dir>]        # 自动基线：子串包含匹配，输出 recall/precision/F1
omem eval sample [--golden <dir>] [--n 20] [--out <file>]   # 导出候选供人工标注（Q1 通道）
```

- **`recall` 的数字是弱代理**：normalizeForHash + 包含判定对短摘录容易算命中，也容易和规则抽出的跨度对不齐。因此它的产物是**基线**（写入 `tests/eval/baseline.json`：日期、样本数、各项指标），不是质量结论。
- **CI 语义 = 回归检测**：`--min-recall` 默认取 baseline.json 已记录值；低于记录值 → 退出码 1；没有 baseline 时只打印不判定。**不预设 0.8 绝对闸门**——自动数字从第一天起就不承担质量门槛。
- **Q1 = 人工判断**（评估报告原义：「这条记忆抽得对不对」）：`sample` 导出候选 → 人标注 对/错 → 通过率即 Q1 数字。20 条是烟雾级信号，通过只说明档 0 值得继续，不构成质量证明。
- 匹配方式在文档里注明局限（短摘录偏差、跨度错位），避免后人把数字当真相。

### 2.3 与 Q1/Q2 的关系

- Q1：人工标注通过率，由 `sample` 通道产出；≥80% 是评估报告设定的门槛，但样本量与判定一致性先于门槛数字。
- Q2 盲测 harness（问题集 + omem vs dumb baseline vs grep，人工评分）列为第二阶段，本计划仅占位。

---

## 3. P0-2 写入路径收口

### 3.1 新 core 函数

`src/core/commit.ts`：

```ts
commitEntry(home, config, index, input: {
  content, type, domain?, tags?, project?, session_id?, source,
  confidence, verified, supersedes?, profile?
}, opts?: { dryRun?: boolean; refreshIndex?: boolean; force?: boolean }) => {
  status: 'written' | 'deduped' | 'excluded' | 'redacted-empty',
  id?, path?, redacted?: number, reason?: string
}
```

固定顺序（与 pipeline 现顺序一致，成为唯一事实源）：
**脱敏（redactSecrets）→ 禁区关键词 → work profile 代码密度 → content-hash 去重（getByBodyHash）→ 原子写（writeEntry）→ upsert →（可选）generateMemoryIndex → appendLog**。

- `force`（来自 `omem add --force`）：只跳「禁区关键词」与「代码密度」两步；**脱敏与去重永不跳过**（安全与幂等不是策略）。
- `refreshIndex`（R4 修订）：默认 `true`（add/save 单写路径维持现状）；**pipeline 传 `false`**，由 run 结束时统一刷一次（现状：pipeline.ts:97/150）——否则几十条候选会把 ≤80 行热层重写几十次。

### 3.2 三个调用点改为薄封装

| 调用点 | 保留的特异性 | 行为变化 |
|---|---|---|
| `add.ts` | confidence 0.9 / verified / source manual / 参数解析 | 新增禁区与代码密度过滤；新增 `--force`（D1 已裁定：要过滤，但要给明确出路） |
| `tools.ts` toolSave | confidence 0.6 / verified false / source agent / max_chars 截断 | 新增禁区与代码密度过滤；schema 不变 |
| `pipeline.ts` commitCandidate | confidence 来自规则 / verified false / session_id/project | 逻辑原样搬入，删本地副本；`refreshIndex: false` |

### 3.3 验收

- 新增 `tests/unit/commit.test.ts`：脱敏命中/整条是密钥/禁区命中/代码密度/重复内容/正常写入/supersedes 声明/work profile/home profile/dry-run/**force 绕过策略但仍脱敏去重**/refreshIndex=false 不刷热层。
- 三条路径各留 1 个集成测试：同一内容经 add 与 save 二次写入均 deduped（证明同通道）。
- 冒烟回归看 **S2（add+search）、S6（run/pipeline）、S7（review --confirm）、S14（MCP 探针，覆盖 save_memory 首存+幂等）**——S11 是 work profile 拒 sync，与写入无关（R6）。
- `npm test` + `npm run smoke` 全绿。

---

## 4. P0-3 supersede 显式入口（只做显式，不做提示）

### 4.1 三个入口（R3 修订后全部）

| 通道 | 入口 |
|---|---|
| CLI | `omem add <内容> --supersedes <id1,id2>` |
| MCP | `save_memory` inputSchema 增 `supersedes: string[]`（description 注明"仅在明确取代某条旧记忆时传"） |
| review | `omem review --confirm <id> --supersedes <old-id>` |

声明后走现有 `applySupersedes`：旧条目置 `superseded` + 回填 `superseded_by`（逻辑已单测，本次只补入口）。

### 4.2 本轮不做 correction 自动提示（R3 核心修订）

- 取消 v1.0 的 `supersede-hint` tag 方案。理由：**tags 进 FTS5**；中文短句的 trigram「最相似」经常指错旧条目；人在 review 里一点确认就会取代错记忆——错误不可逆（虽可再声明，但噪音真实）。
- correction 候选维持现状（普通 decision 候选），由 review 队列的人工/Agent 判断是否声明取代。
-  hint 的后移条件（写入 §7）：独立 frontmatter 字段（**不进 tags/不进 FTS5**）+ 同项目 + 内容重叠足够高 + 不取相似度第一名；三者缺一不做。

### 4.3 检索侧

- `search.ts` buildFilters 默认过滤 `status != 'archived' AND status != 'superseded'`（主路与 LIKE 兜底路同步改）；`--all` 带回（语义与 archived 一致）。
- 时效标注已支持（`formatStaleness`：「——已被 X 取代」）；MEMORY-INDEX 已统计 superseded 计数。

### 4.4 验收

- 单测：add --supersedes / save_memory.supersedes / review --confirm --supersedes 三条入口各自生效（旧条目 superseded + superseded_by 回填）。
- 单测：superseded 条目默认检索不返回、`--all` 返回；主路与 LIKE 兜底路各一例。
- 冒烟新增 S15：制造新旧一对 → 声明取代 → 验证检索与 review 表现。

---

## 5. P1-1 MCP 新鲜度（工具入口 catch-up）

- `server.ts` 的 CallToolRequestSchema handler 入口：`index.catchUp()`（与 CLI openCtx 同一通道），有重索引时才顺带 generateMemoryIndex 并写 stderr 日志。
- 不做节流：V0.1 规模（<1 万条）stat 全库成本可忽略（ctx.ts 注释已论证）；真成瓶颈后续加最小间隔而非去掉。
- 验收：起 server → 外部改一条 md → 不重连直接 search_memory → 命中新内容（探针扩一例）。

---

## 6. P1-2 文档对齐（只改正文，不动文件名——R5）

规格文件名被实施计划等文档引用，**不改名**；在文首把版本号升为 **v0.3-draft** 并加变更记录。

| 位置 | 现状 | 改为 |
|---|---|---|
| 规格:3 状态行 | 待评审，未开工 | 已批准实施，V0.1 代码已落地 |
| 规格:197 §5.3 | pull 前自动 stash 之后 pop | 拉取前将未提交改动**固化为自动提交**；说明为何不用 stash（stash 使 ours 等于 base，冲突被推迟到 pop 才爆） |
| 规格:320 §7 | 退出码 3 冲突待人工处理 | 删除该行；冲突按 §5.5 退 0（消除文档自相矛盾） |
| README:35,61 | `install --client <name>` | `install --target <name>` |
| README:66 | `gc [--apply]` | `gc [--days N]`（直接标记，无 --apply） |

---

## 7. 明确不做（及触发条件）

| 项 | 后移原因 | 重新评估的触发条件 |
|---|---|---|
| supersede 自动提示（hint） | tags 进 FTS5 + trigram 最相似常指错 + 确认即错取代（R3） | 独立 frontmatter 字段 + 同项目 + 高重叠 + 不取相似度第一名，四条件齐备 |
| WebDAV / 本地目录后端 | 接口已留（正确拒绝），V0.1 用户群不含非开发者 | V0.3 立项条件（beta 非开发者占比 ≥30%） |
| 向量检索 / jieba / 文件监听 | trigram+LIKE 已过 spike；监听是规模优化 | 单库 >1 万条且检索延迟进抱怨前三 |
| rebuild 期间降级 grep | 规格决策 4；单进程 CLI 碰不到并发读 | 出现真实并发读场景 |
| 负反馈降权（helpful=false） | 只写日志；排在召回率与取代语义后 | G2 通过后随 review 队列一起做 |
| MEMORY-INDEX 进客户端上下文 | context 导出尚未被真实使用验证 | context 导出跑通一周且确有被动注入需求 |
| SyncBackend 异步化 / Rust 重写 / 打包运行时 | 接口税已付，无收益 | 规格 §10 既定触发条件 |

---

## 8. 顺序、依赖与总体验收（R1 修订）

```text
P0-1 评估层 ──────────────∥── P0-2 写入收口 ──→ P0-3 supersede 显式入口
（独立：recall 跑 extractFromDigest 不落盘；    （依赖：supersede 参数走统一写入通道）
 收口的回归靠单测+冒烟，不靠 golden set；
 真实会话标注并行，无样本先用合成 fixture 跑通度量）
P1-1 MCP catch-up ──┐（独立，可随时插）
P1-2 文档对齐 ──────┘（独立，可随时插）
```

总体验收（全部满足才视为本轮完成）：
1. `omem eval recall` 对合成 fixture 产出数字并写入 baseline.json；真实 golden 就绪后更新基线——**自动数字只作回归信号，不承担质量门槛**；
2. Q1 人工通道可用（`omem eval sample` 导出 + 标注 + 通过率），样本量与判定一致性先于门槛数字；
3. `npm test` 与 `npm run smoke` 全绿（冒烟新增 S15 supersede 场景）；
4. 三条写入路径行为差异归零（同一输入三通道结果一致，除 confidence/verified/source 特异性字段）；`--force` 有单测；
5. MCP 会话中途外部编辑可被不重连检索到；
6. 文档五处不一致清零，规格无自相矛盾退出码，文件名未动。

---

## 9. 决策点状态

**本轮已裁定**：
- D1 人工 add 也过禁区+代码密度过滤，但提供 `--force` 绕过策略（不绕脱敏/去重），拦截时打印原因。
- D2 supersede 自动提示本轮不做；后移条件见 §7。

**仍开放**：
- D3 golden 集样本量与标注一致性：先 10 条出基线、扩 20 条再谈 G2；人工标注需一份判定口径（什么算"抽得对"：跨度？语义？可用性？）——建议 P0-1 动工前先用 5 条试标定口径。
- D4 真实会话入仓的隐私边界：脱敏+人工复读后入 `tests/eval/golden/`，或不入仓、放 `~/.omem-eval/` 由 `--golden` 指向（命令设计已支持）。
