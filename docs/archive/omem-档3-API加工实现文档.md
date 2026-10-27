# omem 档 3（API 加工）实现文档（草案）

> **归档**（2026-10-26）：已随 0.1.0-beta.4 实现。本文只留作记录，不再作为开工依据。现行行为以 [`docs/archive/omem-V0.1技术规格草案.md`](omem-V0.1技术规格草案.md)、README 和源码为准。
>
> 版本：v0.6-draft · 日期：2026-10-21 · 状态：**已实现，随 0.1.0-beta.4 发布**
> 修订：v0.6 补三处收尾（跑完后重算 pending、parse_failed 打断连续传输失败、中止前刷新 PROCESS.md 与 MEMORY-INDEX）。v0.5 的评审裁决仍有效，见文末修订记录。
> 目标：让 `omem run --tier api` 既能接**本机本地模型（免 key，如 ollama / llama-server）**，也能接**云端 OpenAI 兼容端点（带 key，如 DeepSeek / 通义 / OpenAI）**。
> 默认路径不变：**零模型采集 + 宿主模型加工**。档 3 始终是可选开关。
> 术语：**本地模型** = 跑在用户自己机器上、omem 不内嵌 runtime 也不分发权重（由 ollama / llama-server 之类的服务提供）；与"云端端点"相对。**档 3** 是四档制时代的历史称呼，现状即 `--tier api`，下文混用。
> 定位：本文档是 beta.4 的施工依据，工作已完成。

### 已确认条款（D1–D10，开工依据）

| # | 议题 | 结论 |
|---|---|---|
| D1 | 语义对齐 | **做**：多条原始 session → 一份 topic 活文档，遵循"一主题一份活文档"（§7） |
| D2 | 置信度 | 不采信模型自评；由**证据锚定**决定初始值，用户确认走已有的 `omem review --confirm`（§7.1） |
| D3 | 云端硬性上限 | 保留，且**只对非回环端点生效**，性质是"数据外泄与账单的爆炸半径控制"（§3.6） |
| D4 | 进度输出 | 逐条打印（§3.9） |
| D5 | `[api].key` | 允许写进 `config.toml`，文档明确警告"会被 `omem sync` 同步到 git 仓库"（§4） |
| D6 | 实施顺序 | 分两步：第一步端点与护栏（§1–§6），第二步活文档对齐（§7） |
| D7 | 输出解析 | **宽松解析**（逐级尝试 + 兜底）+ 解析失败把 raw 写日志；明确不做"语义修复"（§3.10） |
| D8 | evidence 匹配 | 比对前**先归一化**（复用 `normalizeForHash`：去空白/标点/符号 + 大小写折叠），≥12 字符子串命中（§7.2） |
| D9 | key 泄漏护栏 | `omem sync` 提交前扫 `config.toml` 的非空 `[api].key` 并警告（不阻塞、不改文件）（§6.3） |
| D10 | 成本可感 | 默认路径打印**本批预估 token 量级**（粗估，不接价格表、不发网络请求）（§3.11） |

> **D8 修订（v0.4）**：原文"沿用 save_memory 既有口径"与代码不符——`scoreEvidence` 现行是**原文** `includes` 匹配（`src/process/score.ts:44,55`），并无归一化。处置：本档落地时**同步把 `score.ts` 对齐为归一化子串匹配**（门槛仍按原文长度 ≥12 字符），两条写入路径共用一把尺子；详见 §7.1。

---

## 0. 结论与范围

**第一步约 500 行源码 + 240 行测试，两到三天，不引入任何新依赖（`fetch` / `AbortSignal` 均为 Node 内建）。** 比 v0.3 草案估的 330 行多出的部分，几乎全部来自评审后补的**工作队列**（§3.5，改动 #3–#5）——没有它，「批次上限」「失败不中断」「存量约 952 条跑一晚」都失去前提。三笔旧债（§6）仍然必须一起还，否则接云端端点等于把含密钥的会话原文发出去、把密钥提交进 git。

第一步改八件事：**端点、鉴权、模型名、预算与超时、工作队列、可观测、宽松解析、进度与粗估**，加工语义暂不动（产出的仍是候选条目）。
第二步做**活文档对齐**（§7，已确认要做），因为要新增 prompt v2、证据锚定与置信度口径，混进来会拖慢第一步交付。

**开工姿势**：第一步只用 `--limit 5–20` 验证管道（stub + 小批真实会话）即可，存量消化放到来 prompt v2 落地之后——规则 2 会按 prompt 版本全量重排，先跑满存量等于同一份内容付两遍钱，v1 散条目还多一份清理。这不是 D6 的矛盾（D6 分的是交付步骤，「跑一晚」在解释队列为什么必须存在），只是执行顺序上的省钱口径。

---

## 1. 现状（代码事实）

| 行为 | 位置 | 问题 |
|---|---|---|
| 三个 env 缺一不可：`OMEM_API_KEY` + `OMEM_API_BASE` + `OMEM_API_MODEL` | `src/process/api.ts:12` | 本机端点没有 key 也被判"未配置"，本地模型用不了 |
| 无 `config.toml` 配置项 | `src/core/config.ts:12-27`（无 `[api]` 段） | 只能靠环境变量，重启终端就丢，也没法被 `omem init` 引导 |
| 永远发 `Authorization: Bearer <key>` | `src/process/api.ts:30` | 无 key 时会发出 `Bearer undefined`；部分本机 server 会因此 401 |
| URL 拼 `${base}/chat/completions` | `src/process/api.ts:26` | 用户填 `http://localhost:11434/v1` 才对，填 `.../11434` 会 404，且没有提示 |
| 输入硬编码 `slice(0, 12000)` | `src/process/api.ts:25` | 本地小模型吃不下这么长（CPU 慢 + 长文本中间丢失），云端又可能想更长 |
| 超时固定 60s | `src/process/api.ts:40` | CPU 上 2B 模型出一份摘要约 30–40s，加上 prompt 处理很容易超时 |
| 未配置时抛 `new Error(apiSetupHint())` | `src/process/pipeline.ts:77` | 不是 `UsageError`，退出码落到 1 但文案不统一；且提示里还写着已移除的"档 0 规则抽取" |
| `--dry-run` 仍会调用 API | `src/process/pipeline.ts:83-87` | dry-run 的目的是"看看要做什么"，现在却照常花钱/耗时 |
| 失败即整批中断？——实际是单条抛错向上冒泡 | `src/process/pipeline.ts:84` | 一个会话超时，整批报废；无重试、无跳过、无失败计数 |
| 串行、无批次上限 | 同上 | 云端无成本上限；本地模型跑一晚也可能跑不完 |
| **无「待加工」状态** | `src/collect/collector.ts:80`（按 `content_hash` 跳过已入库会话；sessions 表无加工字段） | 跑过默认档的存量库里，`--tier api` 不带 `--session` 时待加工数为 **0**——批次、失败重试、存量消化全部失去前提（§3.5） |
| `default_tier = "api"` 时不带 flag 静默走同步路径 | `src/commands/run.ts:29`（判断的是 flag，不是 `resolveTier` 之后的 tier） | 配了 API 档默认值的用户以为在用 API，实际是 agent 档行为 |
| 候选条目不带 `topic` | `src/process/api.ts:59-68` → `commitEntry` | 与 0.1.0-beta.3 的"一主题一份活文档"模型脱节，产出的都是无 topic 的散条目 |

