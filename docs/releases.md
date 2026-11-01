# omem 发布记录

> 每个版本一行：tag / commit / dist 内容 hash / 口径变更。tarball 字节 md5 因含打包时间戳不可复现，**确定性判据是 `node scripts/release-check.mjs` 的 `distProblems`（dist 与 src 一一对应、无孤儿）**；`--tarball` 仅用于打印信息，不可作为一致性校验。
> 发布纪律：`package.json.version` 未 bump、或与 `git describe --tags --exact-match` 不一致时**禁止 `npm publish`**（`prepublishOnly` 会直接失败）。

| tag | commit | tarball md5 | 备注 |
| --- | --- | --- | --- |
| `v0.1.0-beta.8` | `1da9d52` | — | 清单渲染回归（16.3×）、cap 截断、grounding 元数据可伪证 |
| `v0.1.0-beta.9` | `a260812` | `4b824b0a1e1ef392106fa99b10f11bcb`（两次干净构建 dist 内容 hash 一致） | 见下 |
| `v0.2.0-beta.1` | 见 tag | — | 重构路B：topic 即身份、去 SQLite、命令面 13 条（**不兼容**） |

## v0.2.0-beta.1（重构路B：身份收口 + 去数据库 + 命令面收敛）

**不兼容**：v0.1 的库直接 `omem init --force` 重来（重置 git 前自动打一份快照），**没有迁移脚本**。理由：这一版的目标是把项目变小，搬迁脚本会把旧模型原样搬进新模型。

**用户可见变更**

1. **topic 就是身份，就是文件名。** 路径改成 `knowledge/<domain>/<topic>.md`，frontmatter 里不再写 topic。删掉 `id` 命名空间、年份分桶、`superseded` 状态机与 `supersedes` 入参；`omem add` 与 `save_memory` 的 `topic` 变必填（一次性记忆也一样——它只是「只被写过一次的 topic」）。带同一个 topic 再写一次就是整篇覆盖那份文件，版本链交给 git。
2. **没有索引数据库。** SQLite / FTS5 删除，索引是每次启动从 Markdown 重建的内存视图（`Map<topic, row>`）。会话只索引 `## user` 证据域、按需构建；检索从「SQLite + bm25」换成线性扫描 + 确定性排序（命中词数 → 置信度 → `last_confirmed`）。一并删掉 WAL、跨进程锁、迁移脚本与双 hash 对账。实测：1100 份会话冷启动 `stat` 131 ms、证据域全量扫描 1.4 ms、检索 1–2 ms。
3. **信任只有一个数字。** `verified` 字段删除（D2）：原地更新下它会退化成「这个主题曾被人看过」，而信任只该描述当前这份正文。过目改由 `confirmations > 0` + `last_confirmed` 表达。`save_memory` 的 `confirm_ids` 一并删除（A5）——MCP 侧不再有盖章通道，过目只由人在 `omem review` 里做（提到 0.9）。
4. **命令面收敛到 13 条。** 删 `eval` / `api` / `audit` / `context` / `gc` / `snapshot` / 主题级审阅策略；`rebuild` → `verify`；`gc` 并入 `review --gc`；`snapshot` 并入 `backup`；`redact --id` → `redact --topic`。
5. **`omem verify` 做账本复算。** 重建内存视图 + 重渲染 `MEMORY-INDEX.md`，并用账本重算每条自动分条目、与落盘值比对：只报告差异，不改写（自动改写会在每次 verify 时抖动 git 历史，而且「谁该赢」不是机器能判的）。
6. **`PROCESS.md` 拆两段。** `## Projects` 收待办（按项目指纹分组，组标题降为 `###`），`## Topics` 收词表并带所属项目——两个轴在这里接上，Agent 不再把项目指纹当主题名用。
7. **印证按独立来源计数。** 同一段用户输入被同步两次、或两个采集器收了同一次对话，只算一份（来源会话自己的指纹先占位，所以副本也不算印证）；两次不同的表达里出现同一句引文，仍算两份。
8. **写前快照。** 覆盖一份已有活文档之前自动打快照（`snapshots/`，滚动保留 7 份）；`init --force` 重置 git 前也打一份。git 历史仍是最终退路。
9. **没有 `review.toml`。** 主题级审阅策略（`once` / `never`）删除——它压不住「置信度 ≤0.35 或带 `ungrounded`」的条目，却让「过目」这件事多出一个状态位。人工动作只剩过目 / 归档 / 冷却。

