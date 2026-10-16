// 档 2：Agent 协作批量加工（规格 §9.4——"借本地 agent 能力"的真正落地方式）。
// omem 不做推理，只打印引导 + 会话摘录；Agent 提炼后通过 save_memory / omem add 回写。
import { truncate } from '../core/util.js';
import type { SessionDigest } from '../collect/types.js';

export function printGuide(digests: SessionDigest[], maxChars = 600): void {
  const total = digests.reduce((n, d) => n + d.messages.length, 0);
  console.log('## omem batch processing guide (tier 2: Agent collaboration, zero config)');
  console.log('');
  console.log(`Below are excerpts from ${digests.length} sessions, ${total} messages in total. Distill entries worth remembering long-term, session by session:`);
  console.log('- Types: preference / fact / decision / experience; 3-10 sentences per entry, one item per entry');
  console.log('- Store conclusions, discard process; do not fabricate information that did not appear; mark imperative tone as low weight');
  console.log('- For each entry, call the MCP tool save_memory(content, type, domain, tags), or the CLI: omem add "<content>"');
  console.log('- omem handles dedup, organization, and indexing; no need to worry about duplicate writes');
  console.log('');
  for (const d of digests) {
    console.log(`### Session ${d.session_id} (project ${d.project_fp}, ${d.messages.length} messages)`);
    for (const m of d.messages.slice(0, 40)) {
      console.log(`[${m.role}] ${truncate(m.content, maxChars)}`);
    }
    if (d.messages.length > 40) console.log(`…${d.messages.length - 40} more messages not shown`);
    console.log('');
  }
}
