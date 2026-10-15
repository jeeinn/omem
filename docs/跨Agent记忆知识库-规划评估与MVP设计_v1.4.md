# 《跨 Agent 个人记忆与知识库》规划评估与 MVP 设计

> 版本：v1.4 · 日期：2026-10-15 · 评估对象：《跨 Agent 个人记忆与知识库产品规划》v0.4 + 《参考项目组件复用与许可证风险清单》v1.0
>
> 变更记录：**v1.4** 新增 0.2 第 7 条发现——MCP sampling 在 Claude Code 上不可用（Issue #1785 未关闭），"借宿主 LLM 免 key"路径在 V0.1 不成立；据此**重写 4.4 决策 3（加工模型）**为四档方案，默认零配置规则抽取。配套规格文档同步至 v0.2-draft。另新增对 codegraph 的体验基准引用（零 key/零配置/自动接线 9 类 agent/最小工具面/三层新鲜度保证），其做法已回灌规格 §4.4、§6.4、§8。**v1.3** 新增 4.9——同步抽象为 `SyncBackend` trait（V0.1 交付 GitBackend，WebDAV / 本地目录放 V0.2，WebDAV 优先因为它是非开发者唯一现实的同步路径）；明确非开发者用户群决断：V0.1 排除、V0.2 低价试探（接入脚本 + WebDAV 引导，不做 GUI）、V0.3 按数据决定是否立项桌面壳；现在就付两笔接口税（SyncBackend 抽象 + `omem setup --client`）。修订 4.2 同步边界与 4.4 决策 8。**v1.2** 新增 1.5（竞品全景补全，源自 agentmemory 官方中文横向对比 + 与目标相近度分档 + 体验执行清单）与 1.6（理想产品五要件 × Heirloom 逐条对齐）；据此修订 4.2 同步边界（V0.1 即做 git 封装）、4.4 决策 5（分发改为 npm 入口 + 平台预编译二进制）与决策 8（同步改为 git 基层）；4.8 增补"借鉴清单（接口级，不继承代码）"；0.2 增第 6 条发现。v1.1 更正 Supermemory 开源边界——其本地二进制的**引擎源码并非公开**（v1.0"开源单二进制"表述有误，详见 1.4.1）；修正 Heirloom 仓库地址（`xenoaitham/heirloom`，作者账号已改名，详见 1.4.2）；补充 Supermemory 定价体系与 Heirloom 实现细节。v1.0 初版。
>
> 评估方法：文档审读 + 外部竞品事实核查（2026-10-15 联网检索 agentmemory / memofs / hstry / Basic Memory / Supermemory / Heirloom / Glia / Kept / MemoryPlugin / Claude Code 官方文档）
>
> 严重度标注：**P0** = 影响项目成败，须在 MVP 启动前解决；**P1** = 显著影响质量或效率，应在对应阶段解决；**P2** = 改进项

---

## 0. 结论摘要

### 0.1 总体判定

**方向有价值，但现规划处于"价值假设未验证、差异化空间被高估、功能范围过大"三重状态，不建议按现有 Phase 0–4 路线图直接开工。建议以"验证先行"的极窄 MVP 重启，用 12 周和三个实验决定去留。**

三条判据：

1. **需求侧证据充分**：2026 年 10 月的市场扫描显示，"跨 Agent / 跨设备个人记忆"赛道已挤入 agentmemory（11.5k★+）、Supermemory（28K★+，含本地单二进制）、Basic Memory（3k★、57K 下载/月）、memofs、Heirloom、Glia、Kept、MemoryPlugin、hstry、lore 等至少 10 个直接相关项目，且 Claude Code 从 v2.1.59（2026-02）起默认开启 auto memory。大量开发者涌入证明痛点真实存在——**问题是真的**。
2. **差异化侧证据不足**：规划主张的四个差异化要素（全领域、Markdown 事实源、跨设备同步、技能沉淀）中，**三个已有占位者**：Markdown 事实源 = Basic Memory；跨设备 = Supermemory / Heirloom / Kept / Basic Memory Cloud；网页采集 = Glia / Kept / hstry / Supermemory Nova。"无人打通全链路"的判断已被市场推翻（见第 1 节核查表）。
3. **价值假设未被自己验证**：整个产品的立论基础——"LLM 蒸馏的记忆能让第二个 Agent 的回答显著变好"——规划中没有设计任何验证实验，只有"自己连续用 30 天"这类有开发者偏误的自用指标。LoCoMo 等基准的历史结论是：多数记忆系统打不过简单基线。**不先测基线就全量自研，是本案最大的风险。**

### 0.2 五个关键发现

| # | 发现 | 影响 |
|---|---|---|
| 1 | 规划遗漏 5 个直接竞品：Supermemory、Heirloom、Glia、Kept、MemoryPlugin；其中 Supermemory 提供本地单二进制（引擎闭源）+ 开源 MemoryBench 评测框架 | 第 2 章竞争分析需重写；差异化叙事需收窄 |
| 2 | "国内 Agent 适配薄弱"被部分推翻：agentmemory 已有 DeepSeek Harness / Qwen Code 适配器，Kept 扩展已覆盖 Kimi | 第 7.2 章生态切入点论据减弱 |
| 3 | Claude Code auto memory 默认开启但**机器本地 + 项目级**——恰好验证"跨机器/跨工具/跨项目的个人记忆"是空白，同时侵蚀"自动采集"的单工具必要性 | 产品定位获得支撑，但 MVP 必须与之做基线对照 |
| 4 | SQLite FTS5 默认分词对中文检索是硬伤（全文未识别），且部分 Python 发行版未编译 FTS5 | 第 6 章选型缺关键技术验证点（P0） |
| 5 | 记忆投毒/提示注入、公司设备合规（商业代码同步出内网）、平台方收编三类风险完全缺失 | 第 8 章风险表需补（P0） |
| 6（v1.2 新增） | Heirloom 与理想产品**外壳高度重合、存储内核相反**——8 采集器 + MCP + 单二进制已有一个 MIT 实现；它的两个缺口（无 md 事实源、无自动同步）恰是本项目的差异化要件 | 不必从零写，也不必 fork：**借鉴接口不继承代码**；且"md 事实源 → 云端备份/跨机器是免费副产品"应升为第一卖点 |
| 7（v1.4 新增） | **MCP sampling 在 Claude Code 上不可用**——Issue #1785 自 2025-06 开启、2026-08 仍未关闭（58 评论）；opencode 2026-04 已支持，VS Code 部分支持 | "借宿主 Agent 的 LLM 做加工、从而零 API key"这条理想路径**在 V0.1 走不通**（V0.1 只采集 Claude Code）。改为四档加工：规则抽取（默认零配置）→ Agent 主动保存 → Agent 协作加工 → 自带 key（可选）→ sampling（未来）。详见规格 §9 |

### 0.3 核心建议（三句话）

1. **差异化押注从"四件套"收窄为一个楔子：git 原生 + Markdown 事实源的个人级记忆（可 diff、可回滚、Obsidian 即开即用），叠加技能蒸馏；其余要素明确"不做"或"社区做"。**
2. **MVP 只验证一件事：单工具（Claude Code）会话 → LLM 蒸馏 → 跨 Agent 检索，能否稳定打赢三个 dumb baseline（Claude Code auto memory、手工 MEMORY.md、hstry 式全文检索）。**
3. **12 周时间盒 + 三道 go/no-go 闸门；任何质量指标不过且两轮调优无改善，即收缩为个人脚本，停止产品化投入。**

---

## 1. 市场竞品事实核查（2026-10-15 实测）

### 1.1 核查结果总表

