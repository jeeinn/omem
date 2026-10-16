// 档 2：把待加工会话写成 PROCESS.md，并打印同一份引导。omem 不调用模型。
import { statSync } from 'node:fs';
import { files } from '../core/paths.js';
import { atomicWrite } from '../core/util.js';

export interface GuideRelated {
  id: string;
  title: string;
}

export interface GuideSession {
  path: string;
  sessionId: string;
  agent: string;
  project: string;
  related: GuideRelated[];
}

const BATCH = 5;
const LONG_BYTES = 100 * 1024;

export function renderGuide(batch: GuideSession[], remaining: number): string {
  const lines: string[] = [
    '# omem sessions waiting for distillation',
    '',
    'These sessions have no conclusion entries yet (at most 5 in this batch). Read each file, in parts if it is long, and write back only what is worth remembering.',
    '- Types: preference / fact / decision / experience. One conclusion per entry.',
    '- Keep the conclusion, drop the process. Do not invent anything that was not said.',
    '- `evidence` must be at least 12 characters copied from a `## user` section of that file. Do not quote `## assistant`.',
    '- Call `save_memory` with `session_id`, `evidence`, and `type`. If the new conclusion replaces one listed below, pass `supersedes`. Without it, both stay active.',
    '- After writing, ask once: confirm all, confirm some, or leave them. If the user agrees, call `save_memory` with only `confirm_ids`. That raises confidence to 0.8 and does not set verified.',
    '- `verified: true` comes only from `omem add` or `omem review --confirm <id>`.',
    '',
  ];
  if (batch.length === 0) {
    lines.push('No sessions are waiting.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push(`This batch: ${batch.length}. ${remaining} left for the next \`omem run\`.`);
  lines.push('');
  for (const s of batch) {
    let bytes = 0;
    try {
      bytes = statSync(s.path).size;
    } catch { /* 刚写入时读不到长度就略过提示 */ }
    lines.push(`## ${s.agent} / ${s.sessionId}`);
    lines.push(`- File: \`${s.path}\``);
    lines.push(`- project: \`${s.project}\``);
    if (bytes > LONG_BYTES) lines.push('- This file is long. Read it in parts; do not paste it back into the chat.');
    if (s.related.length === 0) {
      lines.push('- Active conclusions in scope: none');
    } else {
      lines.push('- Active conclusions in scope (pass the id via supersedes when the new one replaces it):');
      for (const r of s.related) lines.push(`  - \`${r.id}\` ${r.title}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeProcessGuide(home: string, text: string): string {
  const path = files.processGuide(home);
  atomicWrite(path, text);
  return path;
}

export { BATCH as GUIDE_BATCH };
