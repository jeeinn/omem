// 记忆生命周期（规格 §4）：四层 + 三机制。
// 核心原则：永不自动删除。supersede（必做）> reconfirmation（轻量）> decay（V0.1 不做）。
import { files } from './paths.js';
import type { OmemIndex } from './index.js';
import type { Located } from './store.js';
import { findById, listEntries, moveToArchive, updateEntry } from './store.js';
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
  // 状态标注优先于 verified：被取代/归档的 verified 条目（omem add 写的都是 verified）
  // 必须先显示 superseded/archived，否则消费者会把已作废的记忆当成有效确认记忆。
  if (fm.status === 'superseded') return `— superseded by ${fm.superseded_by ?? 'a newer entry'}`;
  if (fm.status === 'archived') return '— archived';
  if (fm.verified) return `— confirmed ${relTime(fm.last_confirmed)}`;
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
    fm.confidence = 0.9;
    fm.last_confirmed = nowIso();
    fm.confirmations += 1;
  });
  if (updated) index.upsert(updated.entry, updated.path, serializeEntry(updated.entry));
  return updated;
}

/** 自动产出上限。与 process/score.ts 的 SCORE_AUTO_CAP 同值同义；分开定义是为了避免 core ↔ process 循环依赖。 */
export const ASSENT_CAP = 0.8;

/**
 * 对话里的一次「同意」（assent）：分数提底到自动上限，verified 保持原样。
 * omem 看不到聊天记录，不能据此把条目标成已确认。
 *
 * confidence 是 max 语义（只升不降）：一条已经是 0.9 但未 verified 的条目，
 * assent 之后仍是 0.9。被限制的是 verified，不是分数。
 *
 * opts.refreshIndex 默认 true（保持 save_memory 的既有行为）；批量调用方传 false，
 * 由调用方在整批结束后统一重建一次热层。
 * opts.touchLastConfirmed 默认 false：MCP 的 confirm_ids 由 Agent 代传，可靠性低于
 * 用户在 --ui 页面亲手点击，因此只有后者刷新 last_confirmed。
 */
export function applyAssent(
  home: string,
  index: OmemIndex,
  ids: string[],
  opts: { refreshIndex?: boolean; touchLastConfirmed?: boolean } = {},
): { updated: string[]; missing: string[] } {
  const refreshIndex = opts.refreshIndex !== false;
  const touchLastConfirmed = opts.touchLastConfirmed === true;
  const updated: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const loc = updateEntry(home, id, (fm: Frontmatter) => {
      if (fm.confidence < ASSENT_CAP) fm.confidence = ASSENT_CAP;
      if (!fm.tags.includes('assent')) fm.tags.push('assent');
      fm.confirmations += 1;
      if (touchLastConfirmed) fm.last_confirmed = nowIso();
    });
    if (!loc) {
      missing.push(id);
      continue;
    }
    index.upsert(loc.entry, loc.path, serializeEntry(loc.entry));
    updated.push(id);
  }
  if (refreshIndex && updated.length > 0) generateMemoryIndex(home, index);
  return { updated, missing };
}

export type ReviewAction = 'confirm' | 'assent' | 'dismiss' | 'stale';

export interface ReviewDecision {
  id: string;
  action: ReviewAction;
  /** 仅 confirm 生效：用户在 --ui 页面展开过正文。false/undefined 时降级为 assent。 */
  read?: boolean;
}

export interface ReviewOutcome {
  id: string;
  requested: ReviewAction;
  /** 实际落地动作；仅 status='ok' 时有意义（confirm 因未读降级为 assent）。 */
  applied: ReviewAction | 'skipped';
  /** ok=已写入；skipped=被规则拒绝；missing=找不到条目。 */
  status: 'ok' | 'skipped' | 'missing';
  reason?: string;
  confidence?: number;
  verified?: boolean;
}

export interface ApplyReviewOpts {
  /** 未读的 confirm 是否降级为 assent。默认 true（--ui 用）；CLI 显式确认传 false。 */
  requireReadForVerified?: boolean;
  /** 末尾是否重建 MEMORY-INDEX。默认 true。 */
  refreshIndex?: boolean;
}

/**
 * 批量审阅决议（文档 §4.2 分级落章）。
 *
 * 与逐条调用单条路径相比只有三点不同：
 * 1. 每条重新校验 status——页面打开期间条目可能已被 Agent supersede；
 * 2. assent 按 action 聚合后一次性写入，末尾统一重建一次热层，避免 N 次全量扫描；
 * 3. 不整批回滚——单条失败记 skipped，其余照常，返回顺序与 decisions 一致。
 */