| 项目 | 2026-10 实况 | 与本产品重叠度 | 对规划判断的修正 |
|---|---|---|---|
| **Supermemory** | 28K★+；商业托管平台明码收费（Free $0 含 1M tokens/月 / Pro $19 / Max $100 / Scale $399 每月，超额 $0.01/1K tokens、$0.10/1K 搜索）；记忆 API + Nova 应用 + Chrome 扩展 + 连接器 + MCP server；**本地单二进制可免费下载自用，但引擎源码非公开（不可审计、不可 fork）**，可全离线接 Ollama；自报 LongMemEval 81.6% / LoCoMo / ConvoMem 第一；开源 MemoryBench 横评框架 | ★★★★★（规划完全遗漏） | **最大竞品**。本地二进制直接命中"零部署 + 本地优先 + 跨 Agent"三原则，且免费额度对个人用户够用（不能打价格战）。空隙：引擎闭源、存储非 Markdown 事实源、无 git 工作流、无 Obsidian、国内工具弱——**"全链路开源可审计"是其结构性软肋** |
| **Heirloom** | 仓库实为 `github.com/xenoaitham/heirloom`（原 MayonaiseLover 账号已改名，目录站信息滞后导致难检索到）；Rust workspace 18 crates，v1.0.4（2026-05），MIT；加密 SQLite（XChaCha20-Poly1305/Argon2id）+ FTS5 BM25 + hash n-gram TF-IDF **零模型混合检索**；8 个采集器（fs/browser/firefox/claude/chatgpt/claude-code/slack/obsidian，插件约 50 行）；`.hlm` 加密快照多设备同步；自托管 team server；**无 LLM 蒸馏层** | ★★★★★（规划完全遗漏） | "local-first + MCP-native personal memory + 单二进制 + 多设备"与本产品定位几乎同句，但停留在原始摄取+检索（无蒸馏），且单人项目、社区 traction 趋近于零——竞品威胁低、方向信号有效。其 README 自曝"ingester 仅合成 fixture 测试、真实导出需用户自行验证"——与 lore 同款 failure mode，再次印证规划 7.2"真实样本回归测试"的必要性 |
| **Glia** | Chrome 扩展自动保存 7 平台网页对话（Claude/ChatGPT/Gemini/DeepSeek/Grok/Copilot/Mistral）+ 原生 MCP server + 共享 SQLite（sqlite-vec + nomic-embed-text via Ollama）+ 本地 LLM 抽三元组 + 句子级裁剪注入；MIT | ★★★★（规划完全遗漏） | "浏览器扩展 + MCP + 本地向量"通道已被完整实现，且覆盖 DeepSeek。采集层③的稀缺性不成立 |
| **Kept** | Tauri 桌面应用 + Chrome 扩展；**Markdown vault 为事实源** + FTS5 可重建索引 + CozoDB 知识图谱；已逆向 ChatGPT/Claude/Gemini/Grok/**Kimi** 的 API 抓取流程并公开文档 | ★★★★（规划完全遗漏） | "Markdown vault + 网页采集"组合已被占领，且其平台 API 逆向文档可直接参考（省去自行摸索 DOM）；商业化路线（桌面应用） |
| **MemoryPlugin** | agent skills 分发（`/plugin marketplace add memoryplugin/agent-skills`）+ Sync 桌面端同步 Claude Code/Codex/Cursor 会话为可检索历史 | ★★★（规划完全遗漏） | "技能分发 + 跨工具同步"的轻量实现；证明 skill 路线可行，也证明该路线门槛不高 |
| **Basic Memory** | 3k★、57K 下载/月；**Markdown 为事实源 + 全文/语义/知识图谱三层索引 + MCP-native + 本地 embedding 免 API key**；Cloud $15/seat/月；AGPL-3.0；Python/FastAPI/SQLite | ★★★★（规划列为"最佳参考"，实为正面竞品） | "Markdown 事实源 + MCP + 知识库"已被其做到规模化。**规划对其竞品属性评估不足**。空隙：无自动会话采集（write-note 模式）、同步付费、无技能蒸馏、AGPL 无法吸收代码 |
| **agentmemory** | 11.5k★+，v0.9.27；53 个 MCP 工具；12/6/22 个生命周期钩子（Claude Code/Codex/OpenCode）；四层记忆（working/episodic/semantic/procedural）；BM25+向量+图 RRF；**19–32 个适配器，含 DeepSeek Harness、Qwen Code、Hermes、OpenClaw、Kiro、Zed、Warp**；MEMORY.md 与 Claude Code 双向同步；viewer + session replay；密钥自动剥离 | ★★★★（规划已识别） | 规划描述基本准确，但**适配器数量与国内工具覆盖被低估**（"20 适配器、仅编程场景"偏乐观）；其 MEMORY.md 互同步意味着它已从底部接入 Claude Code 原生记忆 |
| **memofs** | 与规划描述相符：file-first `.memofs/`（core.md/notes.md/events/graph/archive/snapshots）、9+ Agent hook 注入且 **compaction 后存活**、BM25+ONNX 本地 embedding（0.6ms p50）、记忆 Linter、lineage、源码锚定漂移检测、认知衰减；open-core（MemoFS Cloud 付费）；Product Hunt 首发仅 2 赞（社区 traction 低） | ★★★★（规划已识别为"理念最接近"） | 准确。但注意其为**项目级**（`.memofs/` 在项目仓库内）而非个人级——这是本产品少数站得住的区分 |
| **hstry** | 与描述相符；适配器 detect+parse；MV3 扩展覆盖 ChatGPT/Claude/Gemini/Perplexity；SSH 远程同步；`resume` 跨 Agent 恢复；**已内置 `~/.workbuddy/projects` 适配器**（本环境会话可直接归档） | ★★★（规划已识别） | 准确。定位差异清晰：**原始历史归档检索** vs 本产品的**蒸馏知识库**——hstry 是"grep 你所有聊天"，本产品是"提炼你所有聊天" |
| **lore / memoir** | 与配套清单描述相符 | ★★ | 准确，维持"源码吸收/机制参考"定位 |
| **Claude Code auto memory** | v2.1.59（2026-02）起默认开启；`~/.claude/projects/<repo>/memory/`（MEMORY.md 索引 ≤200 行/25KB + topic files）；`/memory` 管理；子 Agent 可持记忆；worktree 间共享；**不跨机器、不跨工具、不跨项目** | ★★（平台内建，非竞品） | **双刃**：验证了"机器本地+项目级"正是空白（定位获得支撑）；同时说明单工具用户的"自动采集"需求已被官方部分满足——MVP 的增量必须体现在跨机器/跨工具/跨项目 |
| mem0 / OpenMemory / Zep / Letta / LangMem / cognee | 框架层/API 层生态位，非直接竞品 | ★ | 与规划判断一致，无需修订 |

### 1.2 对规划竞争判断的修正

1. **"全领域 + Markdown + 跨设备 + 技能无人打通"不成立**：四个要素分别被 Basic Memory（Markdown）、Supermemory/Heirloom/Kept（跨设备+采集）、MemoryPlugin/agentmemory skills（技能分发）占位。正确的表述是：**"四要素的组合 + git 原生工作流 + 个人级（非项目级）scope"无人占位**。
2. **"国内适配是生态切入点"论据减弱**：agentmemory 已有 DeepSeek Harness/Qwen Code；Glia 已覆盖 DeepSeek 网页端；Kept 已覆盖 Kimi。国内适配从"空白"降级为"浅适配"——仍是机会，但不能作为立项主论据。
3. **竞品自报指标（LongMemEval 95.2% 等）继续保持怀疑**：Supermemory、agentmemory 的数字均来自各自跑分，非同基准。**正确应对是使用 Supermemory 开源的 MemoryBench 做同基准横评**（第 3 章 Q1 实验的直接工具，避免自建 eval 轮子）。

### 1.3 剩余空白（真正的差异化楔子）

按"竞品占比 × 用户可感知价值"排序，2026-10 仍空白的只有三处：

| 空白 | 为什么没人做 | 可守性 |
|---|---|---|
| **git 原生个人记忆**：Markdown 事实源 + git 为同步/备份基层（diff、blame、rollback、CI 可跑 Linter） | 现有玩家要么 SQLite 封闭（agentmemory/Heirloom）、要么云同步付费（Basic Memory/Supermemory）、要么项目级（memofs）——**没人把"个人记忆当代码仓库管"** | 中：机制不复杂，但与 Obsidian 用户心智、开发者习惯天然咬合，且竞品受商业模式牵制（云同步是收入）难以跟进 |
| **技能蒸馏（SKILL.md）**：从个人记忆自动蒸馏可被任意 Agent 加载的技能文件 | 需要"记忆→技能"的加工设计，各家尚未做 | 中低：单点功能，可被快速复制，但是自然的产品延伸 |
| **国内工具深度适配**（Kimi/GLM/DeepSeek/通义的会话采集与注入） | 海外项目无动力；国内项目碎片化 | 低中：竞品已有浅适配，纵深格式随版本漂移，维护成本高 |

**结论：把项目叙事从"全领域四件套"改为"git 原生的个人记忆层 + 技能蒸馏"，是当前竞争格局下唯一站得住的定位。**

### 1.4 更正与补充核查（v1.1）

针对评审中提出的两处存疑信息做深度核查，结果如下——**一项推翻本报告 v1.0 的表述，一项修正竞品仓库地址。两处更正均使差异化论点更锋利，但事实层以 v1.1 为准。**

#### 1.4.1 Supermemory：是收费项目；且本地二进制的引擎源码并非开源

- **商业模式**：托管平台明码收费——Free $0（含 1M tokens/月、10K 次搜索/月）、Pro $19/月（3M tokens、100K 搜索）、Max $100/月、Scale $399/月、Enterprise 定制；超额部分 $0.01/1K tokens、$0.10/1K 搜索。GitHub 仓库 28K★。
- **开源边界（v1.0 表述错误，特此更正）**：`supermemoryai/supermemory` 仓库确为 MIT，但**仅覆盖 SDK、MCP server 与编辑器插件；官方自托管二进制"由单独的、非公开的代码库构建"**（官方 self-hosting 文档原话："the downloadable self-hosted server binary is built from a separate, non-public codebase"）。即：本地版可免费下载自用（lite 许可限制，可全离线接 Ollama），但**引擎源码不公开、不可审计、不可 fork**；生产级自托管则与 Scale/Enterprise 计划绑定。
- **对评估结论的影响**：
  1. **差异化论点修正后更锋利**：竞品的"本地优先"要么是闭源二进制（Supermemory）、要么是加密黑箱 SQLite（Heirloom/Glia）、要么付费云同步（Basic Memory Cloud）——**"全链路开源可审计 + Markdown 明文 + git 工作流"仍是无人占位的组合**，应作为 README 与定位陈述的第一卖点。
  2. **不能打价格战**：Supermemory 免费额度（1M tokens/月）对个人用户绰绰有余。本产品的价值主张必须建立在**数据主权、可审计性与可迁移性**上，而非成本优势。
  3. **对 Phase 0 的影响**：agentmemory/Supermemory 实测对照时，需把"能否审计引擎行为、能否导出明文"列入评分表——这是用户可感知的差异，而不只是架构洁癖。

#### 1.4.2 Heirloom：仓库真实存在，地址因账号改名而变更

- **正确地址**：`github.com/xenoaitham/heirloom`。LobeHub 等目录站仍标注 `MayonaiseLover/heirloom`——作者已将 GitHub 账号改名为 `xenoaitham`（2026-09-08 的提交仍在批量更新 README 链接），叠加项目极小（目录站显示安装数 1），导致常规搜索难以命中。官网：heirlooom.web.app（注意是三个 o）。
- **实况细节（对设计有参考价值）**：Rust workspace 18 crates，v1.0.4（2026-05-14），MIT，67 项测试。除 1.1 表所列外，值得注意的实现选择：**FTS5 BM25 + hash 投影 n-gram TF-IDF 向量的零模型混合检索**（纯 Rust 内嵌、无 ONNX、无 80MB 模型）——这是本报告 4.4 决策 2（API embedding 可选）之外值得评估的第三条路，V0.1 可用 ~50 行代码验证其对中文+代码混合查询的命中率；`.hlm` 加密快照经 Syncthing/AirDrop/USB 传输的多设备同步（与"不产品化同步、用现成传输层"的建议同构）。
- **两个印证**：① 其 README 自曝"ingesters 仅针对合成 fixture 测试，真实导出需用户自行验证"——与 lore 同款 failure mode，**再次证明规划 7.2"适配器必须附真实样本回归测试"不是过度设计**；② 全项目**没有任何 LLM 蒸馏层**（原始摄取 + 检索 + 脱敏）——蒸馏加工仍是本项目对 Heirloom 的清晰差异点。
- **威胁评级**：单人项目、无蒸馏、加密黑箱存储、社区 traction 趋近于零——列为"方向信号有效、竞品威胁低"；其采集器清单（claude-code/chatgpt/slack/obsidian）可作为本项目 V0.2 采集通道的参照系。

### 1.5 竞品全景补全（源自 agentmemory 官方中文横向对比，2026-10-15 抓取）

`agentmemory` 的 README.zh-CN 提供了一份 11 列横向对比表（agentmemory / mem0 / Letta / Khoj / supermemory / TencentDB Agent Memory / MemPalace / oracleagentmemory / Hippo / 内建 CLAUDE.md），并额外列出"新入局者" Zep-Graphiti 与 Cognee。**该表是本轮核查中最完整的一份行业切片，且是竞方自述——数字需打折，但"维度选择"本身很有参考价值。**

**其对比维度（8 个）应被本项目直接借用作自评框架**：类型 / 检索 R@5 / 自动捕获 / 搜索方式 / 多代理 / 框架锁定 / 外部依赖 / 记忆生命周期 / Token 效率 / 实时查看器 / 自托管。注意两点：① 表中 **没有任何一个项目把"事实源是否明文、可 diff、可 git 管"列为维度**——再次印证 1.3 的空白判断；② agentmemory 自报 R@5 95.2%（LongMemEval-S），而同表竞品多为厂商自报、数据集不同，**并置仅为粗略参考**（其脚注已声明），不可作为选型依据。

**与目标规划"相近度"分档**（判定标准：个人级 × 本地优先 × MCP-native × 跨 Agent × 明文事实源 × 可自托管）：

| 档位 | 项目 | 相近度 | 与本目标的对齐 / 分歧 | 建议 |
|---|---|---|---|---|
| **A 必装体验** | **Heirloom**（MIT） | 形态 95% / 内核 40% | 单二进制 + MCP-native + 8 采集器 + watch 守护 + 加密同步，产品形态几乎同句；**分歧在存储哲学**：SQLite 加密黑箱 vs 你的 md 明文事实源 | 装。见 1.6 逐条对齐 |
| **A 必装体验** | **agentmemory** | 75% | 本地 SQLite + 自研 iii-engine、零外部依赖、12 hooks 自动捕获、BM25+向量+图 RRF 融合、自带 eval 框架与 LongMemEval 复现脚本；**分歧**：无 md 事实源、无 git 工作流、自动捕获绑定其 hooks | 装。重点体验其 **hooks 自动捕获的零感**与 **eval 框架**（后者可直接复用于本项目的 Q1/Q2 实验） |
| **A 必装体验** | **Basic Memory**（AGPL-3.0） | 70% | **md 事实源 + MCP** 已规模化（3k★），是与你"事实源"主张最接近的已验证产品；**分歧**：AGPL 传染性（禁止吸收代码，只能体验/借鉴）、云同步付费、偏"项目知识库"而非"会话记忆" | 装。**只体验不读码**（保许可证洁净），重点看它的 MCP 工具面设计与 md 目录组织 |
| **B 重点参考** | **Supermemory** | 60% | 形态最全（API + MCP + 扩展 + 连接器 + 本地二进制 + MemoryBench）；**分歧致命**：引擎源码非公开（1.4.1）、云为商业核心 | 装本地二进制体验检索质量；**MemoryBench 可直接复用为本项目 eval** |
| **B 重点参考** | **mem0**（63K★） | 50% | 记忆层 API 范式的事实标准，**外部依赖 Qdrant/pgvector**，非本地优先 | 读文档即可，不必装（有外部依赖） |
| **B 重点参考** | **Zep / Graphiti**（30K★） | 35% | 时序知识图谱是其独有能力（LongMemEval 63.8%）；但图谱异步构建、新事实滞后——**这恰是"会话记忆"场景的硬伤** | 读其时序建模论文/文档；V1+ 再考虑 |
| **C 了解即可** | **Cognee**（30K★） | 30% | 文档→知识图谱，Python only，为结构化实体抽取而非会话捕获 | 略 |
| **D 可排除** | Letta/MemGPT、Khoj、TencentDB Agent Memory、MemPalace、oracleagentmemory、Hippo、内建 CLAUDE.md | <25% | 分别是：高框架锁定（必须用 Letta 运行时）、个人 AI 助手而非记忆层、Docker 栈团队向、仅向量+手动、Oracle DB 依赖、手动维护、静态文件 | 不装。其中 **CLAUDE.md 内建方案直接作为本项目 Q2 盲测的 baseline 对照组**（免费获得） |

**体验执行清单**（按性价比排序，合计约 1.5–2 天）：

| 序 | 动作 | 要回答的问题 | 预估 |
|---|---|---|---|
| 1 | `npm i -g agentmemory`（或其官方安装方式）→ 跑通 Claude Code hooks 自动捕获 → 用其 `eval/` 跑一次 LongMemEval `_s` | ① 自动捕获的"零感"到底如何？② 它的 eval 框架能否直接改造成本项目的 Q1/Q2 harness？ | 半天 |
| 2 | `curl -sSL https://heirlooom.web.app/install \| sh` → `heirloom ingest claude-code` → `heirloom search "<你记得的真实往事>"` | ① 原始摄取（无 LLM 蒸馏）的检索结果能否用？→ 直接检验"蒸馏层是否真有增量价值"这一核心假设 | 2 小时 |
| 3 | 装 Basic Memory → 看它的 md 目录组织与 MCP 工具 description 写法 | ① md 事实源在真实规模（>2000 条）下会不会失控？② 它的 MCP 工具描述如何写才能被 Agent 主动调用？ | 2 小时 |
| 4 | 跑通 Supermemory 本地二进制 + MemoryBench | ① 本地闭源二进件的检索质量天花板在哪？② MemoryBench 能否作为我们的对外横评基准？ | 半天 |

> ⚠️ **两条纪律**：① 体验 Basic Memory 期间**不要打开其源码**（AGPL，避免后续被指代码沾染）；② 体验时**用你自己的真实会话数据**，而不是 demo 数据——否则无法回答"对我有没有用"。

### 1.6 目标形态对齐：Heirloom × 理想产品（你定义的五个要件）

你描述的理想产品为：① 完全开源受社区监督；② npm 全局或二进制安装；③ 可收集不同 agent 的记忆 / 配置 MCP 收集；④ 事实源是 md 原始文档，可从中重建本地轻量索引向量库供 MCP 读写；⑤ 方便云端备份与跨机器使用。**Heirloom 与它的关系是"形态不谋而合、存储哲学相反"**——逐条对齐如下：

| # | 你的要件 | Heirloom 现状 | 判定 | 说明 |
|---|---|---|---|---|
| ① | 完全开源受社区监督 | MIT，Rust 18 crates 源码全公开，CI + 67 项测试 | **✅ 命中（但"被监督"未成立）** | 源码可审计这点远胜 Supermemory。但"社区监督"是**结果而非许可证属性**：单人项目、目录站安装数 1、无外部 contributor——开源 ≠ 有人看。这一条你若要真正兑现，需要在项目早期就把 issue/roadmap/安全公告做成公开习惯，而非后期补 |
| ② | npm 全局或二进制安装 | `curl … \| sh` 安装脚本 + `cargo install` 两种；**无 npm 分发** | **⚠️ 半命中** | 形态（单二进制、无 runtime 依赖）完全一致，只是分发渠道缺 npm。若你的目标用户含 Node 生态开发者，这是可补的一层包装（见 4.4 决策 5 修订） |
| ③ | 收集不同 agent / MCP 收集 | `fs / browser / firefox / claude / chatgpt / claude-code / slack / obsidian` 8 个采集器 + `watch` 定时守护（config.toml 编排）+ `heirloom serve` MCP server + ~50 行即可写一个新采集器 | **✅ 强命中** | 采集覆盖面**比本规划 MVP 更全**，其"~50 行插件"的 ingester 抽象值得直接借鉴为接口设计。另注意：它的 MCP 定位是"只读查询为主"`what does the user know about this?`——**写入通道弱**，而你的要件④明确要求"供 MCP 读写" |
| ④ | md 原始文档为事实源 + 可重建轻量索引 | **加密 SQLite 是唯一事实源**；md 只是 8 个*输入源*之一（fs/obsidian 摄取）；`export` 产出 **JSONL** 而非 md；索引不可从 md 重建；`Embedder` trait 预留了 fastembed 后端开关 | **❌ 完全未命中（最大分歧）** | 这是架构级差异，非功能差异：**它的"数据主权"靠密码学（XChaCha20-Poly1305 + Argon2id 静态加密），你的靠透明性（ plaintext md + 可 diff/回滚/重建）**。两条路都能讲主权故事，但只有后者能白拿 git 的 diff、blame、branch、CI Lint、Obsidian 直开 |
| ⑤ | 云端备份 / 跨机器 | `sync push` 产出加密 `.hlm v1` 快照 → `sync pull` 解密合并；**端到端加密已实现，但传输层刻意不做**：需用户自己用 Syncthing / AirDrop / USB / 自有 S3 搬运；**托管 relay 仅列在 v1.1 roadmap，未交付** | **⚠️ 半命中（密码学做完了，便利层没做）** | 与本报告 4.4 决策 8"同步不自建、用现成传输层"是同一判断，说明这个取舍是对的；但你的要件⑤要的是"方便"，纯手动搬运不算方便 |

**三条结论：**

1. **"不谋而合"要精确成一句话**：你们在**产品外壳**（单二进制 / MCP-native / 个人级 / 多源采集 / 本地优先 / 无密钥可跑）上高度一致，在**存储内核**（加密 SQLite 黑箱 vs md 明文可重建）与**加工深度**（零 LLM 蒸馏 vs 蒸馏为核心）上正好相反。**Heirloom 恰好证明了外壳已被验证、且已有一个 MIT 实现可参照；而它的两个缺口（无 md 事实源、无自动同步）正是你理想产品的要件④⑤。**

2. **因此不建议从零写，也不建议 fork**：fork Heirloom 再改造成 md 事实源 ≈ 重写存储层 + 索引层 + 同步层，等于继承一个你不熟的 Rust workspace 却丢掉它的核心设计。**建议路径是"借鉴接口、不继承代码"**：① 抄它的 **ingester 插件抽象（~50 行一个采集器）**与采集器清单作为 V0.2 通道规划；② 抄它的 **`.hlm` 加密信封格式**（若未来做加密快照到对象存储）；③ 抄它的 **零模型混合检索**（FTS5 BM25 + hash n-gram TF-IDF，纯 Rust 无 ONNX 无 80MB 模型）作为 V0.1 检索的第三条候选路；④ **抄它 README 的对比表结构**做你自己的定位表。MIT 允许这一切，且不构成 AGPL 风险。

3. **你理想产品的⑤其实是④的免费副产品——这是最强论证**：正因为事实源是 md 明文，**云端备份与跨机器不需要"做"一个同步模块**——`git push` 到私有仓库就同时拿到了备份、版本历史、diff 审计、跨机器拉取，且冲突时可用人类可读的方式解决。Heirloom 因为是加密 SQLite 黑箱，**必须**额外造一套快照-合并协议（它确实造了，还得自己处理冲突）。**这一条应该成为 README 的第一句话级卖点**："你的记忆是一个 git 仓库，不是一个数据库文件。"

---

## 2. 逐节评估

### 第 1 章 产品概述

**亮点**：问题陈述真实、链路图清晰；v0.4 能主动推翻自己此前的判断（"采集覆盖无人做"），方法论健康。

**盲点与遗漏**：
- **P0 "全领域"无定义、无证据。** 生活/决策类会话（购车、选校、比价）是一次性低频场景，"沉淀复用"价值存疑；而编程场景已被 agentmemory 做透。规划把最大赌注押在未被验证的领域泛化上。且"领域覆盖"没有任何验收标准（覆盖到什么程度算全领域？）。
- **P1 定位句未区分"个人级 vs 项目级"。** memofs 是项目级（`.memofs/` 随项目仓库），本产品是个人级（跨项目、跨工具的个人记忆）——这是少数清晰的竞品分界线，应在 1.1 一句话定位中明示。
- **P1 缺"反定位"与用户旅程。** 没有"不做什么"清单；没有"安装到第一次 aha 需要几步"的叙事——而安装步数恰是此类工具流失率最高的地方。

**补充建议**：
1. 1.1 定位句改为："一款 **git 原生、本地优先的个人级** AI 记忆层：自动采集你在各 AI 工具中的会话，蒸馏为可 diff、可回滚的 Markdown 知识库，通过 MCP 与上下文文件接入任意 Agent，并逐步蒸馏为技能资产。"（个人级、git 原生入句；"全领域"降级为愿景描述）
2. 新增 1.4"领域优先级"：编程/技术决策（第一，用户自有高频）→ 工具与方法论经验（第二）→ 生活决策（第三，仅当采集通道零成本时顺带覆盖）。**不为生活场景单独付出工程成本。**
3. 新增 1.5"反定位（MVP 不做）"：不做团队/多人共享、不做托管云、不做聊天机器人本体、不做通用笔记应用（Obsidian 已是）、不自建向量数据库服务。

### 第 2 章 市场与社区现状

**亮点**：2.2 对 agentmemory 的逐项对照是全文最扎实的部分；对自报指标的怀疑态度正确。

**盲点与遗漏**：
- **P0 遗漏 5 个直接竞品**（Supermemory、Heirloom、Glia、Kept、MemoryPlugin，见 1.1 表）。以 Supermemory 的本地单二进制 + MemoryBench 之势，规划 2.4 的定位图（本产品独占左上空白区）**与事实不符**——左上区域已有多个占位者。
- **P1 "国内适配薄弱"论据被部分推翻**（见 1.2-2）。
- **P1 缺平台方监控清单。** Claude Code auto memory 已默认开启；若 OpenAI/Anthropic 后续开放 memory 导出/导入 API，"数据可迁移性"这一卖点将快速贬值。应建立监控：① Claude Code memory 功能迭代；② ChatGPT memory 导出能力；③ 各厂商对 AGENTS.md/MCP 记忆标准的动作。
- **P1 竞品分析停留在功能矩阵，未升维到"价值假设矩阵"**（哪个假设被谁验证、哪个假设无人验证、哪个假设被证伪）。

**补充建议**：
1. 重写 2.1 盘点表：补入 Supermemory / Heirloom / Glia / Kept / MemoryPlugin，并按"编程场景 / 个人全领域 / 历史归档 / 平台内建"分四类，而非混在一张表。
2. 2.4 定位图重绘：横轴从"数据可迁移性"改为"**记忆管理层级**（原始历史 → 蒸馏记忆 → 技能资产）"，纵轴"scope（项目级 → 个人级）"——本产品占"个人级 × 蒸馏/技能"格，hstry/lore 占"原始历史"格，memofs 占"项目级蒸馏"格，agentmemory 占"编程个人级蒸馏"格。图要诚实反映拥挤度。
3. 新增 2.5"价值假设矩阵"：逐行列出本产品的关键假设（采集可行、蒸馏提质、跨 Agent 复用、用户愿装、竞品不跟进），每行标注"已被谁验证 / 无人验证 / 有反证"。
4. Phase 0 增加：跑通 **MemoryBench**（Supermemory 开源横评框架），把 agentmemory/mem0/自研原型放同基准对比——这是对"不信自报数据"原则的正确执行，且不造 eval 轮子。

### 第 3 章 用户与场景

**亮点**：primary/secondary 用户划分合理；场景 1、2 描述具体。

**盲点与遗漏**：
- **P0 目标用户内在矛盾。** "全领域（生活+决策）"叙事吸引的是非开发者知识工作者，但交付形态（git 私有仓、CLI、单二进制、SQLite）只对开发者成立。**非开发者不会用 git 同步记忆。** 这是定位与交付的结构性错位，规划全文未察觉。
- **P1 场景 3（跨设备办公）可能是伪需求。** 今天用 OneDrive/Syncthing 放一个 MD 目录即可解决 80%；"产品化同步"须证明比现成方案好（如 git 的历史与回滚）才有存在理由。
- **P1 缺"反面场景"与禁区设计。** 绩效谈话、医疗咨询、情感倾诉、他人隐私——用户明确不希望这些进入知识库。渐进式信任（原则 4）需要"禁区"机制落地，否则第一次误采集就会摧毁信任。
- **P1 场景之间无优先级。** 5 个场景并列，导致 Phase 1 想同时满足全部——这是范围失控的源头。

**补充建议**：
1. 明确早期用户 = "**同时使用 2+ AI 工具的开发者/高级知识工作者**"；生活场景作为"采集通道顺带覆盖"的副产品，不作为目标。桌面 GUI（面向非开发者）列入 Phase 3+ 或社区方向。
2. 新增 3.3"场景优先级评分"表（频率 × 价值 × 可验证性），MVP 只保 top 2：① 跨工具/跨项目的编程经验延续（Claude Code ↔ Cursor/新会话）；② 高质量会话的自动沉淀。
3. 新增 3.4"禁区与信任"：目录级排除（如 `~/work-confidential`）、关键词级排除、公司设备 profile 标记（见第 8 章合规风险）、一键暂停/清空/导出。

### 第 4 章 产品设计原则

**亮点**：五条原则全部正确且互相自洽；"Markdown 唯一事实源、派生数据可丢弃重建"是全场最关键的架构决策。

**盲点与遗漏**：
- **P0 "MD 权威 + SQLite 索引"的一致性协议缺失。** 规划说索引"可丢弃重建"，但没回答：用户手工编辑 MD 后索引何时失谐？失谐期间检索返回什么？重建需要几分钟期间 MCP 检索是否可用？**这是双写架构必然遇到的第一题，没有协议就会以 bug 形式出现。**
- **P1 "零部署门槛"无验收标准。** 单二进制/pipx 对开发者是零门槛，对"知识工作者"不是；且 MCP 配置（写 JSON、配环境变量）对非开发者是硬墙。建议定义安装验收：**目标用户从零到第一次成功检索 ≤ 10 分钟**，并找 2 个非开发者实测。
- **P1 渐进式信任缺三件套**：一键暂停采集、一键清空、一键全量导出（数据主权承诺的可执行形式）。

**补充建议**：
1. 新增 4.7"索引一致性协议"：MD 文件 content-hash 记录于 SQLite；watcher 检测到外部编辑 → 增量重建该条目；`rebuild` 全量重建；重建期间检索降级为"直接 grep MD"（保证可用性）；启动时校验 hash，失谐自动重建。
2. 4.5 零部署改为"**开发者零部署**（pipx/单二进制），非开发者走桌面端（后置）"，并给出安装验收标准。
3. 原则 4 扩充为"渐进式信任 + 随时可退"：暂停/清空/导出三件套 + 采集范围默认最小（先只采集显式保存与指定目录）。

### 第 5 章 总体架构

**亮点**：分层清晰；5.2 条目格式设计（frontmatter + supersedes）是轻量且正确的冲突消解；5.3.1 产物分离、5.3.2 项目指纹、5.4 调用意愿优化都是高质量思考。

**盲点与遗漏**：
- **P0 架构图缺"评估 harness"组件。** 抽取质量、检索质量、端到端价值是本产品的生命线，但架构里没有任何组件对它们负责。应增加独立一层：离线 golden set（人工标注的会话→应抽记忆对）+ 在线采样日志 + 盲测脚本。**这是"加工质量是核心竞争力"这一论断的唯一落地方式。**
- **P1 浏览器扩展（采集层③）风险被低估。** DOM 逆向随平台改版失效（ChatGPT 前端月更级变动）、ToS 灰色、隐私敏感。hstry/Kept 的实践表明更稳的路径是**平台自有 API 端点**（Kept 文档公开了 ChatGPT/Claude/Gemini/Grok/Kimi 的 API 抓取流程：`chatgpt.com/backend-api/conversations`、`claude.ai/api/organizations/{org}/conversations` 等）——用会话 cookie 调 API 而非解析 DOM。建议：MVP 不做扩展；Phase 2 做"官方导出文件导入"（ChatGPT/Claude 均有 Settings→Export）+ 参考 Kept/hstry 的 API 方案，**不要从零逆向 DOM**。
- **P1 服务层缺审计与反馈。** 没有"哪条记忆在什么上下文被哪个 Agent 用过"的日志（既是产品指标也是信任功能）；配套清单已指出 lore 的 `memory_feedback` 工具，主规划工具集未纳入。
- **P1 缺"上下文导出"能力（非 MCP 原生 Agent 的接入路径）。** 大量国内 Agent 不读 MCP。第一公民功能应是 `omem context --for <agent>`：生成 `.cursor/rules/*.mdc`、AGENTS.md 片段、系统提示文本——**这比 MCP 工具覆盖面更广、实现成本更低**，却被完全遗漏。
- **P2 artifacts 引用路径跨设备失效未与 5.3.2 联动。** `artifacts: [path...]` 存相对/绝对路径，换机器即断链；应存指纹化路径或内容 hash。
- **P2 5.4 缺"服务端被动注入"与 compaction 存活。** 5.4-3 的 MEMORY-INDEX.md 依赖 CLAUDE.md include（会话启动加载一次，context compaction 后不重载）；memofs 的 hook 方案（SessionStart/PreCompact 挂载，压缩后重注入）是已验证的进阶解，应列为 Phase 2 研究项（以 Claude Code 官方 hook 清单为准）。

**补充建议**：
1. 架构图最上方增加"评估层（golden set + 盲测 + 调用日志）"，与加工层并列——它同时服务开发期质量门与运行期指标。
2. MCP 工具集 v1 修订：`search_memory`（支持 domain/project scope 过滤）、`save_memory`（幂等 + 去重指纹参数）、`get_skill`；**新增 `memory_feedback(id, helpful)`**（Agent 回报记忆有用性——质量闭环 + 平台方难抄的差异化数据）；list/delete 移出工具集走 CLI（遵循 5.4-1 精简原则）。
3. 采集层③从"浏览器扩展"改为"**网页会话导入（导出文件 / API 端点 / 扩展，按此优先级）**"，并在架构注释中引用 Kept 的 API 流程文档作为实现参考。
4. 服务层增加 `omem audit`（记忆使用日志）与 `omem context --for <agent>` 导出器（首批支持：claude-code、cursor、codex/AGENTS.md、纯文本系统提示）。

### 第 6 章 技术选型

**亮点**：选型理由清晰，"有意不选"一节尤其实诚（Neo4j/独立向量服务的排除正确）。

**盲点与遗漏**：
- **P0 中文检索的硬伤未被识别。** SQLite FTS5 默认 unicode61 tokenizer 对连续 CJK 文本按"非字母数字边界"切分，一整段中文会变成单个巨型 token，关键词检索基本失效。解法：① `tokenize='trigram'`（SQLite ≥3.34，中文按 3 字符子串匹配，查询需 ≥3 字符）；② jieba 预分词写入索引列；③ ICU tokenizer（需编译选项）。**这是中文用户的关键技术点，全文未提。** 附带风险：部分 Python 发行版（尤其 Windows 官方构建）的 SQLite 未启用 FTS5，需在 Phase 0 用 `CREATE VIRTUAL TABLE t USING fts5(x)` 实测确认，未启用则换 `pysqlite3` 或自建倒排。
- **P1 embedding 选型无基准。** 中英 + 代码混合场景下 bge-m3（2.2GB/8192ctx）vs bge-small-zh vs Qwen3-Embedding vs jina-embeddings-v3 vs text-embedding-3-small 的取舍无数据；且"本地 bge-m3 或 API"的表述回避了成本/体积/延迟三难。
- **P1 加工模型无分级。** 抽取（高频、量大、任务简单）与合并/冲突消解（低频、要强）应分级用模型，全用强模型成本失控，全用弱模型质量失控。
- **P1 单二进制与模型分发矛盾未识别。** pkg/bun 单文件 + bge-m3 2.2GB 模型无法兼得；模型必须作为可选资产独立下载（或 MVP 直接用 API embedding 规避）。
- **P2 sqlite-vec 与 FTS5 的融合无现成组件**，需手写 RRF；MVP 可先 FTS5-only，向量作为可选开关后置。

**补充建议**：
1. 6.1 增加"检索栈"小节：**FTS5 trigram 为默认分词（中文兜底），jieba 预分词作为 Phase 1 备选；Phase 0 第一周实测 fts5 可用性 + trigram 中文效果**。
2. Embedding 决策表：MVP 默认"用户 API key + OpenAI 兼容端点"（月成本 ≈ ¥5，零分发负担）；本地 embedding（fastembed/ONNX + bge-m3 或 bge-small-zh）列为 V0.2 隐私选项，用 golden set 跑 bge-m3 vs API 的命中对比后定。
3. 加工模型分级写入选型表：抽取 = 轻量模型（haiku/flash/glm-flash 级，单次 ≈ ¥0.05–0.2），合并/冲突消解 = 强模型；prompt 版本化（`prompts/extract_v1.md` 进 git）。
4. 打包：MVP 用 pipx（Python 生态分发成本最低）；单二进制留到 V0.2+ 且必须把模型排除在包体外。

### 第 7 章 路线图

**亮点**：7.1 全自研决策的理由（数据格式自主权 + 适配生态是战略）成立；7.2 核心/适配器分离、真实样本回归测试门槛（吸取 lore 教训）是正确且必要的设计。

**盲点与遗漏**：
- **P0 缺 go/no-go 闸门。** Phase 0–4 是"功能排期"而非"验证计划"：没有任何一处写明"做到什么程度就停/就转向"。对一个差异化被高估、价值未验证的项目，这是最危险的缺失。
- **P1 Phase 1 范围过大。** "全领域加工 + 混合检索 + 项目指纹 + 审查 UI"四件事并行，任一出问题都会阻塞其他。且审查 UI 应后置——**Markdown 文件 + Obsidian/VS Code 本身就是审查 UI**，自建 UI 是重复造轮子。
- **P1 Phase 3 才开源发布过晚。** 开源项目的冷启动（反馈、贡献者、star 积累）以月计，憋到 Phase 3 等于把最大杠杆留到最后。建议 Phase 0 结束即公开仓库（WIP 状态），边建边获客。
- **P2 "国内 Agent 厂商可能官方接入"缺论据。** 厂商为何要接入一个无名个人项目的记忆层？改为可执行的："公开 adapter 接口 + 模板仓库 + 文档，先服务自己和早期用户，需求出现再扩。"
- **P2 Phase 4 技能市场/分享是重运营**，与其余部分不是一个量级，应明确标注"社区方向，非核心路径"。

**补充建议**：
1. 路线图整体改为"**验证闸门制**"（详见第 4.7 节）：每个 Phase 出口有量化指标 + 不达标的收缩预案；Phase 编号让位于"V0.1 验证 → V0.2 公测 → V0.3 生态化"三段。
2. Phase 1 拆分：V0.1 只做"单工具采集 + 蒸馏 + MD 存储 + FTS5 检索 + MCP search/save"；项目指纹、context 导出入 V0.2；审查 UI 永不立项（用现成编辑器）。
3. 开源时点提前至 V0.1 末（第 10 周左右）：定名、MIT、README 写明"个人工具，API 不稳定，欢迎试用暂不接 PR"。
4. 7.2 补充适配器治理细节（已部分具备）：适配器版本与核心版本锁定、格式漂移告警、README 标注"未经真实数据验证"降级展示——这三条保留，加上"每个适配器必须附带 ≥1 个脱敏真实会话 fixture"。

### 第 8 章 关键风险与对策

**亮点**：8 条风险识别准确，等级判定合理；"采集格式易碎"的降级策略（插件化 + 失败降级为仅 MCP）正确。

**盲点与遗漏**：
- **P0 缺四类风险**：
  1. **记忆投毒 / 提示注入**：知识库条目会被未来 Agent 当事实读入上下文。一条被污染的记忆（来自恶意网页内容、被劫持的会话文件、或 LLM 加工幻觉产生的"指令式"内容）可以持续影响所有后续 Agent 的决策——这是自动采集架构特有的攻击面，云端记忆产品同样中招。对策：条目禁止指令式语气（Linter 规则）、来源可信度分级、web 来源条目默认低权重、Agent 读取时以"参考笔记"而非"命令"框架注入。
  2. **平台方收编**：Claude Code auto memory 继续增强（如开放跨机器同步）、或 OpenAI 开放 memory 导入——"跨设备/可迁移"卖点贬值。对策：监控清单（2 章）+ 把护城河押在 git 原生工作流与 Obsidian 生态（平台方不会做 git 仓库形态的个人记忆）。
  3. **公司设备合规**：开发者用户在公司电脑上的会话包含商业代码与内部决策；同步到个人 git 私有仓 = 把公司资产传出内网，可能违反公司政策甚至合同。**这是目标用户（开发者）最高频的硬约束，规划完全没有意识。** 对策：work/home profile 隔离（`omem profile use work`——work profile 默认禁止任何导出/同步、默认排除代码类条目、可被公司策略强制锁定），安装时明确询问。
  4. **维护者倦怠/单点**：单开发者项目 + 适配器随各平台版本漂移的长期维护，是此类项目的第一死因（lore/memoir 均已近停更）。对策：核心刻意小（采集+蒸馏+索引+暴露，不超 ~5k 行）、适配器走社区、文档化优于自动化、公开构建以获反馈对冲孤独感。
- **P1 数据丢失风险**（MD 误删、同步冲突覆盖、SQLite 损坏）无条目。对策：每日快照（`snapshots/`，git 或 tar）、MD 权威原则保证最坏情况可重建。
- **P1 "加工质量不稳定"的对策缺评估集支撑**：调优无标尺，只能靠感觉。对策见第 3 章 Q1 实验与评估层架构。

**补充建议**：风险表扩至 12 条，新增四条按上表；每条对策标注"落地的 MVP 功能"（如 profile 隔离是 MVP In-scope，快照是 MVP In-scope，记忆投毒 Linter 规则是 V0.2）。

### 第 9 章 成功指标

**亮点**：区分留存/复用/质量/成本四类；引入"应调尽调"的人工抽样判定，务实。

**盲点与遗漏**：
- **P0 全部是自用指标，无外部验证、无证伪指标、无基线对照。** "自己连续 30 天使用"对开发者自制工具有强偏误（自己造的刀永远最顺手）；"跨 Agent 命中 ≥20 次/周"在单用户小样本下无统计意义。**没有一条指标能在"项目应该停止"时给出信号。**
- **P1 调用率 70% 无基线。** 应测 Claude Code auto memory 的实际触发/命中率作对照系，否则 70% 是拍脑袋。
- **P1 缺维护成本指标与反面指标。** 每周花在维护知识库（修错条、删重复、处理冲突）的分钟数——若趋升，产品在制造工作而非消灭工作；误入库率/敏感内容泄漏数应作为反面指标（目标 0）。

**补充建议**：指标分为三层——**验证层（Q1/Q2/Q3 实验指标，见第 3 章，前 12 周）→ 自用层（现有指标 + 维护分钟数 + 成本 ¥）→ 公测层（安装成功率、7 日留存、NPS）**；每个指标标注采集方式与责任人；增加 kill criteria（见 4.6）。

### 第 10 章 参考项目 + 附录

**亮点**：研读清单分级合理；配套的组件复用清单（A/B/C 分级、NOTICE、吸收台账、命名避坑）质量很高，是本规划目前最可执行的文档。

**盲点与遗漏**：
- **P1 补充三个参考源**：① **MemoryBench**（Supermemory 开源记忆横评框架——Phase 0 直接可用）；② **Kept 的平台 API 逆向文档**（ChatGPT/Claude/Gemini/Grok/Kimi 抓取流程，网页采集的实现参考，省数月摸索）；③ **Claude Code memory 官方文档**（auto memory 的确切行为：200 行/25KB 限制、`/memory`、worktree 共享、不跨机器——MVP 基线与被动注入设计的依据）。
- **P2 开放问题 Q6（Unified Session Schema 升格为开放规范）不应埋在附录。** 这是把生态位从"产品"升为"标准"的唯一路径（AGENTS.md 先例）。建议：保持自定义 schema，但在有 2–3 个活跃适配器后（V0.3）主动以"个人记忆交换格式"名义推动社区采用——先产品后标准，顺序不能反。
- 附录问题回应建议：Q2 团队共享 MVP 明确不做（与个人定位冲突，且 Heirloom 已做）；Q4 artifacts 治理建议"引用即存 + LRU 淘汰 + 容量上限"；Q5 指纹隐私建议"存 hash(remote URL) 而非原文，注册表明文仅存本机"。

---

## 3. 价值验证：三个必须先回答的问题

规划的隐含逻辑是"先做出来，好处自然显现"。正确顺序是反的：**用最小成本先测三个假设，再决定投入量。**

| # | 问题 | 为什么致命 | 实验设计（成本） | 通过标准 |
|---|---|---|---|---|
| **Q1** | 加工质量：LLM 自动抽取的记忆，人工审查通过率能稳定 ≥80% 吗？ | 不过关则知识库被垃圾条目淹没，检索与信任双崩 | 取自己 20 个真实 Claude Code 会话（覆盖调试/决策/配置三类），写 3 版抽取 prompt 盲评，记录漏抽/幻觉/过度合并三类错误 | ≥80% 通过率，且两轮 prompt 迭代内收敛 |
| **Q2** | 增量价值：带记忆的 Agent 回答，显著优于 dumb baseline 吗？ | LoCoMo 历史结论：多数记忆系统打不过简单基线。打不过则全盘皆输 | 盲测：同一批 20 个真实问题（"我之前怎么配的代理""这个项目的部署命令是什么"），四种条件作答：① 无记忆 ② Claude Code auto memory ③ 手工 MEMORY.md ④ 本产品记忆。LLM-judge + 自评双轨 | ④ 对 ① 有用率提升 ≥15pp；④ ≥ ②③ 中较强的一个 |
| **Q3** | 外部需求：除我之外，有人愿意付出安装成本吗？ | 自用指标有严重开发者偏误；无外部信号则开源发布即无人问津 | V0.1 末找 10 人 beta（同行/社区），记录安装成功率、首次检索成功时间、7 日留存 | ≥7/10 安装成功；≥5/10 存活 7 日；≥3/10 主动要求新功能 |

**判定矩阵**：

| Q1 | Q2 | Q3 | 决策 |
|---|---|---|---|
| ✅ | ✅ | ✅ | 按 V0.2/V0.3 路线推进（生态化、适配器、技能库） |
| ✅ | ✅ | ❌ | 收缩为"个人工具 + MIT 开源"，不追增长，控制在每周 <5h 维护 |
| ✅ | ❌ | — | 停止产品化：保留 CLI 脚本自用；复盘是蒸馏问题还是检索问题 |
| ❌ | — | — | 停止：加工质量不过关时一切免谈；考虑转做"会话归档检索"（hstry 已有，更不值得） |

---

## 4. MVP 方案 V0.1（验证先行）

### 4.1 目标与核心假设

**一句话：验证"Claude Code 会话 → LLM 蒸馏 → 跨 Agent/跨会话检索"能在开发者自己的日常中，稳定打赢 dumb baseline。**

- 唯一核心场景：在 Claude Code 里解决的偏好/决策/环境配置/调试经验，出现在 Cursor、Cherry Studio、Claude Code 新会话的相关上下文中。
- 核心假设链：采集完整（漏采 <5%）→ 蒸馏可用（通过率 ≥80%）→ 检索命中（top-3 有用率 ≥60%）→ 端到端增量（Q2 盲测胜出）。
- 明确不做（功能边界见 4.2）：MVP 不是产品，是**实验装置 + 个人工具**。

### 4.2 场景与功能边界

| 边界 | In（V0.1） | Out（V0.2+ 或社区） |
|---|---|---|
| 采集通道 | **仅 Claude Code 会话文件**（`~/.claude/projects/**/*.jsonl`，只读解析）+ 手动 `omem add` + MCP `save_memory` | 其他 Agent watcher、Cursor/Codex 采集、浏览器扩展、网页会话导入（导出文件/API） |
| 领域 | 编程 + 技术决策（用户自有高频） | 生活/决策类领域泛化 |
| 存储 | `knowledge/**/*.md`（权威）+ SQLite FTS5 索引（trigram）+ content-hash 一致性 | 向量检索（V0.2 可选 API embedding）、知识图谱、Linter、lineage |
| 加工 | 单级抽取（轻模型）+ 多轮修正合并（同会话内）+ 黑名单脱敏 + unverified 默认 | 跨会话全局合并、冲突消解自动化、认知衰减、压缩归档 |
| 暴露 | MCP `search_memory`/`save_memory`（2 个工具，两级懒加载）+ `MEMORY-INDEX.md` 被动注入 + `omem context --for` 导出 | `get_skill` 技能加载、memory_feedback、审计 UI |
| 同步/备份（v1.3 修订） | **`omem sync` 统一入口 + `SyncBackend` 抽象**；V0.1 只交付 GitBackend；`omem snapshot` 每日快照兜底 | WebDAV 后端（V0.2，非开发者主路径）、本地目录后端（V0.2，Syncthing/USB/网盘目录）、加密快照→对象存储、**自建 relay 服务器（永不）** |
| 安全 | work/home profile 隔离（work 禁导出）、禁区规则（目录/关键词）、脱敏正则、快照 | 条目级 sensitivity 同步排除、记忆投毒 Linter |
| UI | **不自建**：Obsidian/VS Code 即审查 UI + `omem review` 队列 CLI | Web/TUI 审查界面 |
| 多用户 | 明确不做 | 家庭/团队共享（社区方向） |

### 4.3 架构（收窄版）

```
~/.claude/projects/**/*.jsonl ──► 采集器（只读 + Unified Session Schema）
                                        │