---

## 2. 目标与非目标

**目标**

1. 本机端点（回环地址）**免 key** 可用，并明确"本机"的判定规则。
2. 云端端点**带 key** 可用，端点/模型/key 都可配（config 或 env）。
3. 超时、输入预算、每批会话数可配，且默认值对 CPU 友好。
4. 单条失败不中断整批，失败可诊断（日志 + 明确的错误分类），且**下批自动接续**——失败不是永久丢失。
5. `--dry-run` 不发起任何网络调用，也不改任何加工状态。
6. **批次是队列的窗口，不是一次性切片**：加工状态跨运行存续（`omem rebuild` 与 `omem sync` 均存活），批次**溢出**的会话下批自动接续（§3.5）。术语固定：**溢出**=本批没排上、状态未写、继续排队；**截断**=输入超 `max_input_chars` 砍短、本次照常加工、成功即 `ok`。两者混用会写错状态。

**非目标**

- 不嵌 runtime，不下载模型，不引入任何依赖。
- 不改加工语义（不产出主题活文档、不做 supersede）——那是第二步（§7）。
- 不做并发、不做成本统计 UI、不做 prompt 版本迁移工具。
- **不支持局域网 / 私网端点**：回环之外一律按云端规则（强制 https + 必须 key）。NAS / GPU 盒跑 ollama 是真实场景，列为后续版本的显式 opt-in（如 `api.trusted_hosts`），本版不静默放开（§3.2）。
- 不做同一次运行内的自动重试：重试的单位是「下一次 `omem run`」（§3.4）。

---

## 3. 设计

### 3.1 配置来源与优先级

**env > `config.toml [api]` > 内置默认**。env 覆盖 config，便于临时切换端点做对比。

| 键 | config 段键 | env | 默认 | 说明 |
|---|---|---|---|---|
| 端点 | `base` | `OMEM_API_BASE` | `http://localhost:11434/v1` | 必须带 `/v1`；缺失前缀时给出可操作提示 |
| 鉴权 | `key` | `OMEM_API_KEY` | 空 | 空 key 仅在本机回环时允许（§3.2） |
| 模型 | `model` | `OMEM_API_MODEL` | 空 | 空则探测 `GET {base}/models`（见 3.3） |
| 超时 | `timeout_ms` | `OMEM_API_TIMEOUT_MS` | 本机 300000 / 非本机 60000 | 本地模型跑在 CPU 上必须放宽 |
| 输入上限 | `max_input_chars` | `OMEM_API_MAX_CHARS` | 本机 6000 / 非本机 12000 | 本地小模型长上下文收益差（慢且中间丢失） |
| 每批上限 | `limit` | `OMEM_API_LIMIT` | 20 | 非本机时 config/env 值被钳到 ≤50，仅 CLI `--limit` 可越过（§3.6） |

`config.toml` 新增段（不写即取默认）：

```toml
[api]
base = "http://localhost:11434/v1"   # ollama / llama-server 的 OpenAI 兼容端点
# key = ""                            # 本机免 key；云端才填
model = ""                            # 留空则探测端点上的第一个模型
# timeout_ms = 300000                 # 留空按端点类型取默认（本机 300000 / 非本机 60000）；写进 config 会固定生效、压过按端点分档
# max_input_chars = 6000              # 同上（本机 6000 / 非本机 12000）
limit = 20
```

### 3.2 免 key 的判定规则（安全护栏）

判定对象是 base URL 的**字面量**，不做 DNS 解析。

**回环集合**：主机名为 `localhost`；IPv4 落在 `127.0.0.0/8`；IPv6 `::1`；IPv4 映射地址（`::ffff:127.0.0.1` 等，`::ffff:0:0/96` 内嵌 IPv4 属于 127/8 的）。

规则：

1. **key 为空**：仅"回环 + http/https"放行，且**不发送 `Authorization` 头**；其余一律 `UsageError`（退出码 1），提示："Non-local endpoint requires an API key: session transcripts would be sent unauthenticated to `https://…`. Set OMEM_API_KEY or [api].key, or use a loopback endpoint."
2. **key 非空**：**无论端点在哪，一律发送**。llama-server 启动时带了 `--api-key` 的用户，显式配置的 key 被吞掉会得到无法排查的 401。「免 key」只是"空 key 的放行条件"，不是"回环不发 key"。
3. **非回环强制 https**：明文 `http://` 非回环直接拒绝，提示改用 https。
4. **fail closed 的已知盲区（有意为之）**：`0.0.0.0` 不算回环；hosts 别名（如 `mybox` → 127.0.0.1）不识别。想免 key，就把 base 写成 `localhost` 或 `127.0.0.1`。
5. **局域网 / 私网端点本版不支持**（§2 非目标）：`192.168.x.x` / `10.x` / `172.16–31.x` 一律按非回环规则处理（强制 https + 必须 key）。

理由不是形式主义：这条路径会把**完整会话原文**发到远端，无鉴权端点等于把数据交给未知接收方。

### 3.3 模型名

- 显式给了 `model` → 直接用。
- 没给 → **每次运行只探测一次** `GET {base}/models`（不是每会话一次）：取返回列表第一个 `id`；**列表多于一个时把全部 id 打印出来**并提示 "using <first>; set [api].model or --model to override"——ollama 多模型时列表顺序没有业务含义，静默选中小非指令模型会让整批 `parse_failed`。
- 探测失败 → `UsageError`（退出码 1），要求显式 `--model`。
- ollama、llama-server、OpenAI 兼容端点都实现了 `/v1/models`，这条路是通用的。

### 3.4 超时、失败、重试与退出码

- 超时用 `AbortSignal.timeout(timeout_ms)`，默认按"是否本机"分档（§3.1）。
- **单条失败不中断整批**：HTTP 非 2xx、超时、JSON 解析失败 → 记一条 `event: api` 日志（含 status/duration/model），跳过该会话继续。
- **不自动重试** 429/5xx（避免放大与额外账单）。重试的语义由队列承担：传输级失败不写加工状态（§3.5 规则 3），**下一次 `omem run` 自动重新进队列**——重试的单位是"下一次运行"，不是同一次运行里的循环。
- **连续 3 次传输级失败 → 中止整批**：中止计数器只统计 HTTP 非 2xx / 超时 / 网络错误；`parse_failed` 是会话级事件（由 §3.5 的隔离机制处理），不计入、不触发中止。解析失败说明端点已经返回了正文，中止计数在这里归零——中间夹一次 `parse_failed` 的 500 不能算成连续三次。中止抛 `BackendUnavailableError`（退出码 2），提示 "endpoint appears unavailable; partial results kept — run omem api status"。中止前先刷新 `PROCESS.md` 与 `MEMORY-INDEX.md`，已产出保留，不打印看起来已经跑完的 done 行。
- **退出码**：整批跑完（含零星失败/隔离）→ **0**，失败数在汇总行与日志里（与"冲突是事件不是错误"同一条哲学）；中止 → **2**；未配置/参数错误 → **1**。定时任务要感知失败，读汇总行或 JSONL 日志，不靠退出码。

