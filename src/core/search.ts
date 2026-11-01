// 检索引擎（B 阶段：内存扫描 + 确定性排序；规格 §8 / 重构方案 §12）。
// 语料量级下暴力子串匹配是 1–2ms，不建倒排、不用 bm25：
// 排序规则必须是可解释、可复算的——命中词数 → 置信度（stale × weight）→ last_confirmed。
// D2：`verified` 已删，排序里也没有它：信任只剩 confidence 一个数字。
// 会话只搜 `## user` 证据域：assistant 段不能当证据，也不该出现在检索结果里。
import type { OmemIndex, EntryRow } from './index.js';
import { evidenceUserText, readStoredSession } from '../collect/session-store.js';

export interface SearchQuery {
  /** 关键词。可省略——省略时必须给 topic，否则返回空。 */
  query?: string;
  /** 活文档主题，精确匹配。 */
  topic?: string;
  /** 显式状态集合（active / stale / archived）。给了就覆盖默认的「排除归档」。 */
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

function charLen(s: string): number {
  return [...s].length;
}

interface Ranked {
  row: EntryRow;
  hits: number;
  score: number;
}

/**
 * 过滤 + 打分 + 排序（唯一裁决点）。
 *
 * 过滤与排序分开的理由：`matched` 要在截断前算总数，
 * 而排序只在「有查询词」时才需要——纯 topic 查询按 created 倒序，与历史口径一致。
 */
function rank(
  index: OmemIndex,
  q: SearchQuery,
  tokens: string[],
  staleWeight: number,
): Ranked[] {
  const out: Ranked[] = [];
  for (const { row, lower } of index.rows()) {
    if (q.status && q.status.length > 0) {
      if (!q.status.includes(row.status)) continue;
    } else if (!q.all && row.status === 'archived') {
      continue;
    }
    if (q.topic && row.topic !== q.topic) continue;
    if (q.domain && row.domain !== q.domain) continue;
    if (q.project && (row.project ?? '') !== q.project) continue;

    let hits = 0;
    if (tokens.length > 0) {
      const haystack = `${row.title}\n${lower}\n${row.tags}`.toLowerCase();
      let all = true;
      for (const t of tokens) {
        if (haystack.includes(t)) hits++;
        else {
          all = false;
          break;
        }
      }
      if (!all) continue;
    }

    const weight = row.status === 'stale' ? staleWeight : 1;
    out.push({ row, hits, score: hits * 1000 + row.confidence * weight * 100 });
    }
  out.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    if (b.score !== a.score) return b.score - a.score;
    return (b.row.last_confirmed || '').localeCompare(a.row.last_confirmed || '');
  });
  return out;
}

/** 逐条检索并返回命中总数。MCP 需要「matched M · showing N」两句话，故同时给两个数。 */
export function searchEntriesPage(index: OmemIndex, q: SearchQuery): SearchPage {
  const query = (q.query ?? '').trim();
  const limit = q.limit && q.limit > 0 ? Math.floor(q.limit) : 3;
  const staleWeight = q.staleWeight ?? 0.5;

  // 无关键词：只按 topic 取文档（按 created DESC，与 index.findActiveByTopic 同口径）
  if (!query) {
    if (!q.topic) return { rows: [], matched: 0 };
    const rows = rank(index, q, [], staleWeight)
      .map((r) => r.row)
      .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    return { rows: rows.slice(0, limit), matched: rows.length };
  }

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked = rank(index, q, tokens, staleWeight);
  const rows = ranked.slice(0, limit).map((r) => ({ ...r.row, rank: -r.hits }));
  return { rows, matched: ranked.length };
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
  /** 命中片段：截取自 `## user` 段；命中只落在 assistant 段时为空串。 */
  snippet?: string;
  absorbed?: boolean;
}

/**
 * 只查会话原文，不返回 knowledge 结论。
 *
 * 匹配与摘录都只走证据域：assistant 段是最"好读"的那一段，
 * 于是摘录越像人话，越可能是不能当证据的那一段。命中只在 assistant 段时
 * `snippet` 为空串，由渲染层说明「这段不能当证据」。
 */
export function searchSessions(index: OmemIndex, query: string, limit = 3): SessionHit[] {
  const q = query.trim();
  if (!q) return [];
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { hit: SessionHit; hits: number }[] = [];
  for (const { rec, lowerUserText } of index.sessionSlots()) {
    let all = true;
    let best = 0;
    for (const t of tokens) {
      if (!lowerUserText.includes(t)) {
        all = false;
        break;
      }
      best += lowerUserText.split(t).length - 1;
    }
    if (!all) continue;
    scored.push({
      hits: best,
      hit: {
        session_key: rec.session_id,
        path: rec.path,
        project_fp: rec.project_fp,
        last_ts: rec.last_ts,
        snippet: evidenceSnippet(rec.path, q),
      },
    });
  }
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, limit).map((s) => s.hit);
}

/** 在 `## user`（剥净元数据）上取命中窗口；读不到文件或只在 assistant 段命中时返回空串。 */
function evidenceSnippet(path: string, query: string): string {
  const stored = readStoredSession(path);
  if (!stored) return '';
  const needle = query.split(/\s+/)[0] ?? query;
  return manualSnippet(evidenceUserText(stored.body), needle);
}

/**
 * 命中位置附近的手工片段：code point 定位（中文不会被 UTF-16 截半）、
 * 大小写不敏感、换行压成空格。
 */
export function manualSnippet(content: string, needle: string, radius = 40): string {
  if (!content || !needle) return '';
  const at = content.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return '';
  const chars = [...content];
  const start = [...content.slice(0, at)].length;
  const len = charLen(needle);
  const from = Math.max(0, start - radius);
  const to = Math.min(chars.length, start + len + radius);
  const body = chars.slice(from, to).join('').replace(/\s+/g, ' ').trim();
  return (from > 0 ? '…' : '') + body + (to < chars.length ? '…' : '');
}
