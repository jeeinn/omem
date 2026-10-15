// WorkBuddy 会话只读解析。
// 目录形态与 Claude Code 相同（projects/<encoded-cwd>/<session>.jsonl），行格式不同：
// type=message，role 在顶层，正文是 input_text / output_text。
// 已注册进采集器。`omem run` 只读扫描，不改会话文件。
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveProjectFp } from './claude-code.js';
import type { SessionDigest, UnifiedMessage } from './types.js';

const TEXT_PARTS = new Set(['input_text', 'output_text', 'text']);

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && TEXT_PARTS.has(b.type) && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim();
}

/** 解析单个 WorkBuddy JSONL。reasoning / function_call / 快照等不进入消息。 */
export function parseWorkbuddyFile(path: string): SessionDigest | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const sessionId = basename(path, '.jsonl');
  const messages: UnifiedMessage[] = [];
  let projectFp = 'unknown';
  let cwd: string | undefined;
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
    if (j.type !== 'message') continue;
    if (j.isSidechain === true) continue;
    const role = j.role === 'user' ? 'user' : j.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const content = extractText(j.content);
    if (!content) continue;
    if (j.cwd) cwd = j.cwd;
    if (cwd && projectFp === 'unknown') projectFp = resolveProjectFp(cwd);
    messages.push({
      session_id: j.sessionId ?? sessionId,
      agent: 'workbuddy',
      ts: typeof j.timestamp === 'string' ? j.timestamp : new Date().toISOString(),
      project_fp: projectFp,
      role,
      content,
      msg_uuid: typeof j.id === 'string' && j.id ? j.id : `${sessionId}#${i}`,
      cwd: j.cwd,
    });
  }
  if (messages.length === 0) return null;
  return {
    session_id: sessionId,
    agent: 'workbuddy',
    project_fp: projectFp,
    cwd,
    started_ts: messages[0].ts,
    ended_ts: messages[messages.length - 1].ts,
    messages,
  };
}
