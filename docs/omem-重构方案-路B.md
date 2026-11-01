# omem 重构方案 B：保留差异化，简化到核心

> 状态：**决策基本完成**（2026-11-01）
> 已定：CLI 命令面、D1（B′：topic 即身份）、D2（取消 `verified`）、D3（去 SQLite，内存派生索引）、D4（原文进 git）、D5（本版不做纠错）、D7（轻量账本）、D8（gc 并入 review）、D9（不兼容，re-init）、M1（置信度简化）、M2（AI 直接更新）
> 待定：**无** —— 决策完成，进入实施（见 §8）
> 指导原则：**实用主义优先**。任何新增机制先回答「不做会怎样」；能复用现有字段的不新增字段。

---

## 0. 背景

OpenViking 原生具备 omem 最痛的两块能力：活文档维护（两层摘要）、会话后自动抽取/合并（不要求人逐条确认）。omem 的差异化不在这些能力上，而在：

| 维度 | omem | OpenViking |
| --- | --- | --- |
| 数据归属 | 纯文本 Markdown，自有 git 仓，离线可用 | 内部 `.ovgit` 托管；写入不自动 commit；向量索引不版本化 |
| 运行形态 | 单 Node 进程，Windows 随手跑，无服务、无账号 | Rust + Python + Node 服务 + 向量库 |
| 许可 | MIT（无 copyleft 约束） | AGPL-3.0 |
| scope | 个人级 | 团队 / 多租户 |

**结论**：omem 当前卡在「最糟的中间态」——有 OpenViking 的复杂度（双写、状态机、单体待办），却没有它的能力。方案 B 把它砍回真正属于 omem 的那一层。

### 红线（任何改动不得触碰）

- **search 能力必须保留**（关键词/子串检索，可降精度不可删）。
- **git 备份能力必须保留**（记忆与原文都进入 git 历史，可推送任意 remote）。
- **不自动删除**：`gc` 只标记，硬删只有 `omem redact`（Markdown + 索引双删）。
- **冲突只报告**：远端版另存 `.conflict.md`，本地版保留，绝不自动合并。

---

## 1. 决策记录

### 1.1 已定

| 编号 | 议题 | 结论 | 理由 |
| --- | --- | --- | --- |
| **D1** | 内容模型 | **B′：topic 即身份**（见 §2） | 删掉一整类 bug 的源头（双命名空间）；人可读的仓库，才配得上「纯 Markdown 在你自己的 git 仓」这个卖点 |
| **CLI-1** | 命令面 | **稳健档 13 条**（见 §7） | 只保留「用户按路径可达」的命令 |
| **D2** | `verified` 字段 | **取消** | 原地更新下「已验证」会退化成「这个主题曾被人看过」；与自动维护冲突 |
| **D3** | 去 SQLite | **A：内存派生索引**，key = topic；会话只索引 `## user` 证据域；**不建倒排索引** | 实测查询 1–2ms（见 §12），瓶颈在文件 IO 而非检索；顺带把今天「每条命令双读 22MB（710ms）」的启动成本降下来 |
| **D4** | 会话原文入 git | **必须进 git** | 换机场景下不同机器有不同原文，原文本身是要跨机携带的资产 |
| **D5** | 人工确认 / 纠错 | **本版不做纠错**；人工动作 = 过目（置信度提到 0.9）/ 归档 / 冷却。纠错列 V0.2（只纠活文档的总结） | 纠错需 claim 级数据与防复发机制，成本高于本版收益；而确认的产出物（`verified`）已随 D2 消失 |
| **D7** | 证据账本 | **轻量版**：账本 = 现有 `evidence` + `source_sessions`，不新增字段/文件 | 与 M1 的「不要复杂」一致 |
| **D8** | `gc` | **保留**，并入 `omem review --gc` | 承认 stale 机制，但不为它留顶层入口 |
| **D9** | 老数据仓 | **不兼容，`omem init --force` 重来** | 本版目标是变小；不写产品内迁移脚本 |
| **M1** | 置信度 | **单一数值 + 固定五档**（见 §4） | 数值只用于排序，解释靠 tags + evidence |
| **M2** | AI 维护活文档 | **AI 直接整篇更新**，护栏只有写前 snapshot | 活文档本来就是沉淀记忆用的，加 patch 协议是把简单事情做复杂 |

