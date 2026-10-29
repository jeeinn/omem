# omem 发布记录

> 每个版本一行：tag / commit / tarball md5 / 口径变更。**md5 由 `node scripts/release-check.mjs --tarball=<file>` 打印**，不手算。
> 发布纪律：`package.json.version` 未 bump、或与 `git describe --tags --exact-match` 不一致时**禁止 `npm publish`**（`prepublishOnly` 会直接失败）。

| tag | commit | tarball md5 | 备注 |
| --- | --- | --- | --- |
| `v0.1.0-beta.8` | `1da9d52` | — | 清单渲染回归（16.3×）、cap 截断、grounding 元数据可伪证 |
| `v0.1.0-beta.9` | 见 `omem --version` 的 `+<short>` | 待登记 | 见下 |

## v0.1.0-beta.9（正确性止血）

**用户可见变更**

1. **`omem add` 对超长正文改为拒绝（CLI 行为变更）。** 正文超过 `[process] max_content_chars`（默认 2000）时不再静默截断落盘，而是不写入并给出超限量、溢出片段预览与两条出路（压缩到限内重发 / 拆一个更窄的 topic）。要保留旧的截断行为，加 `--force`（截断后落盘，仍是半截事实，只作为逃生口）。
   为什么改：截断落在尾部，而新事实总在尾部 —— 1,990 字文档追加 73 字，落盘的是一句 `99. 新增事实：…`，关键内容消失，而它是新的 `active` 文档。半截事实会被下一个 Agent 当真事实检索、继续 supersede。
2. **`save_memory` 同理：超限拒绝，不再截断。** 回执四段：超限字数 / 旧文档仍 `active` 且未被改动 / 溢出片段预览（仅回执可见，不落盘）/ 两个出口。
3. **supersede 掉一份 verified 文档时，回执写明代价**：旧的 `confidence` 数值与旧 id 都出现在回执里（此前一个字都不提）。
4. **`PROCESS.md` 瘦身**：会话行不再带绝对路径（占旧体积 50.7%），`## Existing topics` 全量列出（含 id），头部与工具描述去重；渲染有 30,000 字节预算，超限按固定阶梯降级并在被隐藏的组上显式标注。**行数不减**——瘦的是冗余，不是待办。
5. **`search_memory` 新增 `session_id` / `offset` / `limit`**（不新增工具，不开第二个入口）：按清单里的裸 id 直接取回 `## user` 段的可复制原文 + 每段字符范围 + assistant 段计数（不进正文）。这是清单去掉路径之后的唯一读取通道。
6. **`(copies: N)` → `(same-user-text: N)`，并修掉文案里的错误承诺。** 同一 `## user` 指纹的 N 份会话只共享**用户说的话**，各自的回答不同（实测 25/26 组 assistant 段实质不同）；原文案说「提炼列出的那一份就覆盖全部」，按它操作最多静默丢 24 份独立结论。
7. **`omem --version` 带 short commit**（`0.1.0-beta.9+1a2b3c4`），`prepublishOnly` 增加版本/tag 一致性与打包内容断言。

**数字会变难看，但变真**：`N unabsorbed` 这个数会变大。此前「已吸收指纹」会把同指纹兄弟组的其余 N−1 份一起移出待办（最多 ≤143 份从未被读取就被标记为已处理）；现在它们仍留在待办里，折进同一行、`same-user-text` 递增，不新增行。

**验证口径**：`npm test` 全绿；`node scripts/release-check.mjs` 在打 tag 后通过；PROCESS.md `Read` 一次读完且 `≤30,000 B`。
