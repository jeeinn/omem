// 索引层：SQLite + FTS5 trigram（规格 §2.3；评估 4.4 决策 1/4）。
// 原则：md 权威，索引是缓存——任何时刻删掉 omem.db 都能 rebuild 完整恢复。
// 一致性协议：条目存 content-hash + (size, mtime)；catch-up 对账外部编辑（Obsidian 改了文件）。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dirs, files } from './paths.js';
import type { Entry } from './entry.js';
import { parseEntry, deriveTitle, deriveSummary } from './entry.js';
import { sha256hex, contentHash } from './util.js';
import { allEntryFiles } from './store.js';
import { listStoredSessionFiles, readStoredSession } from '../collect/session-store.js';

export interface EntryRow {
  id: string;
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
  created: string;
  last_confirmed: string;
  confirmations: number;
  tags: string;
  title: string;
  summary: string;
  size: number;
  mtime_ms: number;
}

export interface SessionRecord {
  /** 主键，形如 `agent:sessionId`。 */
  session_id: string;
  agent: string;
  path: string;
  content_hash: string;
  project_fp: string;
  msg_count: number;
  last_ts: string;
  processed_at: string;
}

export class OmemIndex {
  readonly db: DatabaseSync;

  constructor(readonly home: string) {
    mkdirSync(dirs.index(home), { recursive: true });
    this.db = new DatabaseSync(files.db(home));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        body_hash TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL,
        type TEXT NOT NULL,
        profile TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        verified INTEGER NOT NULL,
        session_id TEXT,
        project TEXT,
        created TEXT NOT NULL,
        last_confirmed TEXT NOT NULL,
        confirmations INTEGER NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        id UNINDEXED, title, content, tags, tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        project_fp TEXT,
        msg_count INTEGER,
        last_ts TEXT,
        processed_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        session_key UNINDEXED, content, tokenize='trigram'
      );
    `);
    this.addColumn('sessions', 'agent', 'TEXT');
    this.addColumn('sessions', 'path', 'TEXT');
    this.addColumn('sessions', 'content_hash', 'TEXT');
  }

  private addColumn(table: string, name: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }

  // ── 条目读写 ──

  upsert(entry: Entry, path: string, content: string): void {
    const fm = entry.fm;
    // hash = 文件内容哈希（一致性协议：catch-up 检出外部编辑）
    // body_hash = 归一化正文 content-hash（幂等去重：add/save/pipeline 三处共用）
    const hash = sha256hex(content).slice(0, 32);
    const bodyHash = contentHash(entry.body);
    const title = deriveTitle(entry.body);
    const summary = deriveSummary(entry.body);
    let size = 0;
    let mtime = 0;
    try {
      const st = statSync(path);
      size = st.size;
      mtime = st.mtimeMs;
    } catch { /* 文件尚未落盘的极端情况 */ }
    this.db.prepare('DELETE FROM entries WHERE id = ?').run(fm.id);
    this.db.prepare(`INSERT INTO entries
      (id,path,hash,body_hash,domain,type,profile,status,source,confidence,verified,session_id,project,created,last_confirmed,confirmations,tags,title,summary,size,mtime_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      fm.id, path, hash, bodyHash, fm.domain, fm.type, fm.profile, fm.status, fm.source,
      fm.confidence, fm.verified ? 1 : 0, fm.session_id ?? null, fm.project ?? null,
      fm.created, fm.last_confirmed, fm.confirmations, fm.tags.join(' '),
      title, summary, size, mtime,
    );
    this.db.prepare('DELETE FROM entries_fts WHERE id = ?').run(fm.id);
    this.db.prepare('INSERT INTO entries_fts (id, title, content, tags) VALUES (?,?,?,?)').run(
      fm.id, title, entry.body, fm.tags.join(' '),
    );
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
  }

  getById(id: string): EntryRow | null {
    return (this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as unknown as EntryRow) ?? null;
  }

  getByHash(hash: string): EntryRow | null {
    return (this.db.prepare('SELECT * FROM entries WHERE hash = ?').get(hash) as unknown as EntryRow) ?? null;
  }

  /** 按归一化正文 content-hash 查重（规格 §8 save_memory 幂等）。 */
  getByBodyHash(hash: string): EntryRow | null {
    return (this.db.prepare('SELECT * FROM entries WHERE body_hash = ?').get(hash) as unknown as EntryRow) ?? null;
  }

  private touchMeta(id: string, size: number, mtime: number): void {
    this.db.prepare('UPDATE entries SET size = ?, mtime_ms = ? WHERE id = ?').run(size, mtime, id);
  }

  allIds(): string[] {
    return (this.db.prepare('SELECT id FROM entries').all() as { id: string }[]).map((r) => r.id);
  }

  // ── 一致性：catch-up / rebuild ──

  /** connect-time catch-up（规格 §2.3）：(size, mtime) 快路径 + content-hash 慢路径。 */
  catchUp(): { scanned: number; reindexed: number; removed: number } {
    let scanned = 0;
    let reindexed = 0;
    let removed = 0;
    const seen = new Set<string>();
    const { knowledge, archive } = allEntryFiles(this.home);
    for (const path of [...knowledge, ...archive]) {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const entry = parseEntry(text);
      if (!entry) continue;
      scanned++;
      seen.add(entry.fm.id);
      const st = statSync(path);
      const row = this.getById(entry.fm.id);
      if (row && row.size === st.size && row.mtime_ms === st.mtimeMs) continue; // 快路径：未变
      const hash = sha256hex(text).slice(0, 32);
      if (row && row.hash === hash) {
        this.touchMeta(entry.fm.id, st.size, st.mtimeMs); // 内容未变只更新时间戳
        continue;
      }
      this.upsert(entry, path, text);
      reindexed++;
    }
    for (const id of this.allIds()) {
      if (!seen.has(id)) {
        this.remove(id);
        removed++;
      }
    }
    this.catchUpSessions();
    return { scanned, reindexed, removed };
  }

  /** 全量重建（omem rebuild）：删 db 也能恢复的保证落地。 */
  rebuild(): number {
    this.db.exec('DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS entries_fts;');
    this.initSchema();
    let total = 0;
    const { knowledge, archive } = allEntryFiles(this.home);
    for (const path of [...knowledge, ...archive]) {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const entry = parseEntry(text);
      if (!entry) continue;
      this.upsert(entry, path, text);
      total++;
    }
    this.rebuildSessions();
    this.setMeta('last_rebuild', new Date().toISOString());
    return total;
  }

  // ── meta / sessions ──

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getSession(sessionId: string): SessionRecord | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as unknown as SessionRecord) ?? null;
  }

  listSessions(): SessionRecord[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY last_ts ASC').all() as unknown as SessionRecord[];
  }

  /** knowledge 条目指向过的 session_id（含 agent:id 与原始 id）。 */
  linkedSessionIds(): Set<string> {
    const rows = this.db.prepare(
      "SELECT DISTINCT session_id FROM entries WHERE session_id IS NOT NULL AND session_id != ''",
    ).all() as { session_id: string }[];
    return new Set(rows.map((r) => r.session_id));
  }

  putSession(rec: SessionRecord, body = ''): void {
    this.db.prepare(`INSERT INTO sessions
      (session_id, project_fp, msg_count, last_ts, processed_at, agent, path, content_hash)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      project_fp = excluded.project_fp, msg_count = excluded.msg_count,
      last_ts = excluded.last_ts, processed_at = excluded.processed_at,
      agent = excluded.agent, path = excluded.path, content_hash = excluded.content_hash`).run(
      rec.session_id, rec.project_fp, rec.msg_count, rec.last_ts, rec.processed_at,
      rec.agent, rec.path, rec.content_hash,
    );
    this.db.prepare('DELETE FROM sessions_fts WHERE session_key = ?').run(rec.session_id);
    if (body) {
      this.db.prepare('INSERT INTO sessions_fts (session_key, content) VALUES (?,?)').run(rec.session_id, body);
    }
  }

  removeSession(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions_fts WHERE session_key = ?').run(sessionId);
  }

  private catchUpSessions(): void {
    this.reindexSessionFiles(false);
  }

  private rebuildSessions(): void {
    this.db.exec('DELETE FROM sessions; DELETE FROM sessions_fts;');
    this.reindexSessionFiles(true);
  }

  private reindexSessionFiles(force: boolean): void {
    const seen = new Set<string>();
    for (const path of listStoredSessionFiles(this.home)) {
      const text = readFileSync(path, 'utf8');
      const stored = readStoredSession(path);
      if (!stored) continue;
      const key = `${stored.agent}:${stored.sessionId}`;
      seen.add(key);
      const st = statSync(path);
      const prev = this.getSession(key);
      if (!force && prev && prev.path === path && prev.content_hash === stored.contentHash) continue;
      this.putSession({
        session_id: key,
        agent: stored.agent,
        path,
        content_hash: stored.contentHash,
        project_fp: stored.project,
        msg_count: stored.messages,
        last_ts: stored.ended,
        processed_at: prev?.processed_at ?? stored.ended,
      }, stored.body || text);
    }
    for (const row of this.listSessions()) {
      if (!seen.has(row.session_id)) this.removeSession(row.session_id);
    }
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM entries GROUP BY status').all() as { status: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  close(): void {
    this.db.close();
  }
}
