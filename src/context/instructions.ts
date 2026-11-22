// Agent 侧的行为指令文本：MCP `initialize.instructions` 与 `omem context --for` 共用一套规则句。
//
// 为什么需要这个模块：`save_memory` 的描述里写着「先从 omem instructions 读 PROCESS.md 路径」，
// 但 MCP 的 InitializeResult 原本没有 instructions 字段（`mcp/server.ts` 只声明了 capabilities），
// 于是不走 `omem context` 的纯 MCP 客户端会去找一个拿不到的东西。
//
// 两条最容易被改漂的规则（evidence 门槛、置信度来源）抽成常量，供
// `context/export.ts` 的 marker 段与这里的 MCP 文本共用。
import { dirs, files } from '../core/paths.js';

export const RULE_EVIDENCE =
  '`evidence` must be one or more quotes of at least 12 consecutive characters copied from a `## user` section of that session; assistant text does not count';

export const RULE_CONFIDENCE =
  '`confidence` is the only trust number: 0.35 ungrounded, 0.55 anchored to a quoted `## user` line, up to 0.80 with independent corroboration; 0.90 is reserved for a human review (`omem review --confirm`, or the opt-in `memory_feedback` tool) — never write 0.90 yourself';

/** 多跳检索：评测 tests/eval/search-capability.json 的 mh-* 用例量化了「拆开命中、合起来零命中」。 */
export const RULE_MULTIHOP =
  'For multi-hop questions, search one subquestion at a time and feed each hit into the next query — keywords are AND-matched, so one combined query returns nothing. For past values, use `as_of` on the same query.';

/**
 * MCP `initialize.instructions` 正文。
 * 长度控制在 2KB 以内：部分客户端会截断或拒收过长的 instructions。
 */
export function mcpInstructions(home: string): string {
  const guide = files.processGuide(home);
  const knowledge = dirs.knowledge(home);
  return [
    `omem: git-native memory; Markdown under ${knowledge} is the source of truth (index is derived).`,
    '',
    'Work loop (organise memories):',
    `1. Read ${guide}: project groups, existing topics, bare session ids not yet absorbed (no paths).`,
    '2. `search_memory(scope="sessions", session_id="<id>")` returns that transcript\'s `## user` text with offsets. Assistant text is never evidence.',
    '3. Topic = document name. Reuse an existing topic; for a new one use a short lowercase slug (e.g. "knee-rehab"). Never coin a second name for the same subject.',
    '4. `save_memory` needs `topic` (always), the bare `session_id` (no collector prefix), and evidence quoted from step 2. Writing an existing topic overwrites it; git keeps the old version.',
    '5. Read the response: it reports topic, created/updated, whether evidence anchored, length rejection and topic collisions. Fix and rewrite — do not retry blindly.',
    '6. Report what you wrote (topic, confidence). Never ask the user to "confirm" — only `omem review` does.',
    '',
    `Retrieving: ${RULE_MULTIHOP}`,
    '',
    `Hard: no near-duplicates; never delete; this conversation is not a memory; each write makes one local git commit (push = omem backup). ${RULE_CONFIDENCE}`,
    '',
    `Grounding: ${RULE_EVIDENCE}. An unmatched quote makes the entry 0.35 \`ungrounded\` — check the response.`,
    '',
    'Correction: rewrite the same topic with corrected content and tell the user; never silently edit files.',
  ].join('\n');
}