omem add / MCP save_memory ─────────────┤
                                        ▼
                                   加工器（prompt 版本化；轻模型抽取 → 结构化 JSON）
                                        │  （黑名单脱敏 / 禁区过滤 / profile 隔离在此层）
                                        ▼
                              knowledge/<domain>/<id>.md（权威事实源）
                                        │  content-hash + watcher 保持索引同步
                                        ▼
                              SQLite(FTS5 trigram) 可重建索引 ◄── omem rebuild
                                        │
                    ┌───────────────────┼────────────────────┐
                    ▼                   ▼                    ▼
            MCP search/save      MEMORY-INDEX.md      omem context --for
            （两级懒加载）        （CLAUDE.md include）  （cursor/codex/系统提示）
                    
评估层（横向）：golden set 盲测 + 在线调用日志 + 周报
```

### 4.4 关键技术取舍（10 项决策）

| # | 决策 | 选择 | 理由 | 回退/验证点 |
|---|---|---|---|---|
| 1 | 中文分词 | **FTS5 trigram** | 零依赖，SQLite≥3.34 内建；中文 3 字符子串匹配可用 | W1 实测 fts5 可用性（部分 Python 发行版未编译 FTS5→换 pysqlite3）；查询 <3 字符时降级为 LIKE 兜底 |
| 2 | 向量检索 | **V0.1 不做本地模型；API embedding 可选开关（默认关）** | 不背 100MB–2.2GB 模型分发；用户已有 API key，月成本 ≈¥5 | V0.2 用 golden set 对比 API vs fastembed/bge-m3 命中率后定默认 |
| 3 | 加工模型（v1.4 重写） | **四档：① 规则抽取（默认，零配置）→ ② Agent 主动 save_memory（默认开）→ ③ Agent 协作批量加工（零配置，这才是"借本地 agent 能力"的落地方式）→ ④ 自带 API key + 轻模型（可选开关，默认关）**；MCP sampling **不可用**（Claude Code Issue #1785 未关闭），列为未来档 | 用户要求体验对齐 codegraph（零 key、零配置、立即可用）。采样路径走不通后，"不持有 key"的唯一办法是**把推理留给 Agent**（同 codegraph 的做法：它根本不做推理）。规则抽取产出候选条目（`verified:false`），用户在 review 中确认 | 档 0 需实测召回率（并入 Q1 作对照组）；若召回 <40%，把档 ③ 提为默认引导步骤 |
| 4 | 一致性 | **MD 权威 + 每条 content-hash；外部编辑检测→增量重建；rebuild 期间降级 grep** | 用户手工编辑是一等公民，索引必须容错 | 双写竞态的极端 case 由 rebuild 兜底 |
| 5 | 分发（v1.2 修订） | **npm 全局安装为首选入口，Rust 核心走平台预编译二进制**：`npm i -g omem` 通过 optionalDependencies 拉取 `@omem/cli-<platform>`（同 esbuild / oxlint / swc 模式） | 用户目标形态明确要求 npm 或二进制；此方案**两者兼得**——npm 覆盖 Node 生态用户，实际执行体仍是零 runtime 依赖的单二进制（无需目标机装 Rust/Python） | 若 Rust 核心推进受阻，回退为 TypeScript 实现 + `better-sqlite3`（须先验证 FTS5 trigram 是否被编译进该发行版）；npm 包体积需控制在 <30MB |
| 6 | 采集器实现 | **参考 lore/hstry 的 Claude Code 解析逻辑自写（~200 行），统一 schema 自定义（不沿用 memofs spec）** | 采集格式会漂移，自写+真实样本回归测试才可控；沿用竞品 schema 会生态耦合 | hstry 已支持 `~/.workbuddy/projects`，其 detect+parse 设计作接口蓝本 |
| 7 | MCP 工具面 | **2 个工具（search/save），description 写成触发条件式；返回 top-3 摘要行（<300 token），detail=true 才全文** | 遵循规划 5.4（大知识库下 Agent 调用意愿是生死问题） | 调用率日志反哺 description 迭代 |
| 8 | 同步与备份（v1.3 再修订） | **V0.1 实现 `SyncBackend` trait + GitBackend**；WebDAV 与本地目录（Syncthing/USB/网盘目录）作为同接口的第二、三实现放 V0.2；`omem snapshot` 每日快照兜底 | 用户目标形态明确要求云端备份 + 跨机器，且非开发者无 git（见 4.9）；md 事实源使同步几乎免费（1.6 结论 3）。**接口现在就抽象，后端按需加**——成本 <1 天，避免 V0.2 返工 | **自建 relay 服务器永不**（运营责任与成本不可承受）；若 V0.2 数据表明非开发者无真实需求，WebDAV 后端可继续延后 |
| 9 | profile 隔离 | **work/home 双 profile；work 默认禁导出、默认排除代码条目、可被环境变量/公司策略锁定** | 公司设备合规是目标用户硬约束（第 8 章 P0） | MVP 即做，无回退 |
| 10 | 评估 | **MemoryBench 优先 + 自建 20 题盲测脚本** | 不造 eval 轮子；MemoryBench 提供同基准横评 | 若 MemoryBench 不适配个人场景，退化为纯自建盲测 |

### 4.5 模块设计要点

**采集器**：解析 `~/.claude/projects/<encoded-cwd>/<session>.jsonl`（逐行 JSON：type/message/uuid/timestamp/cwd/gitBranch/sessionId，注意 subagent sidechain 条目与 summary 条目的过滤）；Unified Session Schema：`{id, agent, ts, project_fp, role, content, tool_calls, msg_uuid}`；去重指纹 = hash(agent+sessionId+msg_uuid)（双通道采集同一会话只入一次）；**只读原文件，SQLite 类源一律读副本**（lore 教训）；项目指纹取 git remote origin 归一化（5.3.2 设计保留，V0.1 先只用 remote hash）。

**加工器**：输入=单会话全文（超长截断到 N token，保留首尾）；输出 JSON：`[{type: preference|fact|decision|experience, domain, content(3–10句), project_fp?, confidence, artifacts?[]}]`；多轮修正检测（同会话内同一主题的后续修正→合并为一条 + changelog）；事后纠错（memoir 的 clean-decisions 思路：过滤 LLM 误造的"决策"行）；黑名单脱敏（吸收 lore `redact.py`：OpenAI/Anthropic key、JWT、PEM、通用 token 正则）；**指令式语气过滤**（"以后总是/必须/一律"类内容标记低权重——防记忆投毒第一关）；默认 `verification: unverified`。

**存储与索引**：`knowledge/<domain>/<YYYY>/<id>.md`，frontmatter 按规划 5.2（保留 supersedes/confidence，加 `verified` 与 `profile`）；SQLite 三表：entries(id, path, hash, frontmatter JSON)、fts(trigram)、meta；`omem rebuild` 全量重建；启动 hash 校验。

**MCP server**：`search_memory(query, domain?, project?, detail?)` → top-3 摘要行（标题+2句+id）或全文；`save_memory(content, source?, tags?)` 幂等（content-hash 去重）；被动注入：生成/维护 `MEMORY-INDEX.md`（≤80 行，核心记忆蒸馏），用户 CLAUDE.md 用 `@` 引入（Phase 0 验证 Claude Code 的 include 机制与 hook 清单，compaction 存活留 V0.2）。

**CLI 五件套**：`omem run`（加工最近会话，支持 --since/--session）｜`omem search`｜`omem review`（unverified 队列 + 周报摘要）｜`omem rebuild`｜`omem context --for <agent>`。加 `omem profile use work|home`、`omem pause`（一键停采集）。

**安全与合规**：禁区（`config.toml` 的 exclude_paths/keywords，采集前过滤）；work profile 禁导出；快照每日一次（cron/任务计划程序）；记忆条目读取框架：MCP 返回文本带"（来源：xxx，未验证）"前后缀，降低被当指令执行的概率。

### 4.6 验证指标与 go/no-go 闸门

| 闸门 | 时点 | 指标 | 通过标准 | 不过的动作 |
|---|---|---|---|---|
| **G1 技术可行** | W2 | FTS5/trigram 中文检索可用；Claude Code 采集漏采率 | 检索 demo 可跑；漏采 <5%（对比 hstry 解析结果抽查） | 漏采高→先修采集；FTS5 不可用→换存储/分词方案 |
| **G2 质量** | W8 | Q1 抽取通过率；Q2 盲测；月成本 | ≥80%；④ 对 ① 提升 ≥15pp 且 ≥ 最强 baseline；<¥30/月 | 任一不过→prompt/模型调优一轮（≤2 轮）；仍不过→触发 kill criteria |
| **G3 外部** | W12 | beta 安装成功率；7 日留存；主动功能请求 | ≥7/10；≥5/10；≥3/10 | 安装失败多→优先做安装体验而非新功能；留存差→回到 Q2 重测增量价值 |
| **Kill** | 任意 | G2 双指标不过 + 两轮调优无改善 | — | 停止产品化，保留个人 CLI 脚本；输出复盘文档 |

过程指标（周采）：漏采率、抽取通过率（每周抽 10 条人工评）、检索 top-3 有用率、MCP 调用次数/应调未调抽样、维护分钟数、加工成本 ¥、误入库数、敏感内容泄漏数（目标 0）。

### 4.7 迭代路径（12 周时间盒）

| 周 | 内容 | 出口 |
|---|---|---|
| W1–2 **Phase 0** | 各装 agentmemory/memofs/hstry 各一天写实测笔记（重点：采集机制、Windows 体验、非编程会话效果）；Claude Code JSONL 格式摸底；FTS5/trigram spike；MemoryBench 跑通；**采集三个 dumb baseline 数据** | G1；基线数据存档 |
| W3–6 **V0.1 核心** | 采集器 → 加工器（prompt v1→v3）→ MD 存储 + FTS5 → MCP search/save → CLI 五件套 → profile 隔离 + 脱敏 + 快照 | 自用闭环跑通 |
| W7–8 **质量收敛** | 每日自用；Q1/Q2 盲测；prompt/阈值调优；禁区规则；周报机制 | G2 |
| W9–10 **公测** | 定名/占名（npm/PyPI/GitHub org）；MIT + README（"个人工具，API 不稳定"）；10 人 beta；安装体验修复；`omem context --for` 首批三个目标 | G3 |
| W11–12 **决策点** | 三问判定矩阵评审 → V0.2 范围锁定：语义检索开关、第二个采集适配器、context 导出完善、被动注入 compaction 存活；或收缩/停止 | 书面 go/no-go |

**社区化边界**：W12 前不承诺 API 稳定、不接功能 PR（只收 bug/适配器样本）；V0.2 起公开 adapter 接口 + 贡献指南 + 统一 fixture；适配器扩张（Kimi/GLM/DeepSeek/Codex）与技能蒸馏放 V0.3，由社区与本人都按"需求出现再扩"推进。

### 4.8 复用清单（不造轮子）

| 直接用 | 来源 |
|---|---|
| MCP 协议 SDK（Python） | 官方 |
| SQLite + FTS5（trigram） | SQLite 内建 |
| 文件监视 | watchdog/chokidar |
| Embedding（可选） | 用户自有 OpenAI 兼容 API key |
| 同步与备份（V0.1 即做，见 1.6） | git（私有远端），`omem sync` 仅为 git 封装 |
| 知识库查看/编辑/双链 | Obsidian（MD 即兼容） |
| 评测框架 | MemoryBench（Supermemory 开源） |
| 网页会话采集参考（V0.2） | Kept 的平台 API 流程文档；hstry MV3 扩展源码（MIT，吸收需 NOTICE） |
| 会话解析蓝本 | lore `extractors`（算法参考+fixture）、hstry `detect+parse` 接口 |
| 脱敏正则 | lore `redact.py`（MIT，吸收需 NOTICE） |
| 提示词与注入机制参考 | memofs（compaction 存活）、memoir（SessionStart 简报 token 预算、clean-decisions） |

**借鉴（接口 / 格式级，不继承代码——v1.2 新增）**

| 借鉴项 | 来源（MIT，安全） | 用在哪 |
|---|---|---|
| 采集器插件抽象（~50 行一个 ingester）+ 8 通道清单 | Heirloom `crates/ingesters/heirloom-fs` 模板与 `CONTRIBUTING.md` | V0.2 采集通道规划与插件接口设计 |
| 零模型混合检索：FTS5 BM25 + hash 投影 n-gram TF-IDF | Heirloom `heirloom-vector`（纯 Rust，无 ONNX、无 80MB 模型） | 4.4 决策 2 的**第三条候选路**，V0.1 用 ~50 行验证中文 + 代码混合查询命中率 |
| 加密快照信封格式 `.hlm v1`（XChaCha20-Poly1305 + Argon2id） | Heirloom `docs/design/sync-protocol.md` | 若 V0.2 走"非 git 路径"的加密快照 → 对象存储，直接采用其格式而非自设计 |
| 12 hooks 自动捕获的编排方式 + 可插拔 adapter 的 eval 框架 | agentmemory `eval/`（LongMemEval `_s` 公开 500 题，输出 NDJSON） | **本项目 Q1/Q2 实验 harness 可在此基础上改造**，省数周 |
| 竞品对比表的维度选择与脚注规范 | agentmemory README.zh-CN `#vs-competitors`；Heirloom README 对比表 | 本项目 README 定位表；注意其脚注做法（声明哪些数字是自报未复现）——**这是可信度的关键，应照抄该习惯** |

