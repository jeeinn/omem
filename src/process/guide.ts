// 档 2：把待加工主题写成 PROCESS.md，并打印同一份引导。omem 不调用模型。
import { statSync } from 'node:fs';
import { files } from '../core/paths.js';
import { atomicWrite } from '../core/util.js';

export interface GuideSessionRef {
  path: string;
  sessionId: string;
  agent: string;
}

export interface GuideTopic {
  topic: string;
  docId?: string;
  docTitle?: string;
  /** 这一组里除默认文档外还有几份活文档（一个项目可以拆多个 topic）。 */
  otherDocs?: number;
  sessions: GuideSessionRef[];
}

const BATCH = 5;
const LONG_BYTES = 100 * 1024;

export function renderGuide(topics: GuideTopic[], remaining: number, unassigned: GuideSessionRef[] = []): string {
  const lines: string[] = [
    '# omem topics waiting for an update',
    '',
    'Each topic has one living document. A new session updates that document; pass supersedes so the previous version stays on disk but drops out of search.',
    '- Read the session files. Keep short facts, drop the process. Do not invent anything that was not said.',
    '- `evidence` must be at least 12 characters copied from a `## user` section. Do not quote `## assistant`.',
    '- Call `save_memory` with `topic`, `session_id`, and `evidence`. If a current document id is listed, `supersedes` must include it or the write is rejected.',
    '- Organizing this file is not a life event. Do not save this distillation chat as a new topic.',
    '- After writing, ask once: confirm all, confirm some, or leave them. `confirm_ids` raises confidence to 0.8 and does not set verified.',
    '- `verified: true` comes only from `omem add` or `omem review --confirm`.',
    '',
  ];
  if (topics.length === 0 && unassigned.length === 0) {
    lines.push('No topics are waiting.');
    lines.push('');
    return lines.join('\n');
  }
  if (topics.length > 0) {
    lines.push(`This batch: ${topics.length} topic(s). ${remaining} left for the next \`omem run\`.`);
    lines.push('');
  }
  for (const topic of topics) {
    lines.push(`## ${topic.topic}`);
    if (topic.docId) {
      const more = topic.otherDocs && topic.otherDocs > 0
        ? ` · ${topic.otherDocs} more living document(s) in this group; update the one matching the new session's topic`
        : '';
      lines.push(`- Current document: \`${topic.docId}\`${topic.docTitle ? ` ${topic.docTitle}` : ''}${more}`);
    } else {
      lines.push('- Current document: none. Project grouping is not a topic. Pass an explicit topic only if these sessions should share one living document.');
    }
    lines.push('- Sessions not yet absorbed:');
    for (const s of topic.sessions) {
      let note = '';
      try {
        if (statSync(s.path).size > LONG_BYTES) note = ' (long; read in parts)';
      } catch { /* 刚写入时读不到长度就略过 */ }
      lines.push(`  - \`${s.agent}\` / \`${s.sessionId}\` \`${s.path}\`${note}`);
    }
    lines.push('');
  }
  if (unassigned.length > 0) {
    lines.push('## Unassigned sessions');
    lines.push('These have no project fingerprint. Name a topic when you save, and pass `session_id`.');
    for (const s of unassigned) lines.push(`- \`${s.agent}\` / \`${s.sessionId}\` \`${s.path}\``);
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