### 1.2 待定

无。全部技术决定已收敛，进入实施（见 §8 路线）。

---

## 2. D1-B′：topic 即身份（已定）

### 2.1 路径模型

```
knowledge/<domain>/<topic>.md      # 一份活文档 = 一个可读文件名
archive/<domain>/<topic>.md        # 归档 = 移动，不删除
sessions/<agent>/<session>.md      # 不动
```

- **不再有年份分桶**，不再有 `id`。
- frontmatter 不再有 `id` / `topic` / `supersedes` / `superseded_by`；`status` 只保留 `active | stale`（`archived` 由目录位置表达）。
- **一切记忆都是 topic 文档**：一次性记忆 = 只被写过一次的 topic（已确认：随手记也强制有 topic）。
- 版本 = git 历史。更新 = 重写同一路径。改名 = 移动文件。
- `topic` **全局唯一**（不按 project 分），与现状 `findActiveByTopic` 的口径一致；`project` 仍是 frontmatter 元数据，只用于分组。

### 2.2 主题命名与文件名（语言策略）

**不做自动转写、不做自动翻译。** 理由：

| 方案 | 问题 |
| --- | --- |
| 中文 → 拼音 | 音近主题冲突（`修复` / `修补` → 都可能 `xiu-`）；读起来比中文更差；多语种各要一套词表 |
| 按用户语言翻译（英/日/韩） | 需要模型或翻译 API → 违反「默认零模型调用」；且**显示名与文件名分家 = 双命名空间回来了** |
| ASCII slug + frontmatter 显示名 | 同上，还多一个字段 |

**采用「协议约定 + 机械校验」**：