**明确不碰**：Basic Memory 源码（AGPL-3.0，只体验不读码）；任何 Supermemory 引擎实现（源码非公开，且 lite 许可限制）。

**明确自写（构成产品本体）**：Unified Session Schema、加工 prompt 流水线、MD 渲染与 frontmatter 契约、FTS5 索引与一致性协议、MCP 工具面与 description、context 导出器。合计预估 3–5k 行——这是"差异化只押一个楔子"后剩下的真实工作量。

### 4.9 同步后端抽象与非开发者用户群（v1.3 新增）

> 本节定策略；接口签名、CLI 规格与验收标准见配套文档 **`omem-V0.1技术规格草案.md`**（§4 同步契约、§5 setup 注册表、§6 CLI、§8 技术栈决断）。
> 用户已决断：**不做 GUI，同步收敛为一条命令 `omem sync`**；两笔接口税立即付，实现延后至战略结论稳定后。

#### 4.9.1 同步：一个接口，三种后端（V0.1 只交付第一种）

```rust
trait SyncBackend {
    fn id(&self) -> &str;                      // "git" | "webdav" | "dir"
    fn push(&self) -> Result<SyncReport>;      // 上传差异
    fn pull(&self) -> Result<Vec<Conflict>>;   // 拉取并报告冲突（不自动合并）
    fn status(&self) -> Result<SyncStatus>;    // 上次同步时间 / 待推送条数
}
```