### 3.5 API 档工作队列（评审新增：批次与存量加工的前提）

**问题**：现有采集按正文哈希跳过已入库会话（`src/collect/collector.ts:80`），"已入库"和"已加工"是两回事。对一个跑过默认档的存量库（实测 952 条），`--tier api` 无 `--session` 时待加工数为 0——批次上限、失败接续、存量消化全部失去对象。本节定义「待加工」。

**事实源是 session 文件的 frontmatter，不是 SQLite。** `sessions/` 提交进数据仓、`index/` 被 gitignore 且 `rebuild` 会清空 sessions 表重建（`src/core/index.ts:299`）——状态只放 SQLite 的话，`omem rebuild` 会把它连同全部加工进度一起清掉。Markdown 是事实源是本仓库的宪法，这里照办：状态写进 `sessions/<agent>/<id>.md` 的 frontmatter，sessions 表加一列镜像，从文件重导（`parseStoredSession` 天然忽略未知键，`content_hash` 只对正文生效，加字段向后兼容）。

**重导要覆盖 api_state 单独变化的场景。** `reindexSessionFiles` 的快路径只比较 `content_hash`（`src/core/index.ts:313`），而这个哈希只覆盖正文——`omem sync` 拉回另一台机器写好的 `ok` / `skip` 时正文未变，connect-time catch-up 不会把 frontmatter 导回镜像，队列会按旧镜像把已完成会话重新送加工。处置：快路径比较条件改为 `content_hash` 与 `api_state` **任一不等即重导**（改动 #5，验收 V34）。`omem rebuild` 走 `force=true` 本就全量重导，V23 盖不住这条。崩溃窗口没有想象中绝对：下一次加工成功仍会把索引写回去，代价只是多烧一轮。

**队列基数口径（写死）**：API 队列的定义是「没有 `api_state`」，基数按**全量会话**计（实测约 952 条）；已吸收会话默认仍进 API 队列，不预置 `ok`。931 是 agent 档 PROCESS.md 未吸收会话的口径，只在讲 PROCESS.md 时使用；212 是无项目指纹的 unassigned 口径。示例数字一律按全量计。

**状态字段：`api_state`，单一字符串**，语法 `ok|fail|skip : <prompt版本> : <content_hash> [: 计数]`：

| 值 | 含义 | 下次运行 |
|---|---|---|
| （缺省） | 从未加工 | 进队列 |
| `ok:v1:ab12…` | 已用 prompt v1 成功加工该内容 | 不进（除非 prompt 版本或内容变更） |
| `fail:v1:ab12…:1` | 该内容解析失败 1 次 | 进队列重试 |
| `skip:v1:ab12…` | 同一内容解析失败 2 次，隔离 | 不进（`--session` 显式点名可越过） |

规则：

1. **内容变更即重排；哈希未变则保状态**：state 里嵌的是当时的 `content_hash`；会话增长或外部编辑导致 hash 变化 → 旧 state 视为不存在，重新进队列。哈希未变时**必须保留原 `api_state`**：跳过重写的是 `scanSessions`（条件含 `!opts.sessionId`），`writeSessionFile` 本身总是整文件重写且不认识该字段——`--session` 点名在哈希未变时会先抹掉已有 `ok`，传输失败按规则 3 又不写新状态，成功状态就丢了。`--session` 只越过队列过滤（隔离与 limit），状态只在成功之后才改写。不要把「显式重写即用户要求重加工」当成唯一处置。
2. **prompt 版本变更即重排**：v1 加工过的会话在 prompt v2 上线后全部重新进队列（质量口径变了，旧产物不代表新口径）。预跑行会显示 `pending 952 (952 requeued by prompt v2)`（按全量会话计，见上文基数口径），**绝不静默重花一遍钱**；节奏由 `--limit` / `--since` 控制。v1 遗留的散条目不自动清理：迁移完成后用既有命令处理——`omem redact --source llm`（默认只预览，`--yes` 才删）或 `omem review --dismiss`。
3. **传输失败不写状态**：HTTP 非 2xx / 超时 / 网络错误 → 不写 `api_state` → 下次运行自然重试。与 §3.4"重试单位是下一次运行"互为表里。
4. **解析失败计数到 2 即隔离**：同一 hash 连续 2 次 `parse_failed` → `skip`，防止 hopeless 会话每晚烧钱。隔离数在汇总行单列（`quarantined N`）。
5. **崩溃窗口的重复产物按层处置**：先写文件、再更新索引行；两步之间崩溃 → 下次重复加工一次。活文档层靠 supersede 收敛；条目层只保证**严格相同文本**的幂等（归一化 `body_hash`），`temperature: 0.2` 下同会话重跑几乎必然换措辞，近似重复落在 `omem review --dismiss` 收尾——不加模糊去重。
6. **队列顺序 `last_ts DESC`（最新优先）**：新记忆价值最高，存量往下排；隔离上限（规则 4）已封死"坏会话堵住队头"的问题。
7. **`--session <id>`**：显式点名，越过队列过滤（隔离与 limit），单会话加工；状态改写仍按规则 1/3/4——成功才落新 state，哈希未变不抹旧 state。
8. **dry-run 不写状态**（V5）。
9. **两档不抢活**：agent 档不读写该字段；API 档产出的活文档带 `source_sessions` → 同一次运行结束时重写 `PROCESS.md`，会话从待办里消失（`absorbedSessionIds` 既有关联）。只更新文件，不把引导全文打到终端。API 档消化存量反而给 agent 档减负。
10. **过滤**：队列物化沿用 `--since`（按 `last_ts`）；默认取全部待加工。

**发送内容 = 存储正文**：队列条目直接携带 `sessions/` 里已脱敏的正文（入库时 `prepareDialogue` 已过 `redactSecrets`，`src/collect/session-store.ts:64`），`extractWithApi` 不再从 `digest.messages` 另拼一份原文——详见 §6.1。

改动落点：`src/process/queue.ts`（新，物化队列）+ `src/collect/session-store.ts`（字段渲染/解析/外科手术式更新）+ `src/core/index.ts`（sessions 表加列 + 重建导回）。

### 3.6 输入预算、每批上限与"非本机硬上限"（D3）

