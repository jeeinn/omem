// 检索引擎（规格 §8；spike 结论 2026-10-15）：
// - 查询各词 ≥3 字符 → FTS5 trigram MATCH，多词加引号得 AND 语义（子串/短语匹配）
// - 存在 <3 字符的词（如 2 字中文关键词）→ LIKE 兜底（trigram 对短词无效）
// - stale 条目按 stale_weight 降权（规格 §4.2 L2 冷却 ×0.5）
// - archived 与 superseded 默认排除（--all 才含）
// - topic 是活文档的唯一标识，但不在 FTS 列里：按 topic 取文档走 entries.topic 等值过滤，
//   不给关键词时退化为「取该主题的活文档」，避免调用方只能靠「写失败」来发现 active id。
import type { OmemIndex, EntryRow } from './index.js';

export interface SearchQuery {
  /** 关键词。可省略——省略时必须给 topic，否则返回空。 */
  query?: string;
  /** 活文档主题，精确匹配。 */
  topic?: string;
  /** 显式状态集合（active / stale / superseded / archived）。给了就覆盖默认的「排除归档与被取代」。 */
  status?: string[];
  domain?: string;
  project?: string;
  all?: boolean;
  limit?: number;
  staleWeight?: number;
}

export interface SearchPage {
  rows: EntryRow[];
  /** 满足过滤条件的总数（不受 limit 影响）。 */
  matched: number;
}

