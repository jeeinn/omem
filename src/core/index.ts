// 索引层（B 阶段：内存派生索引，无 SQLite；规格 §2.3 / 重构方案 §12）。
// 原则：md 权威，索引是派生——进程启动时按需解析，删掉进程即"删掉索引"。
// 一致性协议：活文档每次对账看 (size, mtime)；会话只在需要时构建（见 ensureSessions）。
// 检索不建倒排：语料量级下暴力子串匹配是 1–2ms（实测见方案 §12），别手写搜索引擎。
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Entry } from './entry.js';
import { deriveSummary, deriveTitle, parseEntry } from './entry.js';
import { contentHash, sha256hex } from './util.js';
import { allEntryFiles } from './store.js';
import { evidenceUserText, listStoredSessionFiles, readStoredSession } from '../collect/session-store.js';

/** 检索与回执共用的行形状。字段与历史 SQLite 表列保持一致，调用方无需改动。 */
export interface EntryRow {
  /** 身份 = topic（D1-B′）。 */
  topic: string;
  path: string;
  hash: string;
  body_hash: string;
  domain: string;
  type: string;
  profile: string;
  status: string;
  source: string;
  confidence: number;
  verified: number;
  session_id: string | null;
  project: string | null;
  source_sessions: string | null;
  created: string;
  last_confirmed: string;
  confirmations: number;
  tags: string;
  title: string;
  summary: string;
  size: number;
  mtime_ms: number;
  /** 命中词数（仅查询结果上有）。越大越相关。 */
  rank?: number | null;
}

export interface SessionRecord {
  /** 形如 `agent:sessionId`。 */
  session_id: string;
  agent: string;
  path: string;
  content_hash: string;
  /** API 档加工状态镜像（文档 §3.5）；事实源是 session 文件 frontmatter。 */
  api_state?: string | null;
  project_fp: string;
  msg_count: number;
  last_ts: string;
  processed_at: string;
}

interface EntrySlot {
  row: EntryRow;
  /** 小写正文，检索直接扫它，避免每次查询重新 toLowerCase。 */
  lower: string;
}

interface SessionSlot {
  rec: SessionRecord;
  /** 只留 `## user` 段的小写文本：assistant 段不能当证据，也不该被检索到。 */
  lowerUserText: string;
}

/** topic 来自文件名（D1-B′）：frontmatter 不落 topic，identity 由路径承载。 */
function topicOf(path: string): string {
  return basename(path).replace(/\.md$/, '');
}

export class OmemIndex {
  private readonly entries = new Map<string, EntrySlot>();
  private readonly sessions = new Map<string, SessionSlot>();
  private sessionsLoaded = false;
  private readonly meta = new Map<string, string>();
  private snap = new Map<string, string>();

  constructor(readonly home: string, _opts: { busyTimeoutMs?: number } = {}) {
    this.loadEntries();
  }

  // ── 条目 ──

  private loadEntries(): void {
    this.entries.clear();
    this.snap.clear();
    const { knowledge, archive } = allEntryFiles(this.home);
    for (const path of [...knowledge, ...archive]) {
      this.indexFile(path, { force: true });
    }
  }

  /** 读一个文件并（重新）登记；返回是否发生了变更。 */
  private indexFile(path: string, opts: { force?: boolean } = {}): boolean {
    let text: string;
    let size = 0;
    let mtime = 0;
    try {
      text = readFileSync(path, 'utf8');
      const st = statSync(path);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      return false;
    }
    const entry = parseEntry(text);
    if (!entry) return false;
    const topic = topicOf(path);
    const prev = this.entries.get(topic);
    const sig = `${size}:${mtime}`;
    if (!opts.force && prev && this.snap.get(topic) === sig && prev.row.path === path) return false;
    entry.fm.topic = topic;
    const fm = entry.fm;
    this.entries.set(topic, {
      row: {
        topic,
        path,
        hash: sha256hex(text).slice(0, 32),
        body_hash: contentHash(entry.body),
        domain: fm.domain,
        type: fm.type,
        profile: fm.profile,
        status: fm.status,
        source: fm.source,
        confidence: fm.confidence,
        verified: fm.verified ? 1 : 0,
        session_id: fm.session_id ?? null,
        project: fm.project ?? null,
        source_sessions: JSON.stringify(fm.source_sessions ?? []),
        created: fm.created,
        last_confirmed: fm.last_confirmed,
        confirmations: fm.confirmations,
        tags: fm.tags.join(' '),
        title: deriveTitle(entry.body),
        summary: deriveSummary(entry.body),
        size,
        mtime_ms: mtime,
      },
      lower: entry.body.toLowerCase(),
    });
    this.snap.set(topic, sig);
    return true;
  }

  upsert(entry: Entry, path: string, _content: string): void {
    this.indexFile(path, { force: true });
  }

  remove(topic: string): void {
    this.entries.delete(topic);
    this.snap.delete(topic);
  }

  getByTopic(topic: string): EntryRow | null {
    return this.entries.get(topic)?.row ?? null;
  }

  findActiveByTopic(topic: string): EntryRow | null {
    const row = this.entries.get(topic)?.row;
    return row && row.status === 'active' ? row : null;
  }

