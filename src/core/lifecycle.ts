// 记忆生命周期（规格 §4）：四层 + 三机制。
// 核心原则：永不自动删除。supersede（必做）> reconfirmation（轻量）> decay（V0.1 不做）。
import { files } from './paths.js';
import type { OmemIndex } from './index.js';
import type { Located } from './store.js';
import { listEntries, updateEntry } from './store.js';
import type { Frontmatter } from './entry.js';
import { deriveTitle, serializeEntry } from './entry.js';
import { relTime, truncate, atomicWrite, nowIso } from './util.js';

/** 显式取代（规格 §4.2-1）：新条目声明 supersedes → 旧条目置 superseded 并回填 superseded_by。 */
export function applySupersedes(home: string, index: OmemIndex, newEntry: Located): number {
  let n = 0;
  for (const oldId of newEntry.entry.fm.supersedes) {
    if (oldId === newEntry.entry.fm.id) continue;
    const updated = updateEntry(home, oldId, (fm: Frontmatter) => {
      fm.status = 'superseded';
      fm.superseded_by = newEntry.entry.fm.id;
    });
    if (updated) {
      index.upsert(updated.entry, updated.path, serializeEntry(updated.entry));
      n++;
    }
  }
  return n;
}

/** 时效标注（规格 §4.4）：把事实和时效一起给消费者，把判断权交给它。 */
export function formatStaleness(fm: Frontmatter): string {
  if (fm.verified) return `— confirmed ${relTime(fm.last_confirmed)}`;
  if (fm.status === 'superseded') return `— superseded by ${fm.superseded_by ?? 'a newer entry'}`;
  if (fm.status === 'stale') return `— recorded ${relTime(fm.created)}, not reconfirmed (cooled)`;
  return `— recorded ${relTime(fm.created)}, unconfirmed`;
}

/** gc：只标记 stale，只报告不删除（规格 §4.2/§7）。 */
export function gcScan(
  home: string,
  index: OmemIndex,
  opts: { staleAfterDays: number; apply: boolean },
): { marked: Located[]; total: number } {
  const cutoff = Date.now() - opts.staleAfterDays * 86_400_000;
  const marked: Located[] = [];
  let total = 0;
  for (const loc of listEntries(home)) {
    if (loc.entry.fm.status !== 'active') continue;
    total++;
    const t = new Date(loc.entry.fm.last_confirmed || loc.entry.fm.created).getTime();
    if (t < cutoff) {
      if (opts.apply) {
        const updated = updateEntry(home, loc.entry.fm.id, (fm: Frontmatter) => {
          fm.status = 'stale';
        });
        if (updated) {
          index.upsert(updated.entry, updated.path, serializeEntry(updated.entry));
          marked.push(updated);
        }
      } else {
        marked.push(loc);
      }
    }
  }
  return { marked, total };
}

/** 确认刷新（规格 §4.2-2）：被 detail 取用或 review 确认时刷新 last_confirmed/confirmations。 */
export function reconfirm(home: string, index: OmemIndex, id: string): Located | null {
  const updated = updateEntry(home, id, (fm: Frontmatter) => {
    fm.verified = true;
    fm.last_confirmed = nowIso();
    fm.confirmations += 1;
  });
  if (updated) index.upsert(updated.entry, updated.path, serializeEntry(updated.entry));
  return updated;
}

/** L0 热层：MEMORY-INDEX.md（≤80 行，派生视图，rebuild 时重生成；规格 §2.1/§4.2）。 */
export function generateMemoryIndex(home: string, index: OmemIndex): { path: string; lines: number; total: number } {
  const all = listEntries(home);
  const active = all.filter((l) => l.entry.fm.status === 'active');
  const staleCount = all.filter((l) => l.entry.fm.status === 'stale').length;
  const supersededCount = all.filter((l) => l.entry.fm.status === 'superseded').length;
  const archivedCount = all.filter((l) => l.entry.fm.status === 'archived').length;

  active.sort((a, b) => {
    if (a.entry.fm.verified !== b.entry.fm.verified) return a.entry.fm.verified ? -1 : 1;
    if (b.entry.fm.confidence !== a.entry.fm.confidence) return b.entry.fm.confidence - a.entry.fm.confidence;
    return b.entry.fm.last_confirmed.localeCompare(a.entry.fm.last_confirmed);
  });

  const MAX_LINES = 80;
  const lines: string[] = [
    '# MEMORY-INDEX (omem hot layer · auto-generated, do not edit)',
    '',
    `> Generated ${nowIso()} · active ${active.length} / stale ${staleCount} / superseded ${supersededCount} / archived ${archivedCount}`,
    '> This file is a derived view; use `omem search "<query>"` or MCP search_memory for details.',
    '',
  ];
  // 预算扣掉头部、截断提示行与尾部空行，保证总量 ≤80
  const budget = MAX_LINES - lines.length - 2;
  for (const loc of active.slice(0, Math.max(0, budget))) {
    const fm = loc.entry.fm;
    const title = truncate(deriveTitle(loc.entry.body), 50);
    const tags = ['#' + fm.type, '#' + fm.domain, ...fm.tags.map((t) => '#' + t)].join(' ');
    lines.push(`- [${(fm.created || '').slice(0, 10)}] ${title} ${formatStaleness(fm)} · ${tags} · \`${fm.id}\``);
  }
  if (active.length > budget) {
    lines.push(`- …${active.length - budget} more not shown (use omem search for the long tail)`);
  }
  lines.push('');
  const path = files.memoryIndex(home);
  atomicWrite(path, lines.join('\n'));
  return { path, lines: lines.length, total: active.length };
}
