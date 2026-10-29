// 会话原文库：sessions/<agent>/<session_id>.md。一会话一个文件，不是记忆条目。
// 写入前脱敏。命中禁区关键词则不落盘。正文哈希未变由采集扫描跳过，不在这里比较。
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dirs } from '../core/paths.js';
import { atomicWrite, contentHash, normalizeForHash, sha256hex } from '../core/util.js';
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
  /** user 段归一化指纹（片段级去重用）；2026-10-28 起写入，旧文件缺省=未算。 */
  userHash?: string;
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

/**
 * 按 session_id 只打开对应文件，不读 sessions/ 下的其他会话。
 *
 * 前缀容错（2026-10-27）：调用方最自然的写法是 PROCESS.md / scope=sessions 里看到的
 * `claude-code:probe-0001`，而落盘文件名是 `probe-0001.md`。原先按原样拼路径必然落空，
 * 结果 evidence 锚定静默掉到 0.35，连 project 推断也一起失效。
 * 这里用 fallback 链而不是无条件剥离：id 本身可能含冒号，先按原样找才安全。
 */
export function readSessionsById(home: string, sessionId: string): StoredSession[] {
  const root = dirs.sessions(home);
  let agents: string[];
  try {
    agents = readdirSync(root);
  } catch {
    return [];
  }
  for (const candidate of sessionIdCandidates(sessionId)) {
    const name = `${safeSeg(candidate)}.md`;
    const out: StoredSession[] = [];
    for (const agent of agents) {
      const stored = readStoredSession(join(root, agent, name));
      if (stored) out.push(stored);
    }
    if (out.length > 0) return out;
  }
  return [];
}

/**
 * 候选 id，按优先级排列：原样 → 去 collector 前缀（`agent:id`）→ 取路径末段（`slug/uuid`）。
 * 去重且不返回空串，避免无谓的文件系统访问。
 */
function sessionIdCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const out = [trimmed];
  const { sessionId: bare } = splitSessionKey(trimmed);
  if (bare && bare !== trimmed) out.push(bare);
  const lastSegment = trimmed.split('/').filter(Boolean).pop();
  if (lastSegment && lastSegment !== trimmed) out.push(lastSegment);
  // `agent:slug/uuid` 这种混合写法：先剥前缀，再对结果取末段
  if (bare && bare !== trimmed) {
    const bareLast = bare.split('/').filter(Boolean).pop();
    if (bareLast && bareLast !== bare) out.push(bareLast);
  }
  return [...new Set(out)];
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
    ...(meta.userHash ? [`user_hash: ${meta.userHash}`] : []),
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
    userHash: fm.user_hash || undefined,
    // 未知键天然忽略；api_state 是唯一被认领的加工字段（文档 §3.5）
    apiState: fm.api_state || undefined,
    body: m[2].trim(),
  };
}

/** 取出所有 `## user` 段，供依据核对。助手段不返回。
 * 切段只认 `## user` / `## assistant` 精确标记：正文内部自带的小节标题
 * （如 workbuddy 富文本输出的 `## Core Truths`、`## 八、结语`）属于内容，
 * 按 `^## ` 松散切分会把它们之后的真人话语整体踢出核对范围（2026-10-28 实测缺陷）。 */
export function userSectionText(body: string): string {
  const parts: string[] = [];
  let collecting = false;
  let buf: string[] = [];
  const flush = (): void => {
    if (collecting) {
      const text = buf.join('\n').trim();
      if (text) parts.push(text);
    }
    buf = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^##\s*(user|assistant)\s*$/);
    if (marker) {
      flush();
      collecting = marker[1] === 'user';
      continue;
    }
    if (collecting) buf.push(line);
  }
  flush();
  return parts.join('\n');
}

/** user 段归一化指纹：片段级去重的依据（同一段内容、不同 metadata 的会话同指纹）。 */
export function sessionUserHash(body: string): string {
  return sha256hex(normalizeForHash(userSectionText(body))).slice(0, 16);
}