| 后端 | 版本 | 实现要点 | 覆盖人群 |
|---|---|---|---|
| **GitBackend** | V0.1 | `git add -A && commit && push` 封装；唯一自带版本历史与 diff 审计的后端 | 开发者（默认） |
| **WebDavBackend** | V0.2 | HTTP `PROPFIND` + `PUT`；面向坚果云 / Nextcloud / 自家 NAS。**WebDAV 无版本历史**，需在远端维护滚动快照目录（`snapshots/YYYY-MM-DD/`，保留最近 7 份） | **非开发者的主路径**（国内坚果云有免费额度，门槛远低于 git） |
| **LocalDirBackend** | V0.2 | 指向一个目录（Syncthing 同步文件夹 / U 盘挂载点 / OneDrive·iCloud 目录）；实现近乎 `cp -r` + manifest 校验，成本最低 | 有多台自有设备、不信任云端的用户 |

**一个设计红利值得写进 README**：md 事实源使冲突**天然可控**——一条记忆一个文件，两台机器改同一条的概率极低；真冲突时另存 `.conflict.md` 交给人读即可，无需写合并算法。Heirloom 的整体 SQLite 快照一旦冲突就是整库冲突，所以它必须自造 `.hlm` 合并协议（1.6 已提）；我们不需要。

