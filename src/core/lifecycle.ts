// 记忆生命周期（规格 §4）：四层 + 三机制。
// 核心原则：永不自动删除。原地更新（D1-B′）> reconfirmation（轻量）> decay（V0.1 不做）。
// 更新即重写同一份文件，版本由 git 承担——不再有 supersede 状态机。
import { files } from './paths.js';
import type { OmemIndex } from './index.js';
import type { Located } from './store.js';
import { findTopicIndexed, listEntries, moveToArchive, updateTopic } from './store.js';
import type { Frontmatter } from './entry.js';
import { deriveTitle, serializeEntry } from './entry.js';
import { relTime, truncate, atomicWrite, nowIso } from './util.js';

/** 时效标注（规格 §4.4）：把事实和时效一起给消费者，把判断权交给它。
 *
 * D2：不再有 `verified` 分支——「过目」由 `confirmations > 0` 表达（人工过目后 confidence = 0.9）。
 * 未过目的条目照实说「not reviewed」，而不是假装它没被记录过。
 */
export function formatStaleness(fm: Frontmatter): string {
  if (fm.status === 'archived') return '— archived';
  if (fm.confirmations > 0) return `— reviewed ${relTime(fm.last_confirmed)}`;
  if (fm.status === 'stale') return `— recorded ${relTime(fm.created)}, not reviewed (cooled)`;
  return `— recorded ${relTime(fm.created)}, not reviewed`;
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
        const updated = updateTopic(home, loc.entry.fm.topic, (fm: Frontmatter) => {
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

/** 确认刷新（规格 §4.2-2）：被 detail 取用或 review 确认时刷新 last_confirmed。
 *
 * D2：不再置 `verified`。过目的产出物是 confidence=0.9 + confirmations 递增 + last_confirmed 刷新，
 * 三者都能被复算，「过目」不再是一个会随时间漂移的布尔标记。
 */
export function reconfirm(home: string, index: OmemIndex, topic: string): Located | null {
  const updated = updateTopic(home, topic, (fm: Frontmatter) => {
    fm.confidence = REVIEW_CAP;
    fm.last_confirmed = nowIso();
    fm.confirmations += 1;
  });
  if (updated) index.upsert(updated.entry, updated.path, serializeEntry(updated.entry));
  return updated;
}

/** 人工过目后的置信度。与 process/score.ts 的 SCORE_CONFIRMED 同值同义；
 * 分开定义是为了避免 core ↔ process 循环依赖。 */
export const REVIEW_CAP = 0.9;

/** 自动产出上限。与 process/score.ts 的 SCORE_AUTO_CAP 同值同义；分开定义是为了避免 core ↔ process 循环依赖。 */
export const ASSENT_CAP = 0.8;

/**
 * 对话里的一次「同意」（assent）：分数提底到自动上限（0.8）。
 * omem 看不到聊天记录，不能据此把条目算作人工过目——过目只发生在 `omem review`。
 *
 * confidence 是 max 语义（只升不降）：一条已经是 0.9 的条目，assent 之后仍是 0.9。
 * 被限制的是「自动产出的上限」，不是分数。
 *
 * A-5 之后唯一的调用方是 `review --ui` 的分级落章：没展开正文就点「确认」的，
 * 降级成 assent（0.8），不算过目。MCP 侧已无盖章通道。
 *
 * opts.refreshIndex 默认 true；批量调用方传 false，由调用方在整批结束后统一重建一次热层。
 * opts.touchLastConfirmed 默认 false：只有用户在 --ui 页面亲手点击才算人工介入，才刷新 last_confirmed。
 */
export function applyAssent(
  home: string,
  index: OmemIndex,
  topics: string[],
  opts: { refreshIndex?: boolean; touchLastConfirmed?: boolean } = {},
): { updated: string[]; missing: string[] } {
  const refreshIndex = opts.refreshIndex !== false;
  const touchLastConfirmed = opts.touchLastConfirmed === true;
  const updated: string[] = [];
  const missing: string[] = [];
  for (const topic of topics) {
    const loc = updateTopic(home, topic, (fm: Frontmatter) => {
      if (fm.confidence < ASSENT_CAP) fm.confidence = ASSENT_CAP;
      if (!fm.tags.includes('assent')) fm.tags.push('assent');
      fm.confirmations += 1;
      if (touchLastConfirmed) fm.last_confirmed = nowIso();
    });
    if (!loc) {
      missing.push(topic);
      continue;
    }
    index.upsert(loc.entry, loc.path, serializeEntry(loc.entry));
    updated.push(topic);
  }
  if (refreshIndex && updated.length > 0) generateMemoryIndex(home, index);
  return { updated, missing };
}

export type ReviewAction = 'confirm' | 'assent' | 'dismiss' | 'stale';

export interface ReviewDecision {
  /** 身份 = 文件名（D1-B′）。 */
  topic: string;
  action: ReviewAction;
  /** 仅 confirm 生效：用户在 --ui 页面展开过正文。false/undefined 时降级为 assent。 */
  read?: boolean;
}

export interface ReviewOutcome {
  topic: string;
  requested: ReviewAction;
  /** 实际落地动作；仅 status='ok' 时有意义（confirm 因未读降级为 assent）。 */
  applied: ReviewAction | 'skipped';
  /** ok=已写入；skipped=被规则拒绝；missing=找不到条目。 */
  status: 'ok' | 'skipped' | 'missing';
  reason?: string;
  confidence?: number;
  /** 是否被人工过目过（D2：替代已删除的 `verified` 布尔位）。 */
  reviewed?: boolean;
}

export interface ApplyReviewOpts {
  /** 未读的 confirm 是否降级为 assent。默认 true（--ui 用）；CLI 显式确认传 false。 */
  requireReadForReview?: boolean;
  /** 末尾是否重建 MEMORY-INDEX。默认 true。 */
  refreshIndex?: boolean;
}

/**
 * 批量审阅决议（文档 §4.2 分级落章）。
 *
 * 与逐条调用单条路径相比只有三点不同：
 * 1. 每条重新校验 status——页面打开期间条目可能已被 Agent 覆盖；
 * 2. assent 按 action 聚合后一次性写入，末尾统一重建一次热层，避免 N 次全量扫描；
 * 3. 不整批回滚——单条失败记 skipped，其余照常，返回顺序与 decisions 一致。
 */
export function applyReviewDecisions(
  home: string,
  index: OmemIndex,
  decisions: ReviewDecision[],
  opts: ApplyReviewOpts = {},
): ReviewOutcome[] {
  const requireRead = opts.requireReadForReview !== false;
  const refresh = opts.refreshIndex !== false;
  const outcomes: (ReviewOutcome | null)[] = Array.from({ length: decisions.length }, () => null);
  const seen = new Set<string>();
  const pending: { at: number; action: 'confirm' | 'assent' }[] = [];

  decisions.forEach((d, at) => {
    const skip = (status: ReviewOutcome['status'], reason: string): void => {
      outcomes[at] = { topic: d.topic, requested: d.action, applied: 'skipped', status, reason };
    };
    if (seen.has(d.topic)) return skip('skipped', 'duplicate topic in the same batch');
    seen.add(d.topic);

    const loc = findTopicIndexed(home, index, d.topic, { includeArchived: true });
    if (!loc) return skip('missing', 'Entry not found');
    const fm = loc.entry.fm;

    if (d.action === 'dismiss') {
      if (loc.location === 'archive' || fm.status === 'archived') return skip('skipped', 'already archived');
      const moved = moveToArchive(home, d.topic);
      if (!moved) return skip('missing', 'Entry not found');
      index.upsert(moved.entry, moved.path, serializeEntry(moved.entry));
      outcomes[at] = {
        topic: d.topic,
        requested: d.action,
        applied: 'dismiss',
        status: 'ok',
        confidence: moved.entry.fm.confidence,
        reviewed: moved.entry.fm.confirmations > 0,
      };
      return;
    }

    if (d.action === 'stale') {
      if (fm.status === 'stale') return skip('skipped', 'already cooled');
      if (fm.status !== 'active') return skip('skipped', `status is ${fm.status}`);
      const upd = updateTopic(home, d.topic, (x: Frontmatter) => {
        x.status = 'stale';
      });
      if (!upd) return skip('missing', 'Entry not found');
      index.upsert(upd.entry, upd.path, serializeEntry(upd.entry));
      outcomes[at] = {
        topic: d.topic,
        requested: d.action,
        applied: 'stale',
        status: 'ok',
        confidence: upd.entry.fm.confidence,
        reviewed: upd.entry.fm.confirmations > 0,
      };
      return;
    }

    // confirm / assent：只对 active 条目录用。已归档的条目确认无意义，
    // 而且会把 0.9 的置信度写进一个不参与检索的文件。
    if (fm.status !== 'active') {
      return skip('skipped', `status is ${fm.status}`);
    }
    const degrade = d.action === 'confirm' && requireRead && d.read !== true;
    pending.push({ at, action: degrade || d.action === 'assent' ? 'assent' : 'confirm' });
  });

  // assent：聚合后一次写入，避免逐条重建热层
  const assentAt = pending.filter((p) => p.action === 'assent').map((p) => p.at);
  if (assentAt.length > 0) {
    const topics = assentAt.map((at) => decisions[at].topic);
    const res = applyAssent(home, index, topics, { refreshIndex: false, touchLastConfirmed: true });
    const written = new Set(res.updated);
    for (const at of assentAt) {
      const d = decisions[at];
      if (!written.has(d.topic)) {
        outcomes[at] = { topic: d.topic, requested: d.action, applied: 'skipped', status: 'missing', reason: 'Entry disappeared' };
        continue;
      }
      const after = findTopicIndexed(home, index, d.topic, { includeArchived: true });
      outcomes[at] = {
        topic: d.topic,
        requested: d.action,
        applied: 'assent',
        status: 'ok',
        confidence: after?.entry.fm.confidence,
        reviewed: (after?.entry.fm.confirmations ?? 0) > 0,
      };
    }
  }

  // confirm：reconfirm 是单条接口且不重建热层，循环即可
  for (const p of pending) {
    if (p.action !== 'confirm') continue;
    const d = decisions[p.at];
    const loc = reconfirm(home, index, d.topic);
    if (!loc) {
      outcomes[p.at] = { topic: d.topic, requested: d.action, applied: 'skipped', status: 'missing', reason: 'Entry disappeared' };
      continue;
    }
    outcomes[p.at] = {
      topic: d.topic,
      requested: d.action,
      applied: 'confirm',
      status: 'ok',
      confidence: loc.entry.fm.confidence,
      reviewed: loc.entry.fm.confirmations > 0,
    };
  }

  if (refresh && decisions.length > 0) generateMemoryIndex(home, index);
  return outcomes.map(
    (o, at) => o ?? {
      topic: decisions[at].topic,
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
  const archivedCount = all.filter((l) => l.entry.fm.status === 'archived').length;

  active.sort((a, b) => {
    // D2：没有 `verified` 位了。排序落 confidence → last_confirmed：数字可复算、结果确定。
    if (b.entry.fm.confidence !== a.entry.fm.confidence) return b.entry.fm.confidence - a.entry.fm.confidence;
    return b.entry.fm.last_confirmed.localeCompare(a.entry.fm.last_confirmed);
  });

  const MAX_LINES = 80;
  const lines: string[] = [
    '# MEMORY-INDEX (omem hot layer · auto-generated, do not edit)',
    '',
    `> Generated ${nowIso()} · active ${active.length} / stale ${staleCount} / archived ${archivedCount}`,
    '> This file is a derived view; use `omem search "<query>"` or MCP search_memory for details.',
    '',
  ];
  // 预算扣掉头部、截断提示行与尾部空行，保证总量 ≤80
  const budget = MAX_LINES - lines.length - 2;
  for (const loc of active.slice(0, Math.max(0, budget))) {
    const fm = loc.entry.fm;
    const title = truncate(deriveTitle(loc.entry.body), 50);
    const tags = ['#' + fm.type, '#' + fm.domain, ...(fm.topic ? [`topic:${fm.topic}`] : []), ...fm.tags.map((t) => '#' + t)].join(' ');
    lines.push(`- [${(fm.created || '').slice(0, 10)}] ${title} ${formatStaleness(fm)} · ${tags} · \`${fm.topic}\``);
  }
  if (active.length > budget) {
    lines.push(`- …${active.length - budget} more not shown (use omem search for the long tail)`);
  }
  lines.push('');
  const path = files.memoryIndex(home);
  atomicWrite(path, lines.join('\n'));
  return { path, lines: lines.length, total: active.length };
}