/**
 * 元数据围栏标记（真实 workbuddy / claude 会话的形状）：
 *
 * ```
 * Conversation info (untrusted metadata):
 * ```json
 * { "message_id": "…", "timestamp": "…" }
 * ```
 * ```
 *
 * **不必在段首**：真实仓 6 份带围栏的会话里，22 个 `## user` 段的段首是
 * `System: [ts] …`，围栏在段中间。上一版只剥段首，于是这些围栏里的 JSON 仍能当证据（QA 实测 0.55）。
 */
const METADATA_HEAD = /^(?:Conversation info|Sender)\s*\(untrusted metadata\)\s*:?\s*$/;

/**
 * 元数据键白名单。两个判据缺一不可：
 *   1. 前置行是 `… (untrusted metadata):` 标记（最强信号，不看内容）；
 *   2. 或者围栏里是**只含这些键**的 JSON 对象，且至少含一个强键。
 * 第二条的价值：抓「标记行缺失但内容是元数据」的变体；风险是误伤用户粘贴的 JSON，
 * 所以键表刻意收窄到会话元数据，且要求值都是标量（出现嵌套结构 / 自由文本字段即视为用户内容）。
 */
const METADATA_KEYS = new Set([
  'message_id', 'message_type', 'conversation_id', 'conversation_type', 'chat_id', 'chat_type',
  'channel', 'room_id', 'guild_id', 'thread_id', 'timestamp', 'ts', 'created_at',
  'sender', 'sender_id', 'sender_name', 'sender_type', 'user_id', 'bot_id', 'trace_id', 'request_id',
]);
/** 出现其中之一才认定「这是元数据」——只有 `{"id": 1}` 这种通用键不算。 */
const METADATA_STRONG_KEYS = ['message_id', 'conversation_id', 'timestamp', 'sender', 'sender_id'];

/** 围栏内容是否为「纯元数据 JSON」：对象、键全在白名单、值都是标量、至少一个强键。 */
function isMetadataJson(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return false;
  const scalar = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  if (!entries.every(([k, v]) => METADATA_KEYS.has(k) && scalar(v))) return false;
  return entries.some(([k]) => METADATA_STRONG_KEYS.includes(k));
}

/**
 * 标出要丢掉的行号（`## user` 段内，行相对下标）。
 *
 * 规则（三条一起才成立，缺一条就会误伤或漏网）：
 *   ① 围栏块**前面**的非空行是 `… (untrusted metadata):` → 整块 + 该标记行一起丢；
 *   ② 否则围栏内容满足 `isMetadataJson` → 只丢围栏块；
 *   ③ 其余一律保留（用户自己粘的代码 / JSON 必须留在证据域里）。
 * 围栏未闭合（文件被截断）时按「到段尾」处理。
 */
function metadataFenceLines(lines: string[]): Set<number> {
  const dropped = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('```')) continue;
    let close = i + 1;
    while (close < lines.length && !lines[close].trim().startsWith('```')) close++;
    const body = lines.slice(i + 1, close).join('\n');
    let before = i - 1;
    while (before >= 0 && lines[before].trim() === '') before--;
    const markerBefore = before >= 0 && METADATA_HEAD.test(lines[before].trim());
    if (markerBefore || isMetadataJson(body)) {
      const last = Math.min(close, lines.length - 1);
      for (let x = i; x <= last; x++) dropped.add(x);
      if (markerBefore) dropped.add(before);
    }
    i = close; // 整块已处理，块内不再扫（避免把用户代码里的 ``` 当新块）
  }
  return dropped;
}

/** 一段可复制的 `## user` 原文及其在会话文件里的字符范围（code point 偏移）。 */
export interface SessionUserSegment {
  role: 'user';
  /** 起始字符偏移（含），按 code point 计。 */
  start: number;
  /** 结束字符偏移（不含），按 code point 计。 */
  end: number;
  /** 剥净元数据后的原文。 */
  text: string;
}

