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
    `1. Read ${guide} — it lists each project group, the topics that already exist, and the bare session ids not yet absorbed (no file paths).`,
    '2. Read a transcript by id: `search_memory(scope="sessions", session_id="<id>")` returns its `## user` text with character offsets; assistant text is never returned as evidence.',
    '3. The topic is also the document name. To update a subject, reuse its topic; to start a new one, pick a short lowercase name (e.g. "knee-rehab"). Never invent a second name for the same subject.',
    '4. `save_memory` needs `topic` (always), `session_id` copied as the bare id (no collector prefix), and evidence quoted from the `## user` text returned in step 2. Writing to an existing topic overwrites that document; git keeps the previous version.',
    '5. Read the response before assuming success: it reports the topic, whether the document was created or updated, whether the evidence anchored, whether the content was rejected for length, and any topic collisions. Fix and rewrite instead of retrying blindly.',
    '6. Say what you wrote and where it landed (topic, confidence). Do not ask the user to "confirm" it for the record — you have no way to record a confirmation, and a human review in `omem review` is the only path to 0.9.',
    '',
    `Hard rules: one document per topic — reuse an existing topic name instead of coining a near-duplicate; never delete; the conversation that organises PROCESS.md is not itself a memory; each write leaves one local git commit when the store is a git repo (pushing is omem backup); (${RULE_CONFIDENCE}).`,
    '',
    `Grounding: ${RULE_EVIDENCE}. A quote that cannot be matched drops the entry to confidence 0.35 and tags it \`ungrounded\`, so check the response line rather than assuming success.`,
    '',
    'Correction channel: if a memory you retrieved turns out to be wrong, rewrite that same topic with the corrected content and tell the user, so they can review it. Do not silently edit the file.',
  ].join('\n');
}
