// Agent 侧的行为指令文本：MCP `initialize.instructions` 与 `omem context --for` 共用一套规则句。
//
// 为什么需要这个模块：`save_memory` 的描述里写着「先从 omem instructions 读 PROCESS.md 路径」，
// 但 MCP 的 InitializeResult 原本没有 instructions 字段（`mcp/server.ts` 只声明了 capabilities），
// 于是不走 `omem context` 的纯 MCP 客户端会去找一个拿不到的东西。
//
// 两条最容易被改漂的规则（evidence 门槛、verified 来源）抽成常量，供
// `context/export.ts` 的 marker 段与这里的 MCP 文本共用。
import { dirs, files } from '../core/paths.js';

export const RULE_EVIDENCE =
  '`evidence` must be one or more quotes of at least 12 consecutive characters copied from a `## user` section of that session; assistant text does not count';

export const RULE_VERIFIED =
  '`verified: true` comes only from `omem add` or `omem review --confirm` — MCP never sets it';

/**
 * MCP `initialize.instructions` 正文。
 * 长度控制在 2KB 以内：部分客户端会截断或拒收过长的 instructions。
 */
export function mcpInstructions(home: string): string {
  const guide = files.processGuide(home);
  const knowledge = dirs.knowledge(home);
  return [
    `omem is the user's git-native memory store. Markdown under ${knowledge} is the source of truth; the index is derived.`,
    '',
    'Work loop when the user asks you to organise or update memories:',
    `1. Read ${guide} — it lists topics and session files not yet absorbed, plus the id of each topic's current document.`,
    '2. Before updating a topic, get its active document id: `search_memory(topic="<name>")`, or read the "Current document" line in PROCESS.md.',
    '3. `save_memory` with that `topic`, that id in `supersedes`, `session_id` copied as the bare id (no collector prefix), and evidence from the session file.',
    '4. Read the response before assuming success: it reports the new id, the superseded ids, whether the evidence anchored, whether the content was truncated, and any topic collisions. Fix and rewrite instead of retrying blindly.',
    '5. Ask once whether to confirm what you wrote. `confirm_ids` raises confidence to the automatic cap and never sets verified.',
    '',
    `Hard rules: one active document per topic — reuse an existing topic name instead of coining a near-duplicate; never delete, supersede; the conversation that organises PROCESS.md is not itself a memory; this server never creates a git commit (${RULE_VERIFIED}).`,
    '',
    `Grounding: ${RULE_EVIDENCE}. A quote that cannot be matched drops the entry to confidence 0.35 and tags it \`ungrounded\`, so check the response line rather than assuming success.`,
    '',
    'Correction channel: if a memory you retrieved turns out to be wrong, supersede it with the corrected content and tell the user, so they can review it. Do not silently edit the file.',
  ].join('\n');
}