**验证口径**：`npm test` 全绿（69 files / 691 tests）；`npm run build` 干净；`npm run smoke` 75 passed；`node scripts/release-check.mjs` 在打 tag 后通过（dist 与 src 一一对应、无孤儿、包内容精确）。

### v0.2.0-beta.1 补丁轮（beta.1 打 tag 后的真实命令基准测试）

beta.1 打上 tag 之后用真实 `omem` 命令做了一轮端到端基准测试，发现 6 个问题。本轮修完，并把 annotated tag `v0.2.0-beta.1` 移到修复后的提交（**版本号不变**，tag 内容被替换——beta 阶段允许；未 push、未 publish）。

**用户可见变更**

1. **列表型旗标在 Windows 的 PowerShell shim 下不再坏掉。** `--target` / `--collectors` / `--confirm` / `--tags` 原本只按逗号切分。npm 生成的 `omem.ps1` 由 PowerShell 解析，`a,b` 会被当成数组再用**空格**连接传给脚本（`$args` = `"a b"`），于是 `omem install --target claude-code,cursor` 报的是 `Unknown client: claude-code cursor`——错误信息还看不出真实原因。新增 `flagList()`，按 `[,\s]+` 切分，逗号与空格两种壳子都认。
2. **`omem --help` 的文档链接指向实际存在的文件**（`docs/omem-重构方案-路B.md`；原链接指向已归档的 V0.1 规格草案，点了是死链）。
3. **同步后端的文案不再承诺「V0.2 会交付 WebDAV」。** 那是对未交付功能的承诺。当前口径：git 是本版本唯一可用的后端，`webdav` / `dir` 被调用时给出可操作提示（`omem backup use git`）。
4. **启动成本降了一半。** MCP SDK（单独 import 实测 **252 ms**）与 web 面板（**49 ms**）改为按需加载，只有 `omem serve` / `omem review --ui` 才付这份钱。实测 `omem --version` / `omem topics` / `omem review` 从约 490 ms 降到 **230 ms**（node 裸启动 116 ms）。
5. **会话检索的命中计数零分配。** 热路径上的 `split(t).length - 1` 换成 `indexOf` 循环（每次出现不再分配一个子串数组）；排序语义不变，有专门用例钉住「出现次数多的会话仍排前面」。
6. **采集器不再为「明显不是仓库」的目录 fork git 子进程。** cwd 向上找不到 `.git`（含 worktree / submodule 的 `.git` 文件）就直接用本地指纹兜底，判定口径与 git 自己的仓库发现一致。合成语料 1100 份、cwd 分散时，`omem sync` 从 88 s 降到秒级。
7. **`omem review --ui` 的等待提示按真实超时显示**（3 秒超时不再写成 "timeout 1m"）。
8. **`tests/smoke.sh` 在 Windows 检出下也能真跑。** 新增 `.gitattributes`，强制 `*.sh` 与 `bin/omem.js` 以 LF 落盘。此前在 `core.autocrlf=true` 的检出里，脚本第 8 行就死在 CRLF 上（`set -u\r` → "invalid option"），`npm run smoke` 看着 exit 0，实际一行业务都没跑。

**验证口径**：`npm test` 全绿（69 files / 699 tests）；`npm run build` 干净；`npm run smoke` 75 passed；`node scripts/release-check.mjs` 在 tag 移动后通过。

## v0.1.0-beta.9（正确性止血）

**用户可见变更**

1. **`omem add` 对超长正文改为拒绝（CLI 行为变更）。** 正文超过 `[process] max_content_chars`（默认 2000）时不再静默截断落盘，而是不写入并给出超限量、溢出片段预览与两条出路（压缩到限内重发 / 拆一个更窄的 topic）。要保留旧的截断行为，加 `--force`（截断后落盘，仍是半截事实，只作为逃生口）。
   为什么改：截断落在尾部，而新事实总在尾部 —— 1,990 字文档追加 73 字，落盘的是一句 `99. 新增事实：…`，关键内容消失，而它是新的 `active` 文档。半截事实会被下一个 Agent 当真事实检索、继续 supersede。
