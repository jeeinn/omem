// 千问办公（QwenWork）会话只读采集器。
// 目录形态与 Claude Code 相同：~/.qwenworkcn/projects/<encoded-cwd>/<session-id>.jsonl（非递归，同名 <id>/ 子目录是状态/附件，不进列表）。
// 行格式同为 type=user|assistant + message.content（string 或 text/thinking/tool_use/tool_result 块数组），
// 其余行类型（active-leaf / last-prompt / runtime-config / workspace-directories / worktree-state / attachment / file-history-snapshot）
// 因 role 为空天然被过滤。isSidechain 子代理不采集。
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveProjectFp } from './claude-code.js';
import { stripHarness } from './dialogue.js';
import type { SessionDigest, UnifiedMessage } from './types.js';

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text as string)
      .join('\n');
  }
  return '';
}

/** 解析单个 QwenWork JSONL。thinking / tool_use / tool_result 块与子代理不进入消息。 */
export function parseQwenworkFile(path: string): SessionDigest | null {
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
      continue; // 容忍截断/损坏行
    }
    if (j.isSidechain === true) continue;
    const role = j.type === 'user' ? 'user' : j.type === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const content = stripHarness(extractText(j.message?.content)).trim();
    if (!content) continue;
    if (j.cwd) cwd = j.cwd;
    if (cwd && projectFp === 'unknown') projectFp = resolveProjectFp(cwd);
    messages.push({
      session_id: j.sessionId ?? sessionId,
      agent: 'qwenwork',
      ts: typeof j.timestamp === 'string' ? j.timestamp : new Date(0).toISOString(),
      project_fp: projectFp,
      role,
      content,
      msg_uuid: typeof j.uuid === 'string' && j.uuid ? j.uuid : `${sessionId}#${i}`,
      cwd: j.cwd,
      git_branch: j.gitBranch,
    });
  }
  if (messages.length === 0) return null;
  return {
    session_id: sessionId,
    agent: 'qwenwork',
    project_fp: projectFp,
    cwd,
    started_ts: messages[0].ts,
    ended_ts: messages[messages.length - 1].ts,
    messages,
  };
}