- `max_input_chars` 按是否本机分档（本机 6000 / 云端 12000），截断保留**最近** N 字符（记忆提炼里最新消息信息密度最高），并在发送正文头部注明 `(truncated)`。
- `--limit N` 限制本批会话数，默认 20；批次**溢出**的会话留在队列里（§3.5），下次运行自动接续。汇总行的 `pending` 是**本跑结束后**重新物化的剩余数：溢出，加上传输失败和尚未隔离的解析失败。不用开跑前的溢出数，否则本批排得下、中间有失败时会报 `pending 0`。
- **非本机硬上限 50 只约束 config / env**：`api.limit` / `OMEM_API_LIMIT` 对非回环端点钳制到 50 并打印警告——持久配置不该能静默穿透"知情确认"（为本机配的 `limit = 200`，换云端端点时不该自动生效）。**只有 CLI `--limit` 的显式数字可越过 50**（D3：显式写出即视为知情确认）。本机端点不受此限。
- 并发固定 1（本地是 CPU 串行，云端先不引入并发复杂度）。

**为什么只对非本机端点设硬上限（回答"出于什么考虑、什么场景"）：**

它防的不是"跑太久"，而是三件具体的事：

1. **数据外泄的爆炸半径**。这条路径会把**完整会话原文**发给远端。端点配错（填错域名、指向了某个接受任意 POST 的日志/收集服务）时，没有上限 = 整个 `sessions/`（实测 952 条 / 16MB）被一次性发出；有硬上限 = 最多 50 条。脱敏（§6.1）只能挡住"密钥形态"的敏感内容，挡不住业务内容、客户名、内部代号。
2. **账单的事前护栏**。以本机实测基线算：约 952 条待加工 × 约 2.2k tokens ≈ 200 万 tokens 输入（931→952 的 21 条差异在粗估里可忽略，口径见 §3.5）。便宜的国产模型约几元，但如果用户把端点配成高价模型（或将来换模型忘了改配置），同一次命令可能就是几十到上百元，而且是**一条命令静默花掉的**。
3. **中断的沉没成本**。结果只在 `commitEntry` 时落盘，命令跑到一半 Ctrl+C，已花掉的钱和算力全丢。批次封顶让"中断"的代价有界。

配套：命令开始前先打印一行预估（本批 N 个会话 / 约 X tokens / 端点 Y / 是否本机），给用户一个 Ctrl+C 的机会。

### 3.7 可观测：新增 `omem api status`

```bash
omem api status
# 打印解析后的生效配置：端点 / 是否本机 / key 是否会随请求发送 / 模型 / 超时 / 输入上限 / limit
# 打印队列深度：pending N · quarantined M
# 探测一次 /v1/models（不发送会话内容）；多模型时列出全部 id
```

这是我认为**性价比最高的一条**：本地模型调试最大的痛点是"到底通没通、用的哪个模型"，一条命令解决，且不发任何会话内容。日志侧新增 `event: api`。

它同时承担**部分配置组合的消歧**：

- key 已配置但端点为本机 → "key is set and will be sent (loopback endpoint)"；反向（key 为空 + 非本机）→ 直接报 §3.2 的错误。杜绝"只设了 key 打算用云端，请求却默默发往默认本机端点"这类静默意外。
- 队列深度让人对"存量还有多少没跑"有数，配 `--limit` 心里有底。

### 3.8 `--dry-run` 不得发起网络调用，也不得改队列状态

`runPipelineAsync` 里 dry-run 时直接跳过 `extractWithApi`（现在只是不落盘，照样调 API），**并且不写任何 `api_state`**——dry-run 看的是"将要做什么"，不能留下副作用。预跑行（§3.11）照常打印，让用户先看量级再决定真跑。

### 3.9 逐条进度输出（D4）

本地模型一个会话约 30–40 秒，一晚跑几百条。必须有逐条进度，且要**单行覆盖而非刷屏**（以下为第一步语义；第二步的 topic 行见 §7）：

```
[api] batch: 20 sessions · ~44k tokens (rough estimate) · base http://localhost:11434/v1 (local, no key)
[api] 3/20  session 8ae4d7b7…  → 2 candidates                          34.2s
[api] 4/20  session 455ba71f…  → 0 candidates (nothing kept)           1.1s
[api] 5/20  session 04451c6b…  → failed: http 500 (logged, continue)    2.0s
[api] 6/20  session 685fc851…  → parse_failed (raw in log; 2nd strike)  9.4s
```

非 TTY（定时任务）自动降级为每 10 条一行，避免把日志灌满。结尾汇总各计数**分列**（`parse_failed` 与 `failed` 不混——本地模型的主要失败模式就是解析失败，混在一起看不出根因）：

```
[api] done: written 18 · deduped 3 · failed 1 · parse_failed 1 · quarantined 1 · elapsed 12m30s · pending 892
```

### 3.10 宽松解析到什么程度（D7）

本地 2B 模型很难稳定输出纯 JSON。采用**逐级尝试 + 失败兜底**，每级都比上一级更宽松，且失败才降级：

| 级 | 做法 | 说明 |
|---|---|---|
| 1 | `JSON.parse(text.trim())` | 理想情况，直接过 |
| 2 | 剥掉 ```json / ``` 代码块（允许语言标签、缩进、前后空行）后 `JSON.parse` | 覆盖"模型顺手加了围栏" |
| 3 | 取**括号计数**得到的第一个平衡切片（第一个 `{`/`[` 起，配对到对应的 `}`/`]`）后 `JSON.parse`；**计数必须字符串感知**——引号内的括号不计数；字符串内遇反斜杠跳过下一字符（任意 `\X`，含 `\\`——只认 `\"` 的话 `\\"` 会把结束引号吃掉，括号计数跟着错）；引号扫描自身失衡（奇数引号等）→ 该级直接判失败，落到兜底 | 覆盖"首尾多了句子"；用计数而非贪婪正则，避免嵌套对象被截断 |
| ✗ | 全部失败 → 记 `event: api`、`status: parse_failed`，raw 原文**截断 2000 字符**写进 `logs/omem.log`，该会话按 §3.5 规则 4 计一次解析失败 | 不猜、不补 |

**明确不做的事（这是边界，不是待办）**：

- 不接受多个 JSON 拼接（只取第一个完整结构）。
- 不做"语义修复"：不补引号、不补逗号、不猜缺失括号、不把自然语言硬解释成 JSON。
- 不把解析失败的文本写进 `knowledge/`、不写进 `MEMORY-INDEX.md`、不写进条目正文——**只进日志**。

理由：越往后一级，越容易把模型的闲聊当成结构化结果。静默修复比失败更危险——这一条跳过只是少一份文档，误收则会污染检索，812 条碎片那次的教训就是这个。

### 3.11 本批预估 token 量级（D10）

`omem run --tier api` 在真正发起调用**之前**打印一行，给用户一个 Ctrl+C 的机会：