1. **规范**：`topic` 用英文小写连字符（`knee-rehab`、`omem-d1-topic`），专有名词/技术名保留原文。这条写进 `src/context/instructions.ts`（MCP `initialize` 与 export 共用），由写入方（Agent 或用户）执行——**零代码成本**。
2. **不强制**：CJK topic 合法（`normalizeDomain` 已保留中日韩字符），只是会被引导生成 ASCII。个人级 + Windows 优先，CJK 文件名可用。
3. **必须做的机械校验**（`normalizeTopic` 现在缺，`src/core/commit.ts:496-499`）：
   - 路径安全：`/`、`\`、`..`、`:` 等一律折叠为 `-`（沿用 `normalizeDomain` 的字符集）
   - 大小写：强制小写（Windows 大小写不敏感，避免 `Foo`/`foo` 两个文件）
   - Windows 保留名（`con` `prn` `aux` `nul` `com1-9` `lpt1-9`）加前缀避开
   - 长度：≤ 64 code point，超出按 code point 截断（不硬截 UTF-16）
4. **改名入口保留一条命令**：`omem topics rename <old> <new>`（= 校验 + 移动 + 提示），因为改名现在等于移动文件，需要一个安全通道。这是我此前把 `topic rename` 删掉后的修正。
5. **不做**全角/半角、繁简转换——那是写作者的事。

### 2.3 随之消失的东西

| 消失 | 位置 |
| --- | --- |
| `newId` / `id` 字段 / 年份分桶 | `core/entry.ts`、`core/store.ts:22-28` |
| `findById` / `findByIdIndexed` / `pathById` | `core/store.ts:74-107`、`core/index.ts:230-233` |
| `applySupersedes` + superseded 状态 | `core/lifecycle.ts:12-26` |
| supersedes 解析 / 撞 topic 拒写 / `resolveTopic` | `core/commit.ts:336-373` |
| `omem topic`（233 行）→ `topics list` + `topics rename` | `commands/topic.ts` |
| `versionChain`（review 页面版本链） | `web/review-data.ts:159` |
| 近重复 topic 的「改用既有 + supersedes」提示 | `core/commit.ts:377-385` |

净删 **600–900 行**，且删掉的是一整类 bug（双命名空间错位、id 找回、superseded 视图维护）。

### 2.4 合同变更（MCP + CLI）

| 变更 | 影响 |
| --- | --- |
| `save_memory` 删除 `supersedes` / `confirm_ids`，`topic` 变**必填** | MCP 合同破坏性变更 → 版本走 **0.2.0**，`initialize.instructions` 同步 |
| `search_memory` 结果以 `topic` 为句柄（不再有 `id`） | 回执文案、`PROCESS.md` 全部改口径 |
| `omem add` 必须 `--topic` | 缺失时报可执行用法错误（exit 1），不静默生成 |
| `omem redact --id` → `omem redact --topic` | 唯一硬删路径的入口改名 |
| `omem review <topic>` | 页面/CLI 用 topic 定位 |

### 2.5 真实库的搬迁（不在发布包内）

D9 定为不兼容，但现有的真实库（约 26 个活文档 / 1101 份会话）仍需要一次搬迁。**放 `scripts/` 下的一次性脚本**，不进 `dist/`、不进 README：读旧 frontmatter 的 `topic` → 复制到新路径（<domain>/<topic>.md）→ 输出未命中的条目清单人工处理。旧目录原样保留，不删。

---

## 3. 锚定检出流程（供 review 使用）

暂不改变：`omem review` 用 topic 打开正文、看 evidence 与来源会话，人做三件事——**过目**（置信度 0.9）、**归档**、**冷却**。

---

## 4. 置信度口径（M1 + D7）

| 档位 | 值 | 条件 |
| --- | --- | --- |
| 未锚定 | 0.35 | evidence 在引用会话里找不到原文 |
| 待补会话 | 0.55 | 无 evidence 无 session_id |
| 已锚定 | 0.55 起 | evidence 命中 `## user` 原文 |
| 印证加成 | +0.10 / +0.06 / +0.03…，封顶 +0.25 | 独立会话数 + 跨项目加成（沿用 `src/process/score.ts:107-131`） |
| 自动上限 | 0.80 | 任何自动产出不得超过 |
| 人工过目 | 0.90 | 人在 review 里看过正文之后 |

- **账本** = `evidence` + `source_sessions`（上限 200），不新增字段。
- **可复算**：`omem verify` 用账本重算并与落盘值比对，**只报告差异，不自动改写**（避免抖动 git 历史）。
- 删 `confirmations`（唯一消费者是随策略一起删除的 `topicReviewedBefore`）；保留 `last_confirmed`，语义改为「最近一次人工过目时间」。

---

## 5. 取消 `verified` 的落地范围（D2）

| 位置 | 改动 |
| --- | --- |
| `src/core/entry.ts` | 移除 `verified` 与 `FM_ORDER` 位置；解析时容忍存量字段 |
| `src/core/commit.ts` | 移除 `verified`、`supersededVerified` 回执段 |
| `src/core/search.ts:109-111`、`125-127` | 删两处 `ORDER BY e.verified DESC`（排序落 confidence → last_confirmed） |
| `src/core/lifecycle.ts` | `formatStaleness` 去 verified 分支；`reconfirm` 保留「提到 0.9」但不置 verified |
| `src/process/score.ts`、`pipeline.ts` | 移除 `verified: false` 常量与相关注释 |
| `src/mcp/tools.ts` | 删 `confirm_ids` 入参与回执 |
| `src/context/instructions.ts` | 删 `RULE_VERIFIED`；新增「topic 用英文小写连字符」约定 |
| `src/web/review-*` | 「确认」→「过目」文案，去 verified 徽标 |
| `src/commands/add.ts` | 删 `verified: true`；语义 = `source: manual` + `confidence: 0.9` |
| `AGENTS.md` | 三处涉及 verified 的非协商项重写 |
| 测试 | `score-ladder`、`commit`、`review-decisions`、`save-feedback`、`mcp-tools` |