  getByHash(hash: string): EntryRow | null {
    for (const slot of this.entries.values()) if (slot.row.hash === hash) return slot.row;
    return null;
  }

  getByBodyHash(hash: string): EntryRow | null {
    for (const slot of this.entries.values()) if (slot.row.body_hash === hash) return slot.row;
    return null;
  }

  activeTopics(): string[] {
    return [...this.entries.values()].filter((s) => s.row.status === 'active').map((s) => s.row.topic);
  }

  allTopics(): string[] {
    return [...this.entries.keys()];
  }

  pathByTopic(topic: string): string | null {
    return this.entries.get(topic)?.row.path ?? null;
  }

  /** 该主题是否被人工过目过（confirmations > 0）。供 `once` 策略判定。 */
  topicReviewedBefore(topic: string): boolean {
    return (this.entries.get(topic)?.row.confirmations ?? 0) > 0;
  }

  countByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const { row } of this.entries.values()) out[row.status] = (out[row.status] ?? 0) + 1;
    return out;
  }

  /** 供检索层遍历：行 + 小写正文。 */
  rows(): { row: EntryRow; lower: string }[] {
    return [...this.entries.values()];
  }

  // ── 一致性：catch-up / rebuild ──

  /** 对账：活文档按 (size, mtime) 快路径；文件消失则移除；会话按需重建。 */
  catchUp(): { scanned: number; reindexed: number; removed: number } {
    const { knowledge, archive } = allEntryFiles(this.home);
    const seen = new Set<string>();
    let reindexed = 0;
    let scanned = 0;
    for (const path of [...knowledge, ...archive]) {
      const topic = topicOf(path);
      scanned++;
      seen.add(topic);
      if (this.indexFile(path)) reindexed++;
    }
    let removed = 0;
    for (const topic of [...this.entries.keys()]) {
      if (!seen.has(topic)) {
        this.remove(topic);
        removed++;
      }
    }
    if (this.sessionsLoaded) this.reindexSessions();
    return { scanned, reindexed, removed };
  }

  /** 全量重载（omem verify）：md 是真相源，重建永远无损。 */
  rebuild(): number {
    this.loadEntries();
    this.sessions.clear();
    this.sessionsLoaded = false;
    this.setMeta('last_rebuild', new Date().toISOString());
    return this.entries.size;
  }

  // ── meta ──

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  // ── 会话（按需构建：活文档检索用不到它们） ──

  private ensureSessions(): void {
    if (this.sessionsLoaded) return;
    this.reindexSessions();
    this.sessionsLoaded = true;
  }

  private reindexSessions(): void {
    const seen = new Set<string>();
    for (const path of listStoredSessionFiles(this.home)) {
      const stored = readStoredSession(path);
      if (!stored) continue;
      const key = `${stored.agent}:${stored.sessionId}`;
      seen.add(key);
      const prev = this.sessions.get(key);
      this.sessions.set(key, {
        rec: {
          session_id: key,
          agent: stored.agent,
          path,
          content_hash: stored.contentHash,
          api_state: stored.apiState ?? null,
          project_fp: stored.project,
          msg_count: stored.messages,
          last_ts: stored.ended,
          processed_at: prev?.rec.processed_at ?? stored.ended,
        },
        lowerUserText: evidenceUserText(stored.body).toLowerCase(),
      });
    }
    for (const key of [...this.sessions.keys()]) {
      if (!seen.has(key)) this.sessions.delete(key);
    }
  }

  getSession(sessionId: string): SessionRecord | null {
    this.ensureSessions();
    return this.sessions.get(sessionId)?.rec ?? null;
  }

  listSessions(): SessionRecord[] {
    this.ensureSessions();
    return [...this.sessions.values()].map((s) => s.rec).sort((a, b) => (a.last_ts < b.last_ts ? -1 : 1));
  }

  /** 供 `search --sessions` 遍历：记录 + 小写 `## user` 文本。 */
  sessionSlots(): { rec: SessionRecord; lowerUserText: string }[] {
    this.ensureSessions();
    return [...this.sessions.values()];
  }

  /** knowledge 条目指向过的 session_id（含 `agent:id` 与裸 id）。 */
  linkedSessionIds(): Set<string> {
    const out = new Set<string>();
    for (const { row } of this.entries.values()) {
      if (!row.session_id) continue;
      out.add(row.session_id);
      const bare = row.session_id.split(':').pop();
      if (bare) out.add(bare);
    }
    return out;
  }

  putSession(rec: SessionRecord, body = ''): void {
    this.ensureSessions();
    this.sessions.set(rec.session_id, {
      rec,
      lowerUserText: evidenceUserText(body || '').toLowerCase(),
    });
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** 只更新 api_state 镜像（写序：先改 session 文件，再调这里，文档 §3.5 规则 5）。 */
  setSessionApiState(sessionId: string, apiState: string | null): void {
    const slot = this.sessions.get(sessionId);
    if (slot) slot.rec = { ...slot.rec, api_state: apiState };
  }

  /** 进程内没有需要释放的句柄；保留这个方法让调用方不需要改。 */
  close(): void {
    /* no-op：内存索引没有句柄 */
  }
}