```
[api] batch: 12 sessions · ~26k tokens (rough estimate) · base http://localhost:11434/v1 (local, no key)
```

- 粗估公式：`chars / 1.5`（中英混合量级），并在输出里写明是 rough estimate。
- **不接价格表、不发任何网络请求、不算钱**——只让人知道量级（几千 / 几万 / 几十万）。
- 非本机端点额外多一句提示（提醒内容会离开本机），但仍然不报价。
- 队列被 prompt 版本重排时，预跑行追加 `pending N (M requeued by prompt v2)`（§3.5 规则 2）——绝不静默重花一遍钱。

---

## 4. 命令面

```bash
# 本地模型（ollama 已跑起来，免 key）
omem run --tier api
omem run --tier api --model minicpm5-2b --limit 5

# 云端（key 走 env，或写进 config.toml 的 [api].key —— 见下方警告）
OMEM_API_KEY=sk-xxx omem run --tier api --base https://api.deepseek.com/v1 --model deepseek-chat

# PowerShell（上一行是 bash 语法；Windows 是本项目的一等公民平台）
$env:OMEM_API_KEY = 'sk-xxx'
omem run --tier api --base https://api.deepseek.com/v1 --model deepseek-chat
```

- 新增旗标 `--base` / `--model` / `--limit`，覆盖 config/env；其中 `--limit` 是唯一能越过非本机硬上限的入口（§3.6）。
- 顺带修一个现状 quirk：`process.default_tier = "api"` 且不带 flag 时，`cmdRun` 判断的是 flag 而非 `resolveTier` 之后的 tier（§1 倒数第二行），本次把判断挪到解析之后。

云端端点示例（**以各家官方最新文档为准**）：DeepSeek `https://api.deepseek.com/v1`；通义 `https://dashscope.aliyuncs.com/compatible-mode/v1`；OpenAI `https://api.openai.com/v1`。

**关于 `[api].key` 写进 `config.toml`（D5）：允许，但必须警告。** `config.toml` 在数据仓里，会被 `omem sync` 提交并推送到远端 git 仓库——写进去等于把密钥放进版本历史和别人的 clone 里。文档与 `omem api status` 都要明确写这句警告；默认值留空，且 `omem init` 不引导填它。

---

## 5. 改动清单与难度

**第一步（端点、护栏与工作队列）：**

| # | 文件 | 改动 | 预估 | 难度 | 风险 |
|---|---|---|---|---|---|
| 1 | `src/process/api.ts` | 配置解析（env>config>默认）、URL 校验、回环判定与鉴权、模型探测、错误分类 | ~100 行 | 中 | 中：鉴权判定写错就等于数据裸奔 |
| 2 | `src/core/config.ts` | 新增 `[api]` 段（解析 + 序列化 + 默认值） | ~25 行 | 低 | 低：但须进 `OmemConfig` 类型——`saveConfig` 是整文件按类型重写（文件头写明 unknown keys are ignored），`pause` / `resume` / `profile use` / `sync use` 都走这条路；`[api]` 不进类型，手写的 key 会被静默清掉（V33）。文本级段合并是 install 写客户端配置的纪律，不适用这里 |
| 3 | `src/process/queue.ts`（新） | 从 sessions 台账物化待加工队列（状态机判定、排序、`--since`/`--session` 过滤） | ~45 行 | 中 | 中：状态机边界（§3.5）要写死 |
| 4 | `src/collect/session-store.ts` | `api_state` 字段渲染/解析/外科手术式更新；哈希未变时保留原 state（§3.5 规则 1） | ~30 行 | 低 | 低：`content_hash` 只对正文，互不干扰 |
| 5 | `src/core/index.ts` | sessions 表加 `api_state` 列（rebuild 导回）；**catch-up 快路径改为 `content_hash` 与 `api_state` 任一不等即重导**（§3.5） | ~25 行 | 低 | 低：rebuild 必须保状态（V23），catch-up 漏导见 V34 |
| 6 | `src/process/pipeline.ts` | 队列接入、发送存储正文、dry-run 跳过、失败隔离、中止计数、`UsageError` | ~50 行 | 中 | 中 |
| 7 | `src/commands/api.ts`（新）+ `src/cli.ts` | `omem api status`（生效配置 + 队列深度 + /models 探测） | ~75 行 | 低 | 低 |
| 8 | `src/commands/run.ts` | `--base`/`--model`/`--limit` 旗标；`default_tier=api` 的分发修正 | ~20 行 | 低 | 低 |
| 9 | **发送侧用存储正文（已脱敏）** | 见 §6.1 | 随 #6 | 低 | **高（不做就是安全债）** |
| 10 | 进度输出（TTY 单行覆盖 / 非 TTY 每 10 条 / 分列汇总） | 见 §3.9 | ~30 行 | 低 | 低：注意非 TTY 别灌满日志 |
| 11 | 宽松解析（逐级尝试 + 兜底，字符串感知括号计数） | 见 §3.10 | ~40 行 | 中 | 中：边界要写死，别做成"猜语义" |
| 12 | token 粗估 + pending 行 | 见 §3.11 | ~12 行 | 低 | 低 |
| 13 | sync 前扫非空 `[api].key` 并警告（pull 之前） | 见 §6.3 | ~15 行 | 低 | 低：只读不写 |
| 14 | `tests/unit/api-tier.test.ts`（新，本地 stub server） | 见 §8 | ~240 行 | 中 | 低 |
| 15 | `README.md` | API 档用法 + 本地模型示例（bash 与 PowerShell）+ key 警告 | ~30 行 | 低 | 低 |

**第一步合计：约 500 行源码 + 240 行测试，零新增依赖**（`fetch` / `AbortSignal` 均为 Node 内建）。比 v0.3 草案的 330/160 多出的部分即 §3.5 工作队列（#3–#5）及其测试。

**第二步（活文档对齐，§7）的预估：**

| # | 文件 | 改动 | 预估 | 难度 |
|---|---|---|---|---|
| 16 | `src/process/api.ts` | prompt v2（数组输出 + 注入项目既有 topic 与活文档全文） | ~100 行 | 中 |
| 17 | 证据锚定与置信度 + `score.ts` 归一化对齐 | 见 §7.1/§7.2 | ~55 行 | 中 |
| 18 | 自动补 `supersedes` + topic 事后校验（复用/近似告警） | 见 §7.3/§7.4 | ~40 行 | 中 |
| 19 | 响应校验（topic 唯一、≤5 份、evidence 门槛） | 见 §7.2 | ~20 行 | 低 |
| 20 | 测试 V28–V32 + `score.ts` 回归 | 见 §8 | ~140 行 | 中 |

---

## 6. 必须一起还的三笔债（P0）

### 6.1 发送的就是已脱敏的存储正文，而不是另拼一份