**定位影响**：差异化从「人确认过的 verified」转为「**可锚定的证据 + 可复算的置信度**」。`README`、`package.json` description、`AGENTS.md` 信任模型段落需同步重述。

---

## 6. AI 维护活文档（M2）

触发点只有两处，都不新增机制：

| 执行者 | 链路 | 更新方式 |
| --- | --- | --- |
| `omem sync --tier api` | `runPipelineAsync` → `extractWithApi` → `commitDoc` → `commitEntry` | 模型产出整篇，直接覆盖该 topic |
| 本地 AI Agent | 读 `PROCESS.md` → `save_memory(topic=…, content=…)` → `commitEntry` | 同上 |

D1-B′ 之后，**带 topic 再写一次就是覆盖**，不再有「撞 topic 拒写 + 要求 supersedes」这道闸门。护栏只有一条：写前 `runSnapshot`（`src/core/snapshot.ts` 已存在）。丢事实的风险由 git 历史 + 人工过目兜底。

---

## 7. CLI 命令面（13 条）

| 保留 | 命令 | 说明 |
| --- | --- | --- |
| ✔ | `init` `install` `serve` | 安装与启动链路 |
| ✔ | `sync` | 吸收 `api status` |
| ✔ | `search` `add` | 红线能力；`add` 必须带 topic |
| ✔ | `review` | 过目 / 归档 / 冷却 / `--gc` / `--ui` |
| ✔ | `backup` | 吸收 `snapshot` |
| ✔ | `redact` | 唯一硬删，`--topic` |
| ✔ | `profile` | work 档数据边界 |
| ✔ | `skip` | 待办收敛的唯一手段 |
| ✔ | `topics` | `list`（词表）+ `rename`（安全改名的唯一通道） |
| ✔ | `verify` | 原 `rebuild`；一致性校验 + 置信度复算比对 |

**删除**：`eval`（79 行 + `process/eval.ts` 215 行）、`api`（46 行）、`audit`（16 行）、`snapshot`（12 行，折叠进 `backup`）、`topic policy` + `review.toml` + `review-policy.ts`（99 行）、`topic set`（id 时代遗留）。

**连带同步**：`src/cli.ts:35-131`、`README.md:126-148`、`AGENTS.md` Modules 表、`tests/smoke.sh`（8 处）、`tests/unit/docs-consistency.test.ts`、`tests/remote-package-test.md`（29 处）。

---

## 8. 路线

| 步 | 内容 | 依赖 | 收益 |
| --- | --- | --- | --- |
| **A** | 身份收口：D1-B′ 路径模型 + topic 必填 + 删 supersede/id + 写前快照 | D1、D2、M1 | 删 600–900 行与一整类 bug；M2 自动成立 |
| **B** | 去索引：D3 内存派生索引（key = topic）+ 只索引 `## user` + 分层对账 + golden 搜索测试 | A | 删 WAL/锁/迁移/双 hash 对账；启动 IO 从 710ms 降到 382ms（见 §12） |
| **C** | 面收尾：CLI 13 条、删 `review.toml`、`rebuild`→`verify`、文档与测试同步 | A | 对外表述与实现一致 |
| **D** | 初始化收口：`init --force` 前置自动 snapshot；`scripts/` 一次性搬迁脚本 | A | 不兼容前提下的最小着陆路径 |

---

## 9. 风险

| 风险 | 处置 |
| --- | --- |
| A × M2：整篇覆盖丢事实 | **已接受**。兜底：写前 snapshot + 每次写入自动提交 + 人工过目；纠错留 V0.2 |
| 中文 / 非 ASCII 文件名跨 OS（macOS NFD） | Windows 优先、个人级，可接受；文档写明；改名走 `topics rename`。不做自动转写（见 §2.2） |
| topic 命名质量成为唯一身份约束 | 保留 `PROCESS.md` 的 Existing topics 词表 + `isNearDupTopic` 写入提示；`instructions.ts` 增加英文 slug 约定 |
| 改名 = 移动文件 | `topics rename` 统一处理；omem 内部不再引用 id，断链面很小 |
| D4：22MB 原文随 backup 上远端 | **已接受**（换机必须携带）。保留 work profile 禁 sync/export；README 安全段必须明说 |
| D9：存量用户重来 | `init --force` 前置自动 snapshot；README 标 breaking（0.2.0） |
| B：丢 bm25 | 排序改确定性规则 + golden 查询集断言（见 §12） |
| B：跨进程一致性从「锁」变「对账」 | 活文档每次 stat（~2–10ms），会话按需构建；问题从「写冲突」降级为「读延迟」 |
| B：冷启动耗时 | 实测读 1100 文件 382ms（今天双读 710ms）；只索引 `## user`，检索 1.4ms（见 §12） |

