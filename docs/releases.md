# omem 发布记录

> 每个版本一行：tag / commit / dist 内容 hash / 口径变更。tarball 字节 md5 因含打包时间戳不可复现，**确定性判据是 `node scripts/release-check.mjs` 的 `distProblems`（dist 与 src 一一对应、无孤儿）**；`--tarball` 仅用于打印信息，不可作为一致性校验。
> 发布纪律：`package.json.version` 未 bump、或与 `git describe --tags --exact-match` 不一致时**禁止 `npm publish`**（`prepublishOnly` 会直接失败）。

| tag | commit | tarball md5 | 备注 |
| --- | --- | --- | --- |
| `v0.1.0-beta.8` | `1da9d52` | — | 清单渲染回归（16.3×）、cap 截断、grounding 元数据可伪证 |
| `v0.1.0-beta.9` | `a260812` | `4b824b0a1e1ef392106fa99b10f11bcb`（两次干净构建 dist 内容 hash 一致） | 见下 |

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