**优先级**：git（V0.1）→ **WebDAV（V0.2 优先于本地目录）**，因为 WebDAV 同时是非开发者唯一现实的同步路径 → 本地目录（V0.2 顺带，成本近乎为零）。

#### 4.9.2 非开发者（WorkBuddy / 千问办公 / Codex 桌面端用户）：V0.1 明确排除

这是 v1.0 第 3 章已标记 P0 的"目标用户内在矛盾"——全领域叙事吸引非开发者，而 git + CLI 交付只适合开发者。**此处给出决断：V0.1 只服务"使用两个及以上 Agent 的开发者"；非开发者 V0.2 低价试探，V0.3 决定去留。**

三条理由：

1. **非开发者的增量价值显著更低。** 本产品的核心痛点是"跨工具失忆"。开发者同时用 Claude Code / Cursor / Codex / WorkBuddy，切换即失忆，痛感强且高频。非开发者通常只用一款桌面产品，而**该产品自带记忆层且零配置**——我们相对它的增量接近于零。这是必须诚实面对的事实。
2. **非开发者无法参与价值验证。** Q1（抽取通过率）与 Q2（盲测）依赖评审者判断"这条记忆抽得对不对、有没有用"；开发者对自身会话的判断力与数据密度都更高。V0.1 让非开发者进入只会污染信号（G2 闸门会因此失真）。
3. **非开发者的门槛在安装与同步，不在 MCP。** 桌面端产品多已开放 MCP server 配置（WorkBuddy 可写 `~/.workbuddy/mcp.json`），所以"接得上"不是瓶颈；"装得上、同步得了"才是——而这需要 GUI 安装包，是极窄 MVP 不可承受的成本。