现在 `extractWithApi` 从 `digest.messages` 另拼一份原文直接发，而脱敏只发生在入库路径（`prepareDialogue`，`src/collect/session-store.ts:64`）——**接云端端点 = 把含密钥的会话原文发给第三方**。修法比"发送前再脱敏一遍"更彻底：**API 档改为发送 `sessions/` 里已脱敏的存储正文**（§3.5 的队列本来就从台账读会话，顺手取正文）：

- 入库时已过 `redactSecrets`，发送侧零新增脱敏代码，且「发出去的 = 存下来的」逐字节同构；
- 证据锚定（§7.2）的比对对象与模型看到的是同一份文本，evidence 不会锚到模型没见过的内容；
- 截断（`max_input_chars`）发生在发送前，保留最近 N 字符（§3.6）。

验收里必须有一条断言（§8 V6）：发出的 body 里不含密钥原文。

### 6.2 错误文案与退出码

`apiSetupHint()` 还写着 "or use the default tier 0 (zero-config rule extraction)"——档 0 在 beta.2 已移除，这句话现在是错的。未配置时应抛 `UsageError`（退出码 1，用法类问题），端点不可达时用 `BackendUnavailableError`（退出码 2），与规格 §7 的退出码语义对齐。所有拟新增的用户可见文案一律英文（仓库纪律：单语英文 CLI）。

### 6.3 `omem sync` 提交前扫非空 key（D9）

`config.toml` 在数据仓里，会被 `omem sync` 提交并推送到远端。既然允许 `[api].key` 写进 config（D5），就得在提交前拦一句：

- **时机**：`syncBody` 入口、**任何 git 动作之前**。不只 push 需要——`GitBackend.pull` 遇到未提交改动同样会 `git add -A` 自动提交（`src/sync/git.ts:165`），而默认流程是 pull→push，等到 push 再拦，密钥已经进了 pull 的 autosave 提交。
- **行为**：`[api].key` 非空 → 打印警告，但**不阻塞、不改文件、退出码不变**：
  ```
  config.toml contains a non-empty [api].key; it will be committed to the git data repo.
    → prefer OMEM_API_KEY in the environment, or add config.toml to .gitignore.
  ```
- **不做**：不自动清空、不自动加 gitignore、不改写用户的 config（改写会丢他手写的未知键——既有纪律）。
- 顺带说明：`.gitignore` 只在首次建仓时写入（`init()` 的 `fresh` 分支），所以用户手改的忽略规则不会被覆盖——这条要在文档里讲清楚，否则用户不敢改。
- **测试**：动 `sync.ts` 按仓库纪律必须跑 `npm run smoke`；V12 同时加进 smoke 断言。

---

## 7. 语义对齐（D1：已决定做 —— 多条 session → 一份 topic 活文档）

档 3 现在产出的是**候选条目**（`source: 'llm'`，无 `topic`），与 `knowledge/` 的"一主题一份活文档"不同构，也不会 supersede。已确认按 B 方案对齐：**同一 topic 的多条原始 session 汇总成一份活文档**，落进 `knowledge/`，遵循现有的 supersede 规则（旧版留在磁盘、退出检索）。

### 7.1 置信度怎么定（D2）

**结论：不采信模型自评，置信度由"证据锚定"决定；用户确认走已有的 `omem review --confirm`，且是抽检不是全量。**

三个层次各司其职，不要新造一套打分机制：

| 层 | 谁决定 | 取值 | 说明 |
|---|---|---|---|
| 初始置信度 | **omem 用字符串校验**，不靠模型 | 完全沿用现有口径 | 模型必须给出 `evidence`（从 `## user` 段原样摘的 ≥12 字符）：锚得上 → **0.55** 起；两个及以上会话互相印证 → **0.75**；锚不上 → 封顶 **0.35** 并打 `ungrounded` |
| 上限 | omem 硬约束 | **≤0.75** | API 档产物没有任何人看过，不允许自动进入"高置信"区间；`verified` 恒 `false` |
| 提升 | 人（`omem review --confirm`） | → 0.9 + `verified: true` | 已存在的机制，直接复用 |

**为什么不采信模型自评**：现在的 prompt 让模型自己填 `confidence`，但小模型自评系统性虚高，而且它对自己的幻觉最有信心。用一个**可机械验证的信号**（evidence 是否真的出现在原文里）替代主观分数，既能复算、也能在回归测试里断言。

**与 save_memory 共用一把尺子（D8 修订）**：`scoreEvidence` 现行是原文 `includes` 匹配（`src/process/score.ts:44,55`），并无归一化。第二步落地时**同步把它改为归一化子串匹配**（复用 `normalizeForHash`），使同一份 evidence 无论走 Agent 路径还是 API 路径得分一致；**门槛仍按原文长度 ≥12 字符**——不按归一化后长度，否则标点密度高的既有 evidence 会因归一化变短而回归成 ungrounded。

**关于"让 Agent 列出活文档、由用户打分"（你的提议）**：机制其实已经存在，就是 `omem review`（队列）与 `--confirm`（提到 0.9）。我不建议新增"人给每条打 0–1 分"的环节，原因有三：

1. **人打绝对分的一致性差**，同一个人在不同时间给同一条会打出不同分，数据不可复算；
2. **成本不可持续**——26 份文档可以人工过一遍，但存量约 952 条会话会产出几百份，全量打分等于把自动化省下的时间还回去；
3. **打分对象错了**：该让人判断的是"这份活文档对不对"（二值/三值 → 直接映射 `confirm` / `dismiss`），而不是"这条 0.6 还是 0.7"。

所以落法是：**API 档产出后，只对"即将被高频检索命中的文档"做抽检确认**（比如 `omem review` 默认取最近 N 份 + 置信度 ≤0.35 的全部），其余保持未确认状态并在检索结果里标注时效与未确认——这与 V0.1 既有的"把判断权交给消费者"一致。

### 7.2 输出契约（prompt v2 草案）

模型输出**活文档数组**（一个会话可能涉及多个主题，真实基数是 N 会话 : M 文档；只许输出单个对象会把多主题会话压扁成一个 topic）：

```json
[
  {
    "topic": "matea-git-sync-trust-model",
    "content": "……活文档全文（3-10 句，只留结论不留过程）……",
    "type": "decision|fact|experience|preference",
    "domain": "coding",
    "evidence": ["从 ## user 段原样摘的 ≥12 字符", "第二条"],
    "tags": ["git_sync", "trust-model"]
  }
]
```

