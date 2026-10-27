// review --ui 的数据装配：把 Located[] 变成页面能直接渲染的队列项与详情。
//
// 为什么单独一层：HTTP 服务与页面模板都不该关心 frontmatter 结构；
// 这一层是纯函数，可以脱离浏览器单独测（tests/unit/review-data.test.ts）。
//
// 性能：会话标题是唯一需要读文件的环节。先由 index.listSessions() 一次 SQL
// 建 sessionId → path 映射，再按需读文件；模块内保留一个小 LRU，避免同一条
// 目反复展开时重复解析（会话 md 可能几十 KB）。
import { existsSync } from 'node:fs';
import type { OmemIndex } from '../core/index.js';
import type { Located } from '../core/store.js';
import { findById, findByIdIndexed } from '../core/store.js';
import { deriveSummary, deriveTitle } from '../core/entry.js';
import { readStoredSession, splitSessionKey, userSectionText } from '../collect/session-store.js';
import { truncate } from '../core/util.js';

export interface SessionTitle {
  sessionId: string;
  agent: string;
  started: string;
  messages: number;
  /** 首条 ## user 段的首个非空行，截断 60 字符。 */
  title: string;
  /** 会话文件缺失时标题为占位串，此处为 false。 */
  found: boolean;
}

export interface ReviewItem {
  id: string;
  topic?: string;
  type: string;
  domain: string;
  source: string;
  confidence: number;
  verified: boolean;
  created: string;
  title: string;
  summary: string;
  evidenceCount: number;
  sessionCount: number;
  supersedesCount: number;
  /** ungrounded / low-weight / assent / pending-session 等标签 */
  flags: string[];
  /** 沿 supersedes 向上追溯的旧版 id（不含自身），用于展示「第几版」 */
  versionChain: string[];
}

export interface ReviewDetail extends ReviewItem {
  body: string;
  evidence: string[];
  supersedes: string[];
  supersededBy?: string;
  sessions: SessionTitle[];
}

export type SessionPathIndex = Map<string, { agent: string; path: string }>;

/** 一次 SQL 建 sessionId → 文件路径映射。不读文件。 */
export function buildSessionIndex(index: OmemIndex): SessionPathIndex {
  const map: SessionPathIndex = new Map();
  for (const rec of index.listSessions()) {
    const { agent, sessionId } = splitSessionKey(rec.session_id);
    const key = sessionId || rec.session_id;
    if (map.has(key)) continue;
    map.set(key, { agent: rec.agent || agent, path: rec.path });
  }
  return map;
}

const TITLE_CACHE_LIMIT = 200;
const titleCache = new Map<string, SessionTitle>();

function rememberTitle(key: string, value: SessionTitle): void {
  if (titleCache.size >= TITLE_CACHE_LIMIT) {
    // Map 保持插入顺序，删最早的即可，不必实现完整 LRU
    const oldest = titleCache.keys().next().value;
    if (oldest !== undefined) titleCache.delete(oldest);
  }
  titleCache.set(key, value);
}

/** 首条 user 消息的首行。取不到就返回空串，由调用方回落。 */
function firstUserLine(body: string): string {
  const text = userSectionText(body);
  const line = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return truncate(line, 60);
}

export interface ResolveTitlesResult {
  sessions: SessionTitle[];
  hits: number;
  misses: number;
}

/** 解析一批 session_id 的标题。缺失的会话给占位串，不抛错。 */
export function resolveSessionTitles(
  sessionIndex: SessionPathIndex,
  sessionIds: string[],
  counter?: { hits: number; misses: number },
): ResolveTitlesResult {
  const out: SessionTitle[] = [];
  let hits = 0;
  let misses = 0;
  for (const sessionId of sessionIds) {
    const cached = titleCache.get(sessionId);
    if (cached) {
      out.push(cached);
      hits++;
      continue;
    }
    const entry = sessionIndex.get(sessionId);
    if (!entry || !existsSync(entry.path)) {
      const placeholder: SessionTitle = {
        sessionId,
        agent: entry?.agent ?? '?',
        started: '',
        messages: 0,
        title: '(session file not found)',
        found: false,
      };
      out.push(placeholder);
      misses++;
      continue;
    }
    const stored = readStoredSession(entry.path);
    if (!stored) {
      out.push({
        sessionId,
        agent: entry.agent,
        started: '',
        messages: 0,
        title: '(unreadable session)',
        found: false,
      });
      misses++;
      continue;
    }
    const title = firstUserLine(stored.body) || truncate(stored.body.replace(/\s+/g, ' ').trim(), 60);
    const resolved: SessionTitle = {
      sessionId,
      agent: stored.agent || entry.agent,
      started: stored.started,
      messages: stored.messages,
      title: title || '(empty session)',
      found: true,
    };
    rememberTitle(sessionId, resolved);
    out.push(resolved);
    misses++;
  }
  if (counter) {
    counter.hits += hits;
    counter.misses += misses;
  }
  return { sessions: out, hits, misses };
}

/** 沿 supersedes 向上追溯版本链。visited 防脏数据自环，深度上限防病态长链。 */
function versionChain(home: string, index: OmemIndex | undefined, start: Located, limit = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>([start.entry.fm.id]);
  let current = start.entry.fm;
  const lookup = (id: string): Located | null =>
    index ? findByIdIndexed(home, index, id, { includeArchived: true }) : findById(home, id, { includeArchived: true });
  for (let i = 0; i < limit; i++) {
    const oldId = current.supersedes?.[0];
    if (!oldId || seen.has(oldId)) break;
    const old = lookup(oldId);
    if (!old) break;
    out.push(oldId);
    seen.add(oldId);
    current = old.entry.fm;
  }
  return out;
}

export function buildReviewItem(home: string, loc: Located, index?: OmemIndex): ReviewItem {
  const fm = loc.entry.fm;
  const body = loc.entry.body;
  return {
    id: fm.id,
    topic: fm.topic,
    type: fm.type,
    domain: fm.domain,
    source: fm.source,
    confidence: fm.confidence,
    verified: fm.verified,
    created: fm.created,
    title: deriveTitle(body),
    summary: deriveSummary(body, 160),
    evidenceCount: fm.evidence?.length ?? 0,
    sessionCount: fm.source_sessions?.length ?? 0,
    supersedesCount: fm.supersedes?.length ?? 0,
    flags: fm.tags.filter((t) => t === 'ungrounded' || t === 'low-weight' || t === 'assent' || t === 'pending-session'),
    versionChain: versionChain(home, index, loc),
  };
}

export function buildReviewDetail(
  home: string,
  loc: Located,
  sessionIndex: SessionPathIndex,
  counter?: { hits: number; misses: number },
  index?: OmemIndex,
): ReviewDetail {
  const fm = loc.entry.fm;
  const item = buildReviewItem(home, loc, index);
  const { sessions } = resolveSessionTitles(sessionIndex, fm.source_sessions ?? [], counter);
  return {
    ...item,
    body: loc.entry.body,
    evidence: fm.evidence ?? [],
    supersedes: fm.supersedes ?? [],
    supersededBy: fm.superseded_by,
    sessions,
  };
}

/** 测试与调试用：清掉模块级缓存，避免用例之间互相污染。 */
export function clearSessionTitleCache(): void {
  titleCache.clear();
}
