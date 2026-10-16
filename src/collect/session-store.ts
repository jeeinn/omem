// 会话原文库：sessions/<agent>/<session_id>.md。一会话一个文件，不是记忆条目。
// 写入前脱敏。命中禁区关键词则不落盘。正文哈希未变由采集扫描跳过，不在这里比较。
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dirs } from '../core/paths.js';
import { atomicWrite, contentHash } from '../core/util.js';
import { redactSecrets } from '../core/redact.js';
import type { SessionDigest } from './types.js';

export interface StoredSession {
  agent: string;
  sessionId: string;
  project: string;
  started: string;
  ended: string;
  messages: number;
  contentHash: string;
  body: string;
}

export function sessionKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

/** 从台账主键拆出采集器 id 与原始 session_id。 */
export function splitSessionKey(key: string): { agent: string; sessionId: string } {
  const i = key.indexOf(':');
  if (i <= 0) return { agent: '', sessionId: key };
  return { agent: key.slice(0, i), sessionId: key.slice(i + 1) };
}

function safeSeg(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_');
}

export function sessionFilePath(home: string, agent: string, sessionId: string): string {
  return join(dirs.sessions(home), safeSeg(agent), `${safeSeg(sessionId)}.md`);
}

/** 按 session_id 只打开对应文件，不读 sessions/ 下的其他会话。 */
export function readSessionsById(home: string, sessionId: string): StoredSession[] {
  const root = dirs.sessions(home);
  const name = `${safeSeg(sessionId)}.md`;
  let agents: string[];
  try {
    agents = readdirSync(root);
  } catch {
    return [];
  }
  const out: StoredSession[] = [];
  for (const agent of agents) {
    const stored = readStoredSession(join(root, agent, name));
    if (stored) out.push(stored);
  }
  return out;
}

/** 按时间拼成 ## user / ## assistant 正文（尚未脱敏）。 */
export function renderDialogue(digest: SessionDigest): string {
  return digest.messages.map((m) => `## ${m.role}\n${m.content.trim()}`).join('\n\n');
}

/** 脱敏后的正文及其 content-hash。跳过台账与落盘共用这一份。 */
export function prepareDialogue(digest: SessionDigest): { body: string; hash: string } {
  const { text } = redactSecrets(renderDialogue(digest));
  const body = text.trim();
  return { body, hash: contentHash(body) };
}

export function keywordHit(body: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    if (kw && body.includes(kw)) return kw;
  }
  return null;
}

export function renderSessionFile(meta: StoredSession): string {
  return [
    '---',
    `agent: ${meta.agent}`,
    `session_id: ${meta.sessionId}`,
    `project: ${meta.project}`,
    `started: ${meta.started}`,
    `ended: ${meta.ended}`,
    `messages: ${meta.messages}`,
    `content_hash: ${meta.contentHash}`,
    '---',
    '',
    meta.body.trimEnd(),
    '',
  ].join('\n');
}

export function parseStoredSession(text: string): StoredSession | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = raw.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1]] = kv[2].trim();
  }
  if (!fm.agent || !fm.session_id || !fm.content_hash) return null;
  const messages = Number(fm.messages);
  return {
    agent: fm.agent,
    sessionId: fm.session_id,
    project: fm.project || 'unknown',
    started: fm.started || '',
    ended: fm.ended || '',
    messages: Number.isFinite(messages) ? messages : 0,
    contentHash: fm.content_hash,
    body: m[2].trim(),
  };
}

/** 取出所有 `## user` 段，供依据核对。助手段不返回。 */
export function userSectionText(body: string): string {
  const parts: string[] = [];
  for (const block of body.split(/^## /m).slice(1)) {
    const nl = block.indexOf('\n');
    const head = (nl === -1 ? block : block.slice(0, nl)).trim();
    if (head !== 'user') continue;
    parts.push((nl === -1 ? '' : block.slice(nl + 1)).trim());
  }
  return parts.join('\n');
}

export function writeSessionFile(home: string, digest: SessionDigest, body: string, hash: string): { path: string; text: string } {
  const meta: StoredSession = {
    agent: digest.agent,
    sessionId: digest.session_id,
    project: digest.project_fp || 'unknown',
    started: digest.started_ts,
    ended: digest.ended_ts,
    messages: digest.messages.length,
    contentHash: hash,
    body,
  };
  const path = sessionFilePath(home, digest.agent, digest.session_id);
  mkdirSync(join(dirs.sessions(home), safeSeg(digest.agent)), { recursive: true });
  const text = renderSessionFile(meta);
  atomicWrite(path, text);
  return { path, text };
}

/** 列出 sessions/ 下的原文文件（不递归进无关目录名）。 */
export function listStoredSessionFiles(home: string): string[] {
  const root = dirs.sessions(home);
  const out: string[] = [];
  let agents: string[];
  try {
    agents = readdirSync(root);
  } catch {
    return [];
  }
  for (const agent of agents) {
    const dir = join(root, agent);
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.md') && !name.endsWith('.conflict.md')) out.push(join(dir, name));
    }
  }
  return out;
}

export function readStoredSession(path: string): StoredSession | null {
  try {
    return parseStoredSession(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