/** 一段连续的正文区间（文件内的 code point 范围 + 文本）。 */
interface TextRun {
  start: number;
  end: number;
  text: string;
}

/**
 * 按 `## user` / `## assistant` 切段，再在 user 段内剥掉元数据围栏，**返回连续的文本区间**。
 *
 * 为什么返回「区间」而不是「段」：围栏可以出现在段中间，剥掉之后一段用户话会裂成两段。
 * 若仍按「整段 + 一段 text」返回，`chars` 就无法再指回文件原文（区间里含被剥掉的行）。
 * 裂成多个区间后，每个区间的 `[start,end)` 与 `text` 严格对应，调用方能直接切片复制。
 *
 * 偏移口径：整份会话正文的 code point 偏移，从 0 起。用 code point 而不是 UTF-16 单位，
 * 是因为 evidence 门槛（12 字符）与截断都按 code point 数。
 */
function sectionRuns(body: string): { runs: TextRun[]; assistantSections: number } {
  const lines = body.split(/\r?\n/);
  const starts: number[] = [];
  let cp = 0;
  for (const line of lines) {
    starts.push(cp);
    cp += [...line].length + 1; // +1 = 换行
  }

  const runs: TextRun[] = [];
  let assistantSections = 0;
  let role: 'user' | 'assistant' | null = null;
  let sectionFrom = 0;

  const flush = (toExclusive: number): void => {
    if (!role) return;
    const slice = lines.slice(sectionFrom, toExclusive);
    if (role === 'assistant') {
      if (slice.join('').trim()) assistantSections++;
      return;
    }
    const dropped = metadataFenceLines(slice);
    let from = -1;
    const emit = (toInclusive: number): void => {
      if (from < 0) return;
      const raw = slice.slice(from, toInclusive + 1).join('\n');
      const text = raw.trim();
      if (text) {
        const lead = [...raw.slice(0, raw.length - raw.trimStart().length)].length;
        const start = starts[sectionFrom + from] + lead;
        runs.push({ start, end: start + [...text].length, text });
      }
      from = -1;
    };
    for (let i = 0; i < slice.length; i++) {
      if (dropped.has(i)) {
        emit(i - 1);
      } else if (from < 0) {
        from = i;
      }
    }
    emit(slice.length - 1);
  };

  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^##\s*(user|assistant)\s*$/);
    if (marker) {
      flush(i);
      role = marker[1] as 'user' | 'assistant';
      sectionFrom = i + 1;
    }
  }
  flush(lines.length);
  return { runs, assistantSections };
}

/**
 * 证据域文本（beta.9 / T03 / P0-2）。
 *
 * 与 `userSectionText` 的唯一区别：剥掉 `## user` 段内**任意位置**的元数据围栏块。
 * 为什么必须是**新函数**而不是改 `userSectionText`：后者是 `sessionUserHash` 的输入，
 * 改它会让全体 `user_hash` 漂移，而 `guide.ts` 优先用落盘旧值 → 新旧两套指纹并行
 * 且没有任何报错（折叠数、copies 口径、`same-user-text` 会静默错一半）。
 * 证据核对走这里，指纹仍然走 `userSectionText`，两条路互不影响。
 */
export function evidenceUserText(body: string): string {
  return sectionRuns(body).runs.map((r) => r.text).join('\n');
}

/**
 * 按 `## user` 出可引用的段落 + assistant 段计数（beta.9 / T04 读取通道）。
 *
 * 与 `evidenceUserText` **同一个实现**（`sectionRuns`）：否则「检索里没有 Conversation info、
 * 保存时却有」这种两侧口径不一致会再次出现（QA 实测 session_id 通道 19 段里 2 段漏剥）。
 */
export function userSegments(body: string): { segments: SessionUserSegment[]; assistantSegments: number } {
  const { runs, assistantSections } = sectionRuns(body);
  return {
    segments: runs.map((r) => ({ role: 'user' as const, start: r.start, end: r.end, text: r.text })),
    assistantSegments: assistantSections,
  };
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
    userHash: sessionUserHash(body),
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
