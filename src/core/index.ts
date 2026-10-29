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
  topic: string | null;
  source_sessions: string | null;
  created: string;
  last_confirmed: string;
  confirmations: number;
  tags: string;
  title: string;
  summary: string;
  size: number;
  mtime_ms: number;
  /**
   * 检索时由 SQL 附带的 bm25 分值（越负越相关）。只有 FTS 主路径有，LIKE 兜底路径为 null。
   * 不落表，只存在于查询结果行上——给调用方判断「这条是强命中还是勉强命中」。
   */
  rank?: number | null;
}

export interface SessionRecord {
  /** 主键，形如 `agent:sessionId`。 */
  session_id: string;
  agent: string;
  path: string;
  content_hash: string;
  /** API 档加工状态镜像（文档 §3.5）；事实源是 session 文件 frontmatter，这里只是加速读取。 */
  api_state?: string | null;
  project_fp: string;
  msg_count: number;
  last_ts: string;
  processed_at: string;
}

/**
 * SQLITE_BUSY 的可读化与重试（beta.9.1 / P0-3）。
 *
 * 现场：3 个进程并发写同一个数据仓，2 个在 `openCtx → catchUp → putSession` 抛
 * `SQLITE_ERROR: database is locked` 未捕获、进程直接退出，6 次写入只落地 2 次。
 * 「多个客户端共享同一记忆库」是产品承诺，所以这里做两件事：
 *   1. 连接上设 `PRAGMA busy_timeout`（默认 5000ms）——SQLite 自己会等锁，而不是立刻报错；
 *   2. 剩余仍报 BUSY 的场景做有限次退避重试；再失败则抛可读错误（调用方按 exit 2 / isError 呈现），
 *      绝不把裸栈扔给用户。
 * 不做「加锁文件把客户端串行化」：那会让第二个客户端卡死，而 SQLite 本身已经有锁。
 */
export function isSqliteBusy(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(msg);
}

/** 有限次退避重试；只对 BUSY 重试，其它错误原样抛。 */
export function withBusyRetry<T>(fn: () => T, attempts = 4): T {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err)) throw err;
      lastErr = err;
      const wait = 25 * 2 ** i;
      const until = Date.now() + wait;
      while (Date.now() < until) { /* 同步退避：CLI/MCP 路径都是同步 IO，不引定时器 */ }
    }
  }
  throw lastErr;
}

export class OmemIndex {
  readonly db: DatabaseSync;
  /** 连接级的锁等待上限（毫秒）。由 `[process] busy_timeout_ms` 决定，默认 5000。 */
  readonly busyTimeoutMs: number;

  constructor(readonly home: string, opts: { busyTimeoutMs?: number } = {}) {
    mkdirSync(dirs.index(home), { recursive: true });
    this.db = new DatabaseSync(files.db(home));
    this.busyTimeoutMs = Number.isFinite(opts.busyTimeoutMs) && (opts.busyTimeoutMs ?? 0) > 0
      ? Math.floor(opts.busyTimeoutMs as number)
      : 5000;
    // WAL 让读不阻塞写；busy_timeout 让并发写在锁上等待而不是立刻 SQLITE_BUSY。
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
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
    this.addColumn('sessions', 'api_state', 'TEXT');
    this.addColumn('entries', 'topic', 'TEXT');
    this.addColumn('entries', 'source_sessions', 'TEXT');
  }

  private addColumn(table: string, name: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }

  // ── 条目读写 ──

  upsert(entry: Entry, path: string, content: string): void {
    // 并发写入时 SQLITE_BUSY 不该让一次已经落盘的记忆变成失败：退避重试有限次。
    return withBusyRetry(() => this.upsertInner(entry, path, content));
  }