---

## 10. 不做清单（锁定）

- 纠错机制（V0.2）、`corrections.toml`。
- topic 自动转写/翻译（拼音、按语言生成英文名）。
- 每个目录一对 `.abstract.md` / `.overview.md`：L0 已由 `search_memory` 输出的 `summary` 承担（`src/mcp/tools.ts:607`），L1 就是正文本身（≤2000 字）；目录层级只有 `coding`/`general` 两档，不携带信息。
- 语义 / 向量检索。
- WebDAV / 本地目录同步后端。
- 多租户 ACL、Skills 管理、云服务 / 账号体系。
- 把 `sessions/` 全文塞进内存索引。
- 产品内迁移脚本（D9 已定不兼容）。

---

## 11. 验收（全部可自动断言）

| 项 | 断言 |
| --- | --- |
| 身份（A） | 同 topic 连写 3 次：磁盘 1 个文件、`git log` 3 笔、检索不返回历史版本；`rg "\bid\b" src/core/entry.ts` 无 id 字段 |
| 路径安全（A） | topic 含 `/`、`\`、`..`、`CON` 时落盘仍在该 domain 目录内 |
| M2 | 带 topic 二次写入成功；写前存在 snapshot |
| `verified`（A） | `rg "\bverified\b" src/` 仅剩注释；排序仍有确定结果 |
| 置信度（M1） | 0.35/0.55/+加成/0.80/0.90 五档各有单测；`omem verify` 报告差异不改文件 |
| 搜索等价（B） | golden 查询集全等；零结果文案不变 |
| 检索性能（B） | 1100 会话规模下单查询 < 10ms（不含冷启动）；冷启动 < 500ms（见 §12） |
| 一致性（B） | 3 进程并发写零失败；外部改 md 后下次调用可见 |
| 命令面（C） | `README` / `AGENTS.md` / `cli.ts` / `smoke.sh` 四处命令清单一致 |
| 初始化（D） | `init --force` 先 snapshot 再重建；旧目录内容不被删除 |

---

## 12. 检索实现与实测成本（D3 落地依据）

实测环境：本机 Windows / Node 22；语料为合成的 1100 份会话（合计 21.5MB，`## user` 段约占 10% = 2.1MB）。取**最坏情况**（查询词不存在，强制全量扫描）。

| 操作 | 实测 | 意义 |
| --- | --- | --- |
| 21.5MB 会话全文全量扫描 | **12.7 ms** | 若把会话全文放进内存 |
| 2.1MB `## user` 域全量扫描 | **1.4 ms** | **推荐口径** |
| 500 份活文档（×2000 字）逐条 AND | **1.1 ms** | entries 检索 |
| 1100 会话 user 域逐条 AND | **1.3 ms** | sessions 检索 |
| `statSync` × 1100 文件 | 131 ms | 启动对账的主要成本 |
| `readFileSync` × 1100 文件（21.5MB） | 382 ms | 冷启动 |
| **今天的 `catchUp`（每个会话读两次）** | **710 ms** | 现状：每条 CLI 命令都付一次 |

**结论与实现口径**：