/** 按 code point 计数，避免中文被 UTF-16 surrogate 误判。 */
function charLen(s: string): number {
  return [...s].length;
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * 过滤条件按 SQL 占位符顺序收集参数。
 *
 * status 与 all 的关系：显式 status 优先，其次 all，最后才是默认的「排除 archived/superseded」。
 * 这样调用方既能「只要 superseded 的历史版本」，也能「含全部状态」。
 */
function whereClause(q: SearchQuery): { sql: string; params: any[] } {
  const parts: string[] = [];
  const params: any[] = [];
  if (q.status && q.status.length > 0) {
    parts.push(`e.status IN (${q.status.map(() => '?').join(',')})`);
    params.push(...q.status);
  } else {
    parts.push(q.all ? '1=1' : "e.status NOT IN ('archived', 'superseded')");
  }
  if (q.topic) {
    parts.push('e.topic = ?');
    params.push(q.topic);
  }
  if (q.domain) {
    parts.push('e.domain = ?');
    params.push(q.domain);
  }
  if (q.project) {
    parts.push('e.project = ?');
    params.push(q.project);
  }
  return { sql: parts.join(' AND '), params };
}

function countOf(index: OmemIndex, sql: string, params: any[]): number {
  const row = index.db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 逐条检索并返回命中总数。MCP 需要「matched M · showing N」两句话，故同时给两个数。 */
export function searchEntriesPage(index: OmemIndex, q: SearchQuery): SearchPage {
  const query = (q.query ?? '').trim();
  const limit = q.limit && q.limit > 0 ? Math.floor(q.limit) : 3;
  const staleWeight = q.staleWeight ?? 0.5;
  const db = index.db;
  const { sql: filters, params: fparams } = whereClause(q);

  // ── 无关键词：只按 topic 取文档（按 created DESC，与 index.findActiveByTopic 同口径）──
  if (!query) {
    if (!q.topic) return { rows: [], matched: 0 };
    const matched = countOf(index, `SELECT COUNT(*) AS n FROM entries e WHERE ${filters}`, fparams);
    const rows = db.prepare(
      `SELECT e.* FROM entries e WHERE ${filters} ORDER BY e.created DESC LIMIT ?`,
    ).all(...fparams, limit) as unknown as EntryRow[];
    return { rows, matched };
  }

  const tokens = query.split(/\s+/).filter(Boolean);

  if (tokens.every((t) => charLen(t) >= 3)) {
    // ── 主路径：trigram MATCH ──
    const ftsq = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    const matched = countOf(
      index,
      `SELECT COUNT(*) AS n FROM entries e JOIN entries_fts ON e.id = entries_fts.id
       WHERE entries_fts MATCH ? AND ${filters}`,
      [ftsq, ...fparams],
    );
    const stmt = db.prepare(`
      SELECT e.*, bm25(entries_fts) AS rank FROM entries e
      JOIN entries_fts ON e.id = entries_fts.id
      WHERE entries_fts MATCH ?
        AND ${filters}
      ORDER BY (CASE WHEN e.status = 'stale' THEN ? ELSE 1.0 END) * e.confidence * bm25(entries_fts) ASC,
               e.verified DESC,
               e.last_confirmed DESC
      LIMIT ?
    `);
    const rows = stmt.all(ftsq, ...fparams, staleWeight, limit) as unknown as EntryRow[];
    return { rows, matched };
  }

  // ── 兜底路径：LIKE（trigram 对 <3 字符查询无效） ──
  // 与主路一致：先按 confidence（stale ×0.5）排，verified 只在分数相同时优先。
  const pattern = `%${escapeLike(query)}%`;
  const likeWhere = `(e.id IN (SELECT id FROM entries_fts WHERE content LIKE ? ESCAPE '\\')
           OR e.title LIKE ? ESCAPE '\\'
           OR e.tags LIKE ? ESCAPE '\\')
      AND ${filters}`;
  const likeOrder = `(CASE WHEN e.status = 'stale' THEN ? ELSE 1.0 END) * e.confidence DESC,
             e.verified DESC,
             e.last_confirmed DESC`;
  const stmt = db.prepare(`
    SELECT e.* FROM entries e
    WHERE ${likeWhere}
    ORDER BY ${likeOrder}
    LIMIT ?
  `);
  const rows = stmt.all(pattern, pattern, pattern, ...fparams, staleWeight, limit) as unknown as EntryRow[];
  if (rows.length > 0 || tokens.length < 2) {
    const matched = countOf(index, `SELECT COUNT(*) AS n FROM entries e WHERE ${likeWhere}`, [pattern, pattern, pattern, ...fparams]);
    return { rows, matched };
  }

  // 整串无命中且为多词：退化为逐词 AND（都出现才算命中）
  const andSql = tokens.map(() => "content LIKE ? ESCAPE '\\'").join(' AND ');
  const andWhere = `e.id IN (SELECT id FROM entries_fts WHERE ${andSql}) AND ${filters}`;
  const stmt2 = db.prepare(`
    SELECT e.* FROM entries e
    WHERE ${andWhere}
    ORDER BY ${likeOrder}
    LIMIT ?
  `);
  const rows2 = stmt2.all(...tokens.map((t) => `%${escapeLike(t)}%`), ...fparams, staleWeight, limit) as unknown as EntryRow[];
  const matched2 = countOf(index, `SELECT COUNT(*) AS n FROM entries e WHERE ${andWhere}`, [
    ...tokens.map((t) => `%${escapeLike(t)}%`),
    ...fparams,
  ]);
  return { rows: rows2, matched: matched2 };
}

/** 只要结果集的调用方（CLI、内部流程）用这个，签名保持不变。 */
export function searchEntries(index: OmemIndex, q: SearchQuery): EntryRow[] {
  return searchEntriesPage(index, q).rows;
}

export interface SessionHit {
  session_key: string;
  path: string;
  project_fp: string;
  last_ts: string;
  /**
   * 命中片段。FTS 路径由 snippet() 生成，LIKE 兜底路径由 manualSnippet() 截取命中位置附近
   * 的上下文——两条路径都不自带标记，『』由渲染层统一加（否则 FTS 路径会套两层）。
   */
  snippet?: string;
  /**
   * 该会话是否已被某份记忆吸收。searchSessions 不读 entries 表，自身填不了这个值——
   * 必须由调用方注入（见 guide.absorbedSessionIds）；未注入时 undefined，渲染层当作「未吸收」。
   */
  absorbed?: boolean;
}

/** 只查会话原文，不返回 knowledge 结论。 */
export function searchSessions(index: OmemIndex, query: string, limit = 3): SessionHit[] {
  const q = query.trim();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const db = index.db;
  if (tokens.every((t) => charLen(t) >= 3)) {
    const ftsq = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    return db.prepare(`
      SELECT s.session_id AS session_key, s.path AS path, s.project_fp AS project_fp, s.last_ts AS last_ts,
             snippet(sessions_fts, 1, '', '', '…', 12) AS snippet
      FROM sessions s
      JOIN sessions_fts ON s.session_id = sessions_fts.session_key
      WHERE sessions_fts MATCH ?
      ORDER BY bm25(sessions_fts) ASC
      LIMIT ?
    `).all(ftsq, limit) as unknown as SessionHit[];
  }
  const pattern = `%${escapeLike(q)}%`;
  const rows = db.prepare(`
    SELECT s.session_id AS session_key, s.path AS path, s.project_fp AS project_fp, s.last_ts AS last_ts,
           sessions_fts.content AS content
    FROM sessions s
    JOIN sessions_fts ON s.session_id = sessions_fts.session_key
    WHERE sessions_fts.content LIKE ? ESCAPE '\\'
    LIMIT ?
  `).all(pattern, limit) as unknown as (SessionHit & { content?: string })[];
  // LIKE 兜底路径用不上 snippet()（它只对 MATCH 生效），自己截一段命中附近的上下文，
  // 否则 2 字中文查询就只剩路径可看，调用方拿不到原文。标记与 FTS 路径一致地交给渲染层。
  //
  // 内存取舍：命中行通常极少——含 <3 字符的词建不了 FTS 索引，LIKE 全表扫后被 LIMIT 截走；
  // sessions 表规模预期有限，拉一列 content 回内存可接受。若未来 sessions 频繁落盘、规模增长，
  // 再把 manualSnippet 的截取下沉到 SQL SUBSTR（届时需处理 code point 偏移）。
  //
  // 口径差异：FTS 路径 snippet() 以 token 为单位（半径 12），manualSnippet 以 code point 为单位
  // （半径 40）——服务于不同消费方；且短词 LIKE 命中的 token 边界无意义，故各取适用。
  return rows.map(({ content, ...hit }) => ({ ...hit, snippet: manualSnippet(content ?? '', q) }));
}

/**
 * 命中位置附近的手工片段：code point 定位（中文不会被 UTF-16 截半）、
 * 大小写不敏感（对齐 SQLite LIKE 的默认行为）、换行压成空格。
 */
export function manualSnippet(content: string, needle: string, radius = 40): string {
  if (!content || !needle) return '';
  const at = content.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return '';
  const chars = [...content];
  const start = [...content.slice(0, at)].length;
  const len = [...needle].length;
  const from = Math.max(0, start - radius);
  const to = Math.min(chars.length, start + len + radius);
  const body = chars.slice(from, to).join('').replace(/\s+/g, ' ').trim();
  return (from > 0 ? '…' : '') + body + (to < chars.length ? '…' : '');
}
