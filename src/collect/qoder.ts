// Qoder / Qoder-CN 会话只读采集器。
// 国际版路径：~/.qoder/cache/projects/<project-hash>/conversation-history/<cid>/<cid>.jsonl
// 中文版路径：~/.qoder-cn/cache/projects/<project-hash>/conversation-history/<cid>/<cid>.jsonl
// 行格式：{"role":"user"|"assistant","message":{"content":[{"type":"text","text":"..."}]}}
// 噪声极重：user 消息内嵌 <attached_files>（完整文件内容）、<system-reminder>（UltraPlan 指令）、
// <user_query> 标签。只取 <user_query> 内正文；否则剥掉 attached_files / system-reminder / file 块。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from '../core/paths.js';
import type { SessionFile } from './claude-code.js';
import type { SessionDigest, UnifiedMessage } from './types.js';

/** 国际版默认根。 */
export function defaultQoderRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMEM_QODER_PROJECTS ?? expandHome('~/.qoder');
}

/** 中文版默认根。 */
export function defaultQoderCnRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMEM_QODER_CN_PROJECTS ?? expandHome('~/.qoder-cn');
}

/**
 * 列出 Qoder 会话：<root>/cache/projects/<project>/conversation-history/<cid>/<cid>.jsonl。
 * 同一 session_id 只取一份（按 mtime 最新）。
 */
export function listQoderSessions(root: string, opts: { since?: Date } = {}): SessionFile[] {
  if (!existsSync(root)) return [];
  const bySession = new Map<string, SessionFile>();
  const projectsDir = join(root, 'cache', 'projects');
  if (!existsSync(projectsDir)) return [];
  let projects: string[];
  try {
    projects = readdirSync(projectsDir);
  } catch {
    return [];
  }
  for (const proj of projects) {
    const historyDir = join(projectsDir, proj, 'conversation-history');
    if (!existsSync(historyDir)) continue;
    let cids: string[];
    try {
      cids = readdirSync(historyDir);
    } catch {
      continue;
    }
    for (const cid of cids) {
      const path = join(historyDir, cid, `${cid}.jsonl`);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (opts.since && st.mtimeMs < opts.since.getTime()) continue;
      const existing = bySession.get(cid);
      if (!existing || st.mtimeMs > existing.mtimeMs) {
        bySession.set(cid, { path, sessionId: cid, mtimeMs: st.mtimeMs });
      }
    }
  }
  return [...bySession.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** Qoder 特有噪声剥离：优先取 <user_query> 内正文；再剥 attached_files / file / current_open_file / system-reminder。 */
function stripQoderNoise(text: string): string {
  // 1) 优先取 <user_query> 内正文
  const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  let base: string;
  if (queries.length > 0) {
    base = queries.join('\n').trim();
  } else {
    // 2) 无 user_query：剥掉所有大块噪声标签
    base = text
      .replace(/<attached_files\b[^>]*>[\s\S]*?<\/attached_files>/gi, '')
      .replace(/<file\b[^>]*>[\s\S]*?<\/file>/gi, '')
      .replace(/<current_open_file\b[^>]*>[\s\S]*?<\/current_open_file>/gi, '')
      .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
      .trim();
  }
  // 3) 最后再清一遍 system-reminder（<user_query> 内可能嵌套）
  return base.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '').trim();
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

/** 解析单个 Qoder conversation JSONL。 */
export function parseQoderFile(path: string): SessionDigest | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // 路径结构：.../<project-hash>/conversation-history/<cid>/<cid>.jsonl
  const parts = path.split(/[\\/]/);
  const sessionId = parts[parts.length - 2]; // <cid>
  const projectHash = parts[parts.length - 4]; // <project-hash>（conversation-history 的上两级）
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
    const raw = extractText(j.message?.content ?? j.content);
    if (!raw) continue;
    const content = stripQoderNoise(raw).trim();
    if (!content) continue;
    messages.push({
      session_id: sessionId,
      agent: 'qoder',
      ts: new Date(0).toISOString(), // Qoder 无独立时间戳：稳定占位
      project_fp: projectHash,
      role,
      content,
      msg_uuid: `${sessionId}#${i}`,
    });
  }
  if (messages.length === 0) return null;
  return {
    session_id: sessionId,
    agent: 'qoder',
    project_fp: projectHash,
    started_ts: messages[0].ts,
    ended_ts: messages[messages.length - 1].ts,
    messages,
  };
}
