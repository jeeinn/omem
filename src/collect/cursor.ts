// Cursor agent transcript 只读解析。
// 路径：~/.cursor/projects/<id>/agent-transcripts/<uuid>/<uuid>.jsonl
// 行格式是 { role, message: { content: [{ type: "text"|"tool_use", ... }] } }，没有 Claude Code 的 type 字段。
// 只读。子 agent 目录 subagents/ 不采集。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SessionFile } from './claude-code.js';
import { stripHarness } from './dialogue.js';
import type { SessionDigest, UnifiedMessage } from './types.js';

/** 只列主会话 `<project>/agent-transcripts/<id>/<id>.jsonl`，跳过 subagents。 */
export function listCursorTranscripts(root: string, opts: { since?: Date } = {}): SessionFile[] {
  if (!existsSync(root)) return [];
  const out: SessionFile[] = [];
  for (const proj of readdirSync(root)) {
    const transcripts = join(root, proj, 'agent-transcripts');
    if (!existsSync(transcripts)) continue;
    let ids: string[];
    try {
      ids = readdirSync(transcripts);
    } catch {
      continue;
    }
    for (const id of ids) {
      const path = join(transcripts, id, `${id}.jsonl`);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (opts.since && st.mtimeMs < opts.since.getTime()) continue;
      out.push({ path, sessionId: id, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim();
}

/** 解析单个 Cursor transcript。tool_use 不进入消息。 */
export function parseCursorTranscript(path: string): SessionDigest | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const sessionId = basename(path, '.jsonl');
  const messages: UnifiedMessage[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const role = j.role === 'user' || j.role === 'assistant' ? j.role : null;
    if (!role) continue;
    const content = stripHarness(extractText(j.message?.content ?? j.content));
    if (!content) continue;
    messages.push({
      session_id: sessionId,
      agent: 'cursor',
      ts: typeof j.timestamp === 'string' ? j.timestamp : new Date(0).toISOString(),
      project_fp: 'unknown',
      role,
      content,
      msg_uuid: `${sessionId}#${i}`,
    });
  }
  if (messages.length === 0) return null;
  return {
    session_id: sessionId,
    agent: 'cursor',
    project_fp: 'unknown',
    started_ts: messages[0].ts,
    ended_ts: messages[messages.length - 1].ts,
    messages,
  };
}