**但两笔接口税必须现在就付（合计 <1 天）：**

| 税 | 做什么 | 为什么现在做 |
|---|---|---|
| **SyncBackend 抽象** | 4.9.1 的 trait，而非硬编码 git 命令 | 否则 V0.2 加 WebDAV 要动 CLI、状态查询、冲突处理三处，返工成本数倍 |
| **安装入口预留** | `omem setup --client workbuddy\|cursor\|claude-code\|...` 自动写入对应 MCP 配置 | 让"一键接入"从第一天就是一等公民；这是**非开发者唯一可承受的接入形态**，且对开发者同样有用 |

**V0.2 的低价试探（不做 GUI）**：为 2–3 个桌面端产品提供接入脚本 + WebDAV 同步引导（坚果云图文步骤）。判定条件：若 beta 中非开发者占比 ≥30% 且 7 日留存不低于开发者组，则在 V0.3 立项 Tauri 桌面壳（约 2 周）；占比 <15% 或留存显著更差，**永不立项**。

**前置事实待核（写进路线图的前提条件）**：目标桌面产品是否开放 MCP server 配置、是否允许第三方记忆层写入、是否提供会话导出。WorkBuddy 支持；千问办公等需逐一核实。**若某产品既不支持 MCP 也不导出会话，其用户不属于本产品可服务范围**——路线图必须明确写出这条排除规则，避免对触达不到的人群做承诺。