export function applyReviewDecisions(
  home: string,
  index: OmemIndex,
  decisions: ReviewDecision[],
  opts: ApplyReviewOpts = {},
): ReviewOutcome[] {
  const requireRead = opts.requireReadForVerified !== false;
  const refresh = opts.refreshIndex !== false;
  const outcomes: (ReviewOutcome | null)[] = Array.from({ length: decisions.length }, () => null);
  const seen = new Set<string>();
  const pending: { at: number; action: 'confirm' | 'assent' }[] = [];

  decisions.forEach((d, at) => {
    const skip = (status: ReviewOutcome['status'], reason: string): void => {
      outcomes[at] = { id: d.id, requested: d.action, applied: 'skipped', status, reason };
    };
    if (seen.has(d.id)) return skip('skipped', 'duplicate id in the same batch');
    seen.add(d.id);

    const loc = findById(home, d.id, { includeArchived: true });
    if (!loc) return skip('missing', 'Entry not found');
    const fm = loc.entry.fm;

    if (d.action === 'dismiss') {
      if (loc.location === 'archive' || fm.status === 'archived') return skip('skipped', 'already archived');
      const moved = moveToArchive(home, d.id);
      if (!moved) return skip('missing', 'Entry not found');
      index.upsert(moved.entry, moved.path, serializeEntry(moved.entry));
      outcomes[at] = {
        id: d.id,
        requested: d.action,
        applied: 'dismiss',
        status: 'ok',
        confidence: moved.entry.fm.confidence,
        verified: moved.entry.fm.verified,
      };
      return;
    }

    if (d.action === 'stale') {
      if (fm.status === 'stale') return skip('skipped', 'already cooled');
      if (fm.status !== 'active') return skip('skipped', `status is ${fm.status}`);
      const upd = updateEntry(home, d.id, (x: Frontmatter) => {
        x.status = 'stale';
      });
      if (!upd) return skip('missing', 'Entry not found');
      index.upsert(upd.entry, upd.path, serializeEntry(upd.entry));
      outcomes[at] = {
        id: d.id,
        requested: d.action,
        applied: 'stale',
        status: 'ok',
        confidence: upd.entry.fm.confidence,
        verified: upd.entry.fm.verified,
      };
      return;
    }

    // confirm / assent：只对 active 条目录用。已作废或已归档的条目确认无意义，
    // 而且会把 verified 写进一个不参与检索的文件。
    if (fm.status !== 'active') {
      const why = fm.status === 'superseded'
        ? `superseded by ${fm.superseded_by ?? 'a newer entry'}`
        : `status is ${fm.status}`;
      return skip('skipped', why);
    }
    const degrade = d.action === 'confirm' && requireRead && d.read !== true;
    pending.push({ at, action: degrade || d.action === 'assent' ? 'assent' : 'confirm' });
  });

  // assent：聚合后一次写入，避免逐条重建热层
  const assentAt = pending.filter((p) => p.action === 'assent').map((p) => p.at);
  if (assentAt.length > 0) {
    const ids = assentAt.map((at) => decisions[at].id);
    const res = applyAssent(home, index, ids, { refreshIndex: false, touchLastConfirmed: true });
    const written = new Set(res.updated);
    for (const at of assentAt) {
      const d = decisions[at];
      if (!written.has(d.id)) {
        outcomes[at] = { id: d.id, requested: d.action, applied: 'skipped', status: 'missing', reason: 'Entry disappeared' };
        continue;
      }
      const after = findById(home, d.id, { includeArchived: true });
      outcomes[at] = {
        id: d.id,
        requested: d.action,
        applied: 'assent',
        status: 'ok',
        confidence: after?.entry.fm.confidence,
        verified: after?.entry.fm.verified,
      };
    }
  }

  // confirm：reconfirm 是单条接口且不重建热层，循环即可
  for (const p of pending) {
    if (p.action !== 'confirm') continue;
    const d = decisions[p.at];
    const loc = reconfirm(home, index, d.id);
    if (!loc) {
      outcomes[p.at] = { id: d.id, requested: d.action, applied: 'skipped', status: 'missing', reason: 'Entry disappeared' };
      continue;
    }
    outcomes[p.at] = {
      id: d.id,
      requested: d.action,
      applied: 'confirm',
      status: 'ok',
      confidence: loc.entry.fm.confidence,
      verified: loc.entry.fm.verified,
    };
  }

  if (refresh && decisions.length > 0) generateMemoryIndex(home, index);
  return outcomes.map(
    (o, at) => o ?? {
      id: decisions[at].id,
      requested: decisions[at].action,
      applied: 'skipped',
      status: 'skipped',
      reason: 'not processed',
    },
  );
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
    const tags = ['#' + fm.type, '#' + fm.domain, ...(fm.topic ? [`topic:${fm.topic}`] : []), ...fm.tags.map((t) => '#' + t)].join(' ');
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