- 数组上限 **5 份**，超出取前 5 并记日志；**topic 在数组内必须唯一**，重复以第一份为准并记日志。
- **注入既有活文档**：按会话的 `project_fp` 取该项目的 active 活文档（topic + 全文，通常 0–3 份）进 prompt：「本会话若属于其中某个 topic，输出该文档的**更新版**（合并本次证据，只留结论）；否则才新建 topic」。这是 D1"多会话 → 一份活文档"的实现机制——不是一次批处理多会话，而是**逐会话增量合并**，"活"体现在 supersede 链上。只看当前会话、不看旧版的"活文档"，最终只会反映最后一次提取，那就不是活文档了。
- **边界（写死）**：无 `project_fp` 的会话（实测 212 条 unassigned）**不做增量合并，只新建 topic**——§7.2 的注入按项目取，这批取不到候选，只剩 §7.4 的近似告警兜底。不注入全局 active 列表：会撑破「通常 0–3 份」的预算，也会把 A 项目的结论串进 B 项目的会话。
- omem 侧逐条校验 `evidence` 是否出现在对应会话的 user 段；**一条都锚不上就降级 0.35 + `ungrounded`，但仍然落盘**（与现有策略一致：质量不够但"有东西"胜过"没有"）。

**匹配规则（D8，先归一化再比对）**：

1. 复用现有 `normalizeForHash()`（`src/core/util.ts:12`：去空白、去 `\p{P}` 标点、去 `\p{S}` 符号、大小写折叠）——**不新写一套归一化**；`score.ts` 同步对齐（§7.1），保证证据锚定与条目幂等去重（`contentHash`）、以及两条写入路径的打分，用的是同一把尺子。
2. 门槛：**原文** ≥12 字符（沿用 save_memory 既有口径；归一化只用于比对，不用于量长度）。
3. 判定：`normalizeForHash(evidence)` 是否为 `normalizeForHash(user 段全文)` 的**子串**。
4. 落盘时 frontmatter/正文里保留 evidence **原文**，归一化只用于比对，不写进文档。

**已知边界**：归一化去掉全部空白与标点后，两条消息首尾拼接可能在极少数情况下"拼出"一条 evidence（假阳性）。接受它：evidence 本身 ≥12 字符且必须落在 user 段内，碰撞概率低；而漏报（把真实命中判成 ungrounded、置信度系统性偏低）更难发现、代价更高。

不归一化会怎样：本地小模型摘的片段常带多余空格、换行、中英文标点差异，直接比对会把大量真实命中误判成 `ungrounded`，置信度系统性偏低——那比模型自评虚高更难发现。

### 7.3 supersede 由 omem 自己补

`save_memory` 路径要求 Agent 显式传 `supersedes`（否则拒绝），因为那时有 Agent 在环。**API 档没有 Agent 在环，必须由 omem 自己补**：拿到 `topic`（经 §7.4 事后校验收敛后）调 `findActiveByTopic()`，若已存在 active 文档就自动填 `supersedes`，不需要模型知道这件事。这一条不做的话，每跑一次 API 档都会因为"topic 已存在"而被拒——等于这个档位不可用。

### 7.4 topic 同一性：复用优先，疑似分叉只报告

2B 模型不可能稳定产出 `matea-git-sync-trust-model` 这种 slug；`git-sync-trust` 与 `git-sync-trust-model` 会变成两份互不 supersede 的 active 文档——主题碎片化恰恰违背 D1 的"一主题一份活文档"。三道防线，且都不自动合并（与"冲突只报告"是同一条纪律）：

1. **prompt 注入候选列表（主要防线）**：§7.2 注入既有活文档时，模型看得见该项目已有的 topic slug，prompt 明确要求「同主题必须**逐字复用**既有 slug，只有确认是新主题才新造」。
2. **事后精确匹配**：模型返回的 topic 过 `normalizeTopic()` 后与 active topic 集合**精确**比对，命中 → 复用既有 topic（大小写 / 空白 / 连字符差异在归一化中消解）；未命中 → 新 topic。
3. **近似告警，不自动合并**：新旧 topic 归一化后互为前缀、或去掉分隔符后相同 → **不合并**，记一条 `event: api · possible-duplicate-topic` 日志并在汇总行提示，由 `omem review` 人工裁决。

不做模糊自动合并的理由：把两个主题错并成一个的代价（互相矛盾的结论挤进同一份文档，且 supersede 链再也拆不开）远大于多出一份待 review 的文档。

---

## 8. 验收

**第一步：**（编号沿历史保留，V15–V19 归第二步表，新增号顺延为 V33/V34）