2. **`save_memory` 同理：超限拒绝，不再截断。** 回执四段：超限字数 / 旧文档仍 `active` 且未被改动 / 溢出片段预览（仅回执可见，不落盘）/ 两个出口。
3. **supersede 掉一份 verified 文档时，回执写明代价**：旧的 `confidence` 数值与旧 id 都出现在回执里（此前一个字都不提）。
4. **`PROCESS.md` 瘦身**：会话行只留裸 `session_id`（不再带绝对路径，也不再带采集器名——两者都不参与后续调用，却占掉一半体积；路径占旧体积 50.7%），`## Existing topics` 全量列出（含 id），头部与工具描述去重。渲染预算 **45,000 B**（判据是宿主 `Read` 的 `字符数÷4 > 20000`，即 ≈80,000 字符才拒；45,000 留 44% 余量），超限按固定阶梯降级，**每个被裁的组都带自己的 `…N session(s) hidden by the size budget` 标记**，`Unassigned sessions` 同样带标记。真实规模（546 会话行 + 58 topic）实测 **0 隐藏**。
5. **`search_memory` 新增 `session_id` / `offset` / `limit`**（不新增工具，不开第二个入口）：按清单里的裸 id 直接取回 `## user` 段的可复制原文 + 每段字符范围 + assistant 段计数（不进正文）。这是清单去掉路径之后的唯一读取通道。
6. **`(copies: N)` → `(same-user-text: N)`，并修掉文案里的错误承诺。** 同一 `## user` 指纹的 N 份会话只共享**用户说的话**，各自的回答不同（实测 25/26 组 assistant 段实质不同）；原文案说「提炼列出的那一份就覆盖全部」，按它操作最多静默丢 24 份独立结论。
7. **每次写入进本地 git 历史（`[process] auto_commit = "session"`，默认开）。** 一次工具调用 / 一次 `omem add` 结束一次提交，提交**精确覆盖本次写过的文件**（由写入台账在 `atomicWrite` 记账，不再退回 `git add -A` 把上千份无关会话卷进来，也不再靠固定路径白名单漏掉 `PROCESS.md` / `review.toml` / `config.toml`）；回执的 `vcs.residue` 如实列出本次写之外的脏路径。会话原文的批量入版本仍由 `omem backup` 负责。**代价**：单次写入多约 **0.3–0.43 s**（1,101 份会话的数据仓实测：0.22 s → 0.50 s 稳态；首次 `omem sync` 后的第一次写入会再慢一点）。不需要版本历史可设 `auto_commit = "off"`。非 git 数据仓静默跳过：写入照常成功，回执里说明原因（`vcs` 字段）。
8. **`omem --version` 带 short commit**（`0.1.0-beta.9+1a2b3c4`），`prepublishOnly` 增加版本/tag 一致性与打包内容断言。
9. **`omem add --force` 的强制截断可审计**：磁盘上不留标记（不加 frontmatter 字段、不加 `tags`），但回执会给出该文件的 id，并把 `truncated:{chars,limit}` 写进 `logs/omem.log` 的 commit 事件——过一周也查得出「这条是被截断的」。
10. **grounding 的证据域扩到整段**：`## user` 段内**任意位置**的 `Conversation info / Sender (untrusted metadata)` 围栏块都会被剥掉（真实仓 22 个非段首围栏全部覆盖），用户自己粘贴的代码/JSON 原样保留。

**数字会变难看，但变真**：`N unabsorbed` 这个数会变大。此前「已吸收指纹」会把同指纹兄弟组的其余 N−1 份一起移出待办（最多 ≤143 份从未被读取就被标记为已处理）；现在它们仍留在待办里，折进同一行、`same-user-text` 递增，不新增行。

**验证口径**：`npm test` 全绿（68 files / 716 tests）；`npm run smoke` 74 passed；`node scripts/release-check.mjs` 在打 tag 后通过（dist 与 src 一一对应、无孤儿、包内容精确）；PROCESS.md `Read` 一次读完（真实 1,101 份会话实测 875 行 / 41,230 B）且 `≤45,000 B`。