1. **查询不是瓶颈，不要建倒排索引**。活文档 ≤ 几千份 × 2000 字、会话只索引 `## user`，暴力子串匹配在 1–2ms 量级；FTS5 的 bm25 在这个规模换不到可感知收益。**不手写搜索引擎**是这一步最大的简化。
2. **瓶颈是打开时的文件 IO**。今天的 `catchUp` 把每个会话读了两遍（`readFileSync` + `readStoredSession`，`src/core/index.ts:408-435`），每条命令约 710ms；内存方案只读一遍约 382ms，且能按需延后。
3. **分层对账**（替代 SQLite 的跨进程锁与 `busy_timeout`）：
   - 活文档（几十~几百个）：每次调用 `stat` 全部 → 外部编辑（Obsidian）立即可见，成本 2–10ms；
   - 会话（1000+）：只在 `sync`、`search --sessions`、`verify` 时构建，其它命令不读。
4. **排序改确定性规则**：命中词数 → `confidence` → `last_confirmed`。用 golden 查询集（查询 → 期望 topic 集合）钉住行为。
5. **规模上界**：按实测线性外推，会话 1 万份（user 域 ~20MB）约 13ms/query，10 万份约 130ms。到 1 万份再考虑加倒排——现在加就是过度设计。

---

## 13. 事实核查备注（上一版文档的错误，已修正）

| 上一版说法 | 实际 |
| --- | --- |
| `auto_commit` 默认关，MCP 路径「需核实补齐」 | 默认已是 `session`（`src/core/config.ts:73-79`），MCP `save_memory` 已在写后调用 `autoCommit`（`src/mcp/tools.ts:852-861`） |
| 「`search.ts` 仅依赖接口，基本不动」 | `search.ts` 直接写 SQL：`bm25()` JOIN、`LIKE` 兜底（`src/core/search.ts:76-208`），去 SQLite 必须整体重写 |
| 复用 `deriveTitle`/`deriveSummary` 生成 L1 摘要 | `deriveSummary` 是前两句机械截断（`src/core/entry.ts:256-259`），结构化摘要必须调模型 |
| 零运行时依赖（仅 `node:sqlite`） | 另有 2 个运行时依赖，其中 `@toondepauw/node-zstd` 是原生模块 |
| `pendingTopics` 命名空间 bug 靠「topic 进路径」自然消失 | 现在**确实会消失**（D1-B′ 把 project/topic 混用改成单一身份），但修法在渲染层与身份模型，不在存储层 |
| `normalizeTopic` 可直接当文件名 | 不行：它不处理 `/`、`..`、Windows 保留名、长度上限。**已修**：迁至 `src/core/entry.ts`，与 `normalizeDomain` 共用字符政策（`tests/unit/topic-normalize.test.ts` 钉住） |

---

## 14. 实施进度（滚动更新）

| 步 | 任务 | 状态 |
| --- | --- | --- |
| A-1 | topic 归一化成为路径安全规则（字符政策、CJK、保留名、64 code point 上限） | ✅ |
| A-2 | 路径模型 `knowledge/<domain>/<topic>.md` + 目录扫描变浅 | ✅ 代码完成 |
| A-3 | 删除 `id` 与 supersede 状态机，写入即覆盖 | ✅ 代码完成（写前快照仍待补） |
| A-3t | 测试迁移：断言从 id 改为 topic，删除 supersede 相关用例，`omem add` 补 `--topic` | 进行中（49/69 文件绿；guide 组完成，剩余 mcp / api / sync / 其他） |
| A-4 | 取消 `verified` + 置信度五档固化 | 待做 |
| A-5 | MCP/CLI 合同同步（topic 必填、删 `supersedes`/`confirm_ids`、`redact --topic`） | 待做 |
| A-6 | `PROCESS.md` 拆 Project / Topic 两段 | 待做 |
| B | 去 SQLite：内存派生索引 + 分层对账 + golden 搜索断言 | 待做 |
| C | CLI 13 条收敛与文档/测试全面对齐 | 待做 |
| D | `init --force` 前置快照 + `scripts/` 一次性搬迁脚本 | 待做 |

**每个 A-x 的收尾动作**：`npx vitest run` 全绿 → `npm run build` 通过 → 更新本节状态 → 单独提交。