| # | 用例 | 通过标准 |
|---|---|---|
| V1 | 本机免 key | stub server 在 127.0.0.1 上，`OMEM_API_BASE` 指向它、不设 key → 正常调用，且请求头**不含** `Authorization` |
| V2 | 非本机无 key | base 设为 `https://example.com/v1` 且无 key → 退出码 1，提示必须配 key |
| V3 | 非本机明文 | `http://` 非回环 → 拒绝并提示改用 https |
| V4 | 模型探测 | 未给 model 时先 `GET /v1/models`，用返回的第一个 id；多模型时打印全部 id；探测失败 → 退出码 1 并要求 `--model` |
| V5 | dry-run | `--dry-run` 全程零网络调用（stub server 记录到 0 次请求），且不写任何 `api_state` |
| V6 | **脱敏** | 会话含 `sk-abcdef...` 与 PEM 私钥 → 发出的 body（即存储正文）里已被替换，原文不在请求里 |
| V7 | 失败不中断 | 第 2 个会话返回 500 → 该会话跳过，其余照常，报告含 `failed 1` |
| V8 | 配置优先级 | config 有值 + env 有值 → env 生效；都无 → 用默认本机端点 |
| V9 | limit 钳制 | 默认（无 config）非本机本批 = 20；config/env `limit=200` → 钳到 50 并警告；CLI `--limit 200` 显式放行；本机端点不受硬上限 |
| V10 | 进度 | TTY 下逐条覆盖输出；非 TTY 每 10 条一行；结尾汇总分列 `written/deduped/failed/parse_failed/quarantined/elapsed/pending` |
| V11 | token 粗估 | 首批调用前打印 `batch: N sessions · ~Xk tokens (rough estimate)`；不接价格、不发请求 |
| V12 | sync key 护栏 | `[api].key` 非空时 `omem sync`（含默认 pull→push 路径）在任何 git 提交**之前**打印警告，退出码仍为 0、文件未被改动；smoke 有断言 |
| V13 | 宽松解析 | ① 纯 JSON → 过；② 带 ```json 围栏 → 过；③ 首尾多句子但括号平衡 → 过；④ 只有两句自然语言 → `parse_failed` 且 raw 进日志、`parse_failed +1`；⑤ 字符串值内含 `]` / `{` → 字符串感知计数不截断嵌套结构 |
| V14 | 解析失败的边界 | 拼接的两个 JSON 只取第一个；缺逗号的坏 JSON 不被"修复"；失败文本不进 `knowledge/` 与 `MEMORY-INDEX.md` |
| V20 | 存量库可加工 | 已跑过默认档的存量库（sessions 全部入库）→ `--tier api` 仍能取到待加工队列并处理；处理后队列深度相应减少 |
| V21 | 溢出不丢活 | 本批只加工前 N 条，其余照常入库；下次运行自动接续（其 `api_state` 未写） |
| V22 | 解析隔离 | 同一会话连续 2 次 parse_failed → `api_state=skip`，第三次运行不再重试；`--session <id>` 显式点名可越过 |
| V23 | rebuild 保状态 | `omem rebuild` 后队列深度、隔离状态不变（状态从文件 frontmatter 重导） |
| V24 | 传输失败重试 | http 500 的会话不写状态 → 下次运行重新进队列 |
| V25 | 中止退出码 | 连续 3 次传输级失败 → 中止、退出码 2、已产出保留；零星失败跑完 → 退出码 0，汇总含 failed / quarantined |
| V26 | 回环带 key | base 回环 + 显式 key → 请求头含 `Authorization`（llama-server `--api-key` 场景）；`omem api status` 如实显示"key 会发送" |
| V27 | 内容变更重排 | 已 `ok` 的会话内容增长（hash 变化）→ 重新进队列 |
| V33 | config 往返保 key | `[api].key` 非空时经 `omem pause` + `omem resume`（会走 `saveConfig`）后值仍在、未被静默清掉 |
| V34 | catch-up 导回 api_state | 只改 session frontmatter 的 `api_state`、正文哈希不变 → 重新打开索引后 sessions 表镜像跟上，队列不再把已完成会话送加工 |

**第二步（§7）追加验收**

| # | 用例 | 通过标准 |
|---|---|---|
| V15 | 证据归一化 | evidence 带多余空格/换行/中英标点差异时仍判定命中（复用 `normalizeForHash`）；落盘保留原文 |
| V16 | 证据锚定 | 命中 → 0.55；两条会话互相印证 → 0.75；不命中 → 0.35 + `ungrounded`（仍落盘） |
| V17 | 置信度上限 | API 档产物 `confidence ≤ 0.75` 且 `verified: false`，无论模型自评多高 |
| V18 | 自动 supersede | 同一 topic 已有 active 文档时，第二次运行自动带 `supersedes`，不被 `commitEntry` 拒绝；旧版仍在磁盘、退出检索 |
| V19 | 抽检确认 | `omem review --confirm <id>` 能把该份提到 0.9 + verified |
| V28 | topic 复用 | prompt 含候选 topic 列表；模型返回同义 slug（大小写/空白差异）→ 归一到既有 topic，不新开文档 |
| V29 | 疑似分叉只报告 | 近似但不同的 topic（如互为前缀）→ 不自动合并，日志 `possible-duplicate-topic`，两份都落盘待 review |
| V30 | 增量合并 | 同项目第二次运行：既有活文档全文出现在请求 body 中；输出 supersede 旧版（V18 的前置细化） |
| V31 | 响应校验 | 数组 >5 份取前 5；重复 topic 取第一份；均记日志 |
| V32 | score 对齐 | 同一 evidence 经 save_memory 与 API 档两条路径打分一致（归一化匹配，`score.ts` 回归通过） |

---

## 9. 开放问题的处置（v0.4 全部已决）

1. **粗估系数**：保持 `chars / 1.5` 单一系数，输出永远带 "rough estimate"。纯中文会话实际更接近 1 字符/token（会更贵），这是"量级提示"定位下可接受的偏差；不为此引入分词判断。
2. **raw 日志截断**：2000 字符。定位"模型输出为什么解析不了"通常看头尾就够；真不够再调，不为低频场景预加配置。
3. **`parse_failed` 单列**：单列。汇总行独立 `parse_failed N`（与 `failed`、`quarantined` 并列），本地模型的主要失败模式值得一根自己的刻度。

---

## 修订记录

- **v0.3-draft（2026-10-20）**：D1–D10 条款定稿。
- **v0.4-draft（2026-10-20）**：架构评审后修订——新增 §3.5 工作队列（`api_state` 状态机、frontmatter 事实源、rebuild 存活、崩溃窗口幂等、解析失败隔离）；§3.2 回环判定收紧为字面量集合，明确"显式 key 照发"、`0.0.0.0`/hosts 别名 fail closed、局域网不支持；§3.3 模型探测改为每运行一次并打印多模型列表；§3.4 定义中止条件（仅传输级）、重试单位与退出码；§3.6 硬上限改为只认 CLI `--limit`、config/env 钳到 50；§3.9 进度示例改为第一步语义、汇总分列 parse_failed/quarantined；§3.10 解析改字符串感知括号计数；§3.11 增加 prompt 重排提示行；§4 补 PowerShell 示例与 `default_tier` 分发修正；§6.1 改为"发送存储正文"；§6.3 警告时机提前到任何 git 动作之前并补 smoke；§7.2 输出契约改数组（N:M）+ 注入既有活文档增量合并；新增 §7.4 topic 同一性三道防线；D8 修订（`score.ts` 同步归一化对齐）；§5 改动清单 330→约 500 行、工期半天→2–3 天；验收补 V20–V27（第一步）与 V28–V32（第二步）。
- **v0.5-draft（2026-10-21）**：对照实现的评审裁决落 6 条硬修正 + 2 条边界句——**P0-1** §3.5 补"重导要覆盖 api_state 单独变化"（`reindexSessionFiles` 快路径只比 `content_hash`，sync 拉回的 `ok`/`skip` 不进镜像），改动 #5 改为 `content_hash` 与 `api_state` 任一不等即重导，新增 V34（方案 b 不采纳）；**P0-2** 规则 5 改为按层处置（活文档 supersede 收敛 / 条目层只保严格幂等 / 近似重复 review 收尾，不加模糊去重）；**P0-3** 改动 #2 风险注释改对（`saveConfig` 整文件按类型重写，文本级段合并是 install 纪律、不适用），`[api]` 须进 `OmemConfig`，新增 V33；**P1-5** V13④ 计数改 `parse_failed +1`，规则 1 改"哈希未变保状态"（`writeSessionFile` 整文件重写且不认识该字段，`--session` 会抹 `ok`）、规则 7 对齐；**O2** 示例 config 注释掉 `timeout_ms`/`max_input_chars`（本机默认，写入即压过按端点分档）；**O3** 术语定死"溢出/截断"两义（§2 目标 6、§3.6、V21）；**O4** §3.10 级 3 转义改"反斜杠跳过下一字符（任意 `\X` 含 `\\`）"；边界句：§0 开工姿势（`--limit 5–20` 验证管道，存量等 prompt v2）、§7.2 无 `project_fp` 会话只新建不合并（不注入全局列表）；队列基数口径写死（全量约 952，已吸收不预置 `ok`；931 仅 PROCESS.md 口径）。
- **v0.6-draft（2026-10-21）**：实现复核三处收尾——汇总 `pending` 改为跑完后重算；`parse_failed` 将连续传输失败计数归零；API 运行结束（含中止前）重写 `PROCESS.md`，中止前同时刷新 `MEMORY-INDEX.md`。
