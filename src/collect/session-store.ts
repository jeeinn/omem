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
  /** API 档加工状态（文档 §3.5）：`ok|fail|skip : <prompt版本> : <content_hash> [: 计数]`；缺省=未加工。 */
  apiState?: string;
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
  const lines = [
    '---',
    `agent: ${meta.agent}`,
    `session_id: ${meta.sessionId}`,
    `project: ${meta.project}`,
    `started: ${meta.started}`,
    `ended: ${meta.ended}`,
    `messages: ${meta.messages}`,
    `content_hash: ${meta.contentHash}`,
  ];
  if (meta.apiState) lines.push(`api_state: ${meta.apiState}`);
  return [
    ...lines,
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
    // 未知键天然忽略；api_state 是唯一被认领的加工字段（文档 §3.5）
    apiState: fm.api_state || undefined,
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

/**
 * 整文件重写。哈希未变时保留原 `api_state`（文档 §3.5 规则 1）：
 * `--session` 点名在内容未变时也会走到这里，不保状态会把已有 `ok` 先抹掉，
 * 随后传输失败（规则 3 不写新状态）就永久丢失。
 */
export function writeSessionFile(home: string, digest: SessionDigest, body: string, hash: string): { path: string; text: string; apiState?: string } {
  const path = sessionFilePath(home, digest.agent, digest.session_id);
  const prev = readStoredSession(path);
  const apiState = prev && prev.contentHash === hash ? prev.apiState : undefined;
  const meta: StoredSession = {
    agent: digest.agent,
    sessionId: digest.session_id,
    project: digest.project_fp || 'unknown',
    started: digest.started_ts,
    ended: digest.ended_ts,
    messages: digest.messages.length,
    contentHash: hash,
    apiState,
    body,
  };
  mkdirSync(join(dirs.sessions(home), safeSeg(digest.agent)), { recursive: true });
  const text = renderSessionFile(meta);
  atomicWrite(path, text);
  return { path, text, apiState };
}

/**
 * 外科手术式更新 `api_state`：只动 frontmatter 那一行，正文与其余键原样保留。
 * 先写文件、再由调用方更新索引行（文档 §3.5 规则 5 的写序）。
 */
export function updateSessionApiState(path: string, apiState: string | undefined): boolean {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return false;
  const fmLines = m[1].split(/\r?\n/).filter((l) => !/^api_state\s*:/.test(l));
  if (apiState) fmLines.push(`api_state: ${apiState}`);
  atomicWrite(path, ['---', ...fmLines, '---', '', m[2].replace(/^\r?\n/, '')].join('\n'));
  return true;
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
