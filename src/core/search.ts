// 检索引擎（规格 §8；spike 结论 2026-10-15）：
// - 查询各词 ≥3 字符 → FTS5 trigram MATCH，多词加引号得 AND 语义（子串/短语匹配）
// - 存在 <3 字符的词（如 2 字中文关键词）→ LIKE 兜底（trigram 对短词无效）
// - stale 条目按 stale_weight 降权（规格 §4.2 L2 冷却 ×0.5）， archived 默认排除（--all 才含）
import type { OmemIndex, EntryRow } from './index.js';

export interface SearchQuery {
  query: string;
  domain?: string;
  project?: string;
  all?: boolean;
  limit?: number;
  staleWeight?: number;
}

/** 按 code point 计数，避免中文被 UTF-16 surrogate 误判。 */
function charLen(s: string): number {
  return [...s].length;
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function searchEntries(index: OmemIndex, q: SearchQuery): EntryRow[] {
  const query = q.query.trim();
  if (!query) return [];
  const limit = q.limit && q.limit > 0 ? q.limit : 3;
  const staleWeight = q.staleWeight ?? 0.5;
  const db = index.db;
  const tokens = query.split(/\s+/).filter(Boolean);

  // 过滤条件按 SQL 占位符顺序收集参数
  const buildFilters = (): { sql: string; params: any[] } => {
    let sql = q.all ? '1=1' : "e.status != 'archived'";
    const params: any[] = [];
    if (q.domain) {
      sql += ' AND e.domain = ?';
      params.push(q.domain);
    }
    if (q.project) {
      sql += ' AND e.project = ?';
      params.push(q.project);
    }
    return { sql, params };
  };

  if (tokens.every((t) => charLen(t) >= 3)) {
    // ── 主路径：trigram MATCH ──
    const ftsq = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    const { sql: filters, params: fparams } = buildFilters();
    const stmt = db.prepare(`
      SELECT e.* FROM entries e
      JOIN entries_fts ON e.id = entries_fts.id
      WHERE entries_fts MATCH ?
        AND ${filters}
      ORDER BY (CASE WHEN e.status = 'stale' THEN ? ELSE 1.0 END) * bm25(entries_fts) ASC,
               e.last_confirmed DESC
      LIMIT ?
    `);
    return stmt.all(ftsq, ...fparams, staleWeight, limit) as unknown as EntryRow[];
  }

  // ── 兜底路径：LIKE（trigram 对 <3 字符查询无效） ──
  const { sql: filters, params: fparams } = buildFilters();
  const pattern = `%${escapeLike(query)}%`;
  // stale 降权同样作用于兜底路（规格 §4.2）：verified 保持第一键（人工确认优先于自动冷却），
  // 冷却权重作用在 confidence 上；与主路 bm25*weight 的语义对齐。
  const stmt = db.prepare(`
    SELECT e.* FROM entries e
    WHERE (e.id IN (SELECT id FROM entries_fts WHERE content LIKE ? ESCAPE '\\')
           OR e.title LIKE ? ESCAPE '\\'
           OR e.tags LIKE ? ESCAPE '\\')
      AND ${filters}
    ORDER BY e.verified DESC,
             (CASE WHEN e.status = 'stale' THEN ? ELSE 1.0 END) * e.confidence DESC,
             e.last_confirmed DESC
    LIMIT ?
  `);
  const rows = stmt.all(pattern, pattern, pattern, ...fparams, staleWeight, limit) as unknown as EntryRow[];
  if (rows.length > 0 || tokens.length < 2) return rows;

  // 整串无命中且为多词：退化为逐词 AND（都出现才算命中）
  const andSql = tokens.map(() => "content LIKE ? ESCAPE '\\'").join(' AND ');
  const stmt2 = db.prepare(`
    SELECT e.* FROM entries e
    WHERE e.id IN (SELECT id FROM entries_fts WHERE ${andSql})
      AND ${filters}
    ORDER BY e.verified DESC,
             (CASE WHEN e.status = 'stale' THEN ? ELSE 1.0 END) * e.confidence DESC,
             e.last_confirmed DESC
    LIMIT ?
  `);
  return stmt2.all(...tokens.map((t) => `%${escapeLike(t)}%`), ...fparams, staleWeight, limit) as unknown as EntryRow[];
}