---

## 5. 对规划文档的修订清单（章节级）

| 章节 | 动作 | 要点 |
|---|---|---|
| 1.1 定位 | 改 | "个人级 + git 原生"入句；"全领域"降为愿景 |
| 1.4/1.5 | 增 | 领域优先级排序；反定位清单 |
| 2.1 盘点表 | 重写 | 补 Supermemory/Heirloom/Glia/Kept/MemoryPlugin；分四类 |
| 2.4 定位图 | 重绘 | 改为"管理层级 × scope"二维；如实反映拥挤度 |
| 2.5 | 增 | 价值假设矩阵；平台方监控清单 |
| 3.1 目标用户 | 改 | 早期用户限定为开发者/高级知识工作者；桌面 GUI 后置 |
| 3.3/3.4 | 增 | 场景优先级评分；禁区与信任三件套 |
| 4.7 | 增 | 索引一致性协议 |
| 4.5 零部署 | 改 | 加安装验收标准（≤10 分钟首次检索） |
| 5 架构图 | 改 | 加评估层；采集层③改为"网页会话导入（导出/API/扩展）" |
| 5.1 工具集 | 改 | search 加 scope 过滤；save 幂等；增 memory_feedback；list/delete 移 CLI |
| 5 服务层 | 增 | `omem audit` 使用日志；`omem context --for` 导出器 |
| 6 选型表 | 改 | 加检索栈小节（FTS5 trigram + fts5 可用性验证）；embedding 决策表；加工模型分级；模型分发说明 |
| 7 路线图 | 重写 | 改为验证闸门制三段（V0.1 验证→V0.2 公测→V0.3 生态化）；开源提前至 W9–10；Phase 1 拆分；审查 UI 永不立项 |
| 8 风险表 | 增补 | +记忆投毒/提示注入、+平台方收编、+公司设备合规（work profile）、+维护者倦怠；+数据丢失（快照） |
| 9 指标 | 重写 | 分三层（验证层/自用层/公测层）；加维护分钟数、误入库率、敏感泄漏数；加 kill criteria |
| 10.1 | 增 | MemoryBench、Kept API 文档、Claude Code memory 官方文档 |
| 附录 Q6 | 升级 | 标准化列为 V0.3 战略选项（先产品后标准） |

---

## 6. 结语

这份规划的书房功底（竞品对照、组件复用分级、取舍自觉）高于同类个人项目规划的平均水平，问题不在思考质量，而在**两个结构性偏移**：把"市场空白"当成了"已被验证的机会"，把"功能完整"当成了"价值成立"。

2026-10 的事实是：赛道已验证（十个以上项目涌入）、空白已收窄（只剩 git 原生个人记忆 + 技能蒸馏一个楔子）、平台正在从底部逼近（Claude Code auto memory）。此时正确的动作不是加速，而是**收窄**：把四要素叙事收敛为一个楔子，把四阶段路线图改成了三道闸门，把"全领域加工 + 混合检索 + 同步 + UI"的大爆炸，换成"单工具采集 → 蒸馏 → 跨 Agent 检索能否打赢基线"的一个实验。

如果 Q1/Q2 通过——这个项目值得做 12 个月，而且 git 原生这个选择会让它在竞品云同步商业模式面前保持独特的肋生。如果 Q2 不过，那么省下的不仅是工程量，还有一整年。

**建议的下一步（本周即可启动）**：① 安装 agentmemory + hstry 各体验一天并记录；② 用 20 个自己的真实会话跑 Q1 盲评（写 3 版 prompt，约 2 天）；③ FTS5/trigram 中文检索 spike（半天）。三件事合计不超过一周，即可拿到 G1 与 Q1 的初步答案。
