// 豆包办公（Doubao）桌面端会话只读采集器。
// 目录形态（本机 Windows 核实）：<root>/<session_id>/agents/<agent_id>/system/trajectory.jsonl。
// 行格式是 OpenAI messages 风格：{role, content} / {role, content, tool_calls} / {role, tool_call_id, content}，
// 没有 type / timestamp / message 嵌套。role=tool（工具返回）与只调工具没正文的 assistant 行不进消息。
// 同一 session 下多个 agent 目录时只收 mtime 最新的 trajectory：主 agent 轨迹随对话持续追加，
// 子 agent 轨迹写完即停；全收会让同一 session_id 产出多个 digest 互相覆盖 sessions 文件。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { expandHome } from '../core/paths.js';
import type { SessionFile } from './claude-code.js';
import { stripHarness } from './dialogue.js';
import type { SessionDigest, UnifiedMessage } from './types.js';

/** 默认扫描根：Windows 用 %LOCALAPPDATA%/Doubao 实际数据目录；其他平台给占位默认，由环境变量覆盖。 */
export function defaultDoubaoRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OMEM_DOUBAO_PROJECTS) return env.OMEM_DOUBAO_PROJECTS;
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(local, 'Doubao', 'User Data', 'Default', '.doubao', 'agent_mode', 'workspace', '.sessions');
  }
  return expandHome('~/.doubao/sessions');
}

/**
 * 列出豆包会话：<root>/<session_id>/agents/<agent_id>/system/trajectory.jsonl。
 * 同一 session_id 下多个 agent trajectory 只保留 mtime 最新的一个（见文件头注释）。
 */
export function listDoubaoSessions(root: string, opts: { since?: Date } = {}): SessionFile[] {
  if (!existsSync(root)) return [];
  const bySession = new Map<string, SessionFile>();
  let sessionDirs: string[];
  try {
    sessionDirs = readdirSync(root);
  } catch {
    return [];
  }
  for (const sid of sessionDirs) {
    const agentsDir = join(root, sid, 'agents');
    let agentDirs: string[];
    try {
      agentDirs = readdirSync(agentsDir);
    } catch {
      continue;
    }
    for (const agent of agentDirs) {
      const path = join(agentsDir, agent, 'system', 'trajectory.jsonl');
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (opts.since && st.mtimeMs < opts.since.getTime()) continue;
      const existing = bySession.get(sid);
      if (!existing || st.mtimeMs > existing.mtimeMs) {
        bySession.set(sid, { path, sessionId: sid, mtimeMs: st.mtimeMs });
      }
    }
  }
  return [...bySession.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** 路径 .../<sid>/agents/<agent>/system/trajectory.jsonl → <sid>。 */
function sessionIdFromPath(path: string): string {
  return basename(dirname(dirname(dirname(dirname(path)))));
}

/** 解析单个豆包 trajectory。tool 行与无正文的 tool_calls 行不进消息；坏行跳过。 */
export function parseDoubaoFile(path: string): SessionDigest | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const sessionId = sessionIdFromPath(path);
  const messages: UnifiedMessage[] = [];
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
    const role = j.role === 'user' || j.role === 'assistant' ? j.role : null;
    if (!role) continue; // role=tool（工具返回）等行天然过滤
    const raw = typeof j.content === 'string' ? j.content : '';
    const content = stripHarness(raw).trim();
    if (!content) continue; // assistant 纯 tool_calls 行 content 为空
    messages.push({
      session_id: sessionId,
      agent: 'doubao',
      ts: new Date(0).toISOString(), // trajectory 无时间戳：稳定占位，同一文件每次解析结果一致
      project_fp: 'unknown',
      role,
      content,
      msg_uuid: `${sessionId}#${i}`,
    });
  }
  if (messages.length === 0) return null;
  return {
    session_id: sessionId,
    agent: 'doubao',
    project_fp: 'unknown',
    started_ts: messages[0].ts,
    ended_ts: messages[messages.length - 1].ts,
    messages,
  };
}