  private upsertInner(entry: Entry, path: string, content: string): void {
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
      (id,path,hash,body_hash,domain,type,profile,status,source,confidence,verified,session_id,project,topic,source_sessions,created,last_confirmed,confirmations,tags,title,summary,size,mtime_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      fm.id, path, hash, bodyHash, fm.domain, fm.type, fm.profile, fm.status, fm.source,
      fm.confidence, fm.verified ? 1 : 0, fm.session_id ?? null, fm.project ?? null,
      fm.topic ?? null, JSON.stringify(fm.source_sessions ?? []),
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

  /** 该主题当前的 active 活文档。多条时取最近确认的一份。 */
  /** 全部 active 主题名。用于写入时的近似重复检测（不需要打开任何 md 文件）。 */
  activeTopics(): string[] {
    return (this.db.prepare(
      "SELECT DISTINCT topic FROM entries WHERE status = 'active' AND topic IS NOT NULL AND topic != ''",
    ).all() as { topic: string }[]).map((r) => r.topic);
  }

  /** 按 id 取文件路径（单次 SQL）。未索引时返回 null，调用方应回落到全库扫描。 */
  pathById(id: string): string | null {
    const row = this.db.prepare('SELECT path FROM entries WHERE id = ?').get(id) as { path: string } | undefined;
    return row?.path ?? null;
  }

  /** 该主题是否被人工审过（任一版本有 confirmations > 0）。供 `once` 策略判定。 */
  topicReviewedBefore(topic: string): boolean {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE topic = ? AND confirmations > 0',
    ).get(topic) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  }

  findActiveByTopic(topic: string): EntryRow | null {
    // 按 created 而非 last_confirmed：版次由创建时间定义。用 last_confirmed 时，
    // 对旧版跑一次 review --confirm 就会让它在 topic 检查里盖过真正的最新版，
    // 下次写入 supersede 错对象，新版反被孤立。与 guide.ts 的 fillDocSlot 口径一致。
    return (this.db.prepare(
      `SELECT * FROM entries WHERE topic = ? AND status = 'active' ORDER BY created DESC LIMIT 1`,
    ).get(topic) as unknown as EntryRow) ?? null;
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
    // 现场（QA P0-3）：三个进程并发写，两个在 catchUp → putSession 上抛 SQLITE_BUSY 直接退进程。
    // 对账是幂等的，重试安全。
    return withBusyRetry(() => this.catchUpInner());
  }

  private catchUpInner(): { scanned: number; reindexed: number; removed: number } {
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
    return withBusyRetry(() => this.putSessionInner(rec, body));
  }


  private putSessionInner(rec: SessionRecord, body = ''): void {
    this.db.prepare(`INSERT INTO sessions
      (session_id, project_fp, msg_count, last_ts, processed_at, agent, path, content_hash, api_state)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      project_fp = excluded.project_fp, msg_count = excluded.msg_count,
      last_ts = excluded.last_ts, processed_at = excluded.processed_at,
      agent = excluded.agent, path = excluded.path, content_hash = excluded.content_hash,
      api_state = excluded.api_state`).run(
      rec.session_id, rec.project_fp, rec.msg_count, rec.last_ts, rec.processed_at,
      rec.agent, rec.path, rec.content_hash, rec.api_state ?? null,
    );
    this.db.prepare('DELETE FROM sessions_fts WHERE session_key = ?').run(rec.session_id);
    if (body) {
      this.db.prepare('INSERT INTO sessions_fts (session_key, content) VALUES (?,?)').run(rec.session_id, body);
    }
  }

  removeSession(sessionId: string): void {
    return withBusyRetry(() => this.removeSessionInner(sessionId));
  }


  private removeSessionInner(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions_fts WHERE session_key = ?').run(sessionId);
  }

  /** 只更新 api_state 镜像列（写序：先改 session 文件，再调这里，文档 §3.5 规则 5）。 */
  setSessionApiState(sessionId: string, apiState: string | null): void {
    return withBusyRetry(() => this.setSessionApiStateInner(sessionId, apiState));
  }


  private setSessionApiStateInner(sessionId: string, apiState: string | null): void {
    this.db.prepare('UPDATE sessions SET api_state = ? WHERE session_id = ?').run(apiState, sessionId);
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
      // 快路径必须同时比对 api_state（文档 §3.5）：content_hash 只覆盖正文，
      // sync 拉回的 ok/skip 或外部改 frontmatter 都属于「正文未变、状态变了」，跳过就不回导。
      if (
        !force && prev && prev.path === path && prev.content_hash === stored.contentHash
        && (prev.api_state ?? null) === (stored.apiState ?? null)
      ) continue;
      this.putSession({
        session_id: key,
        agent: stored.agent,
        path,
        content_hash: stored.contentHash,
        api_state: stored.apiState ?? null,
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
