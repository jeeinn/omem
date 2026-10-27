// omem review：短队列 + 按 id 打开正文。
// 默认只收「近 14 天写下的」和「置信度 ≤0.35 或带 ungrounded」的未确认活文档。
// --confirm / --dismiss / --stale 仍是原来的三个动作。
import { openCtx } from '../core/ctx.js';
import { findById, listEntries, moveToArchive, updateEntry } from '../core/store.js';
import { applyReviewDecisions, applySupersedes, formatStaleness, generateMemoryIndex, reconfirm } from '../core/lifecycle.js';
import { loadTopicPolicies } from '../core/review-policy.js';
import { serializeEntry } from '../core/entry.js';
import type { Frontmatter } from '../core/entry.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagNum, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import { DEFAULT_UI_TIMEOUT_MS, runReviewUi } from './review-ui.js';

const PAGE = 10;
const RECENT_DAYS = 14;

function idList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** 抽检队列：近两周的未确认文档，加上锚不上证据的（不随时间退出队列）。 */
export function inReviewInbox(fm: Frontmatter, now = Date.now()): boolean {
  if (fm.verified || fm.status !== 'active') return false;
  if (fm.confidence <= 0.35 || fm.tags.includes('ungrounded')) return true;
  const created = Date.parse(fm.created);
  if (!Number.isFinite(created)) return false;
  return now - created <= RECENT_DAYS * 86_400_000;
}

export async function cmdReview(args: ParsedArgs): Promise<number> {
  const ctx = openCtx();
  const { home, config, index } = ctx;
  try {
    return await reviewBody(args, home, config, index);
  } finally {
    index.close();
  }
}

async function reviewBody(
  args: ParsedArgs,
  home: string,
  config: ReturnType<typeof openCtx>['config'],
  index: ReturnType<typeof openCtx>['index'],
): Promise<number> {
  const confirmIds = idList(flagStr(args.flags, 'confirm'));
  const dismissId = flagStr(args.flags, 'dismiss');
  const staleId = flagStr(args.flags, 'stale');
  const supersedes = idList(flagStr(args.flags, 'supersedes'));
  if (supersedes.length > 0 && confirmIds.length === 0) {
    throw new UsageError('Usage: omem review --confirm <id> --supersedes <old-id>');
  }
  // 批量确认无法表达「哪个新文档取代哪个旧文档」：supersedes 是 N 个旧 id 对 1 个新文档，
  // 天然只属于单条确认。这里拒绝而不是猜测归属。
  if (supersedes.length > 0 && confirmIds.length > 1) {
    throw new UsageError('--supersedes requires a single --confirm id');
  }

  const uiMode = flagBool(args.flags, 'ui');
  if (uiMode && (confirmIds.length > 0 || dismissId || staleId || args._[0]?.trim())) {
    throw new UsageError('--ui cannot be combined with --confirm / --dismiss / --stale / <id>');
  }

  if (confirmIds.length > 0) {
    if (supersedes.length > 0) {
      const confirmId = confirmIds[0];
      const missing = supersedes.filter((id) => !findById(home, id, { includeArchived: true }));
      if (missing.length > 0) throw new UsageError(`Old entries not found: ${missing.join(', ')}`);
      const loc = reconfirm(home, index, confirmId);
      if (!loc) throw new UsageError(`Entry not found: ${confirmId}`);
      const updated = updateEntry(home, confirmId, (fm) => {
        fm.supersedes = supersedes;
      });
      if (!updated) throw new UsageError(`Entry not found: ${confirmId}`);
      index.upsert(updated.entry, updated.path, serializeEntry(updated.entry));
      const n = applySupersedes(home, index, updated);
      generateMemoryIndex(home, index);
      console.log(`Confirmed: ${confirmId} (verified=true, confirmations=${updated.entry.fm.confirmations})`);
      console.log(`Superseded ${n} entries: ${supersedes.join(', ')}`);
      return 0;
    }

    // 终端里敲 --confirm 是显式动作。没有「展开详情」的概念，所以不降级为 assent，
    // 保持 verified=true / confidence=0.9 的既有语义。
    const outcomes = applyReviewDecisions(
      home,
      index,
      confirmIds.map((id) => ({ id, action: 'confirm' as const })),
      { requireReadForVerified: false },
    );
    const ok = outcomes.filter((o) => o.status === 'ok');
    const failed = outcomes.filter((o) => o.status !== 'ok');
    if (ok.length === 0) {
      throw new UsageError(`Entry not found: ${failed.map((f) => f.id).join(', ')}`);
    }
    for (const o of ok) {
      const loc = findById(home, o.id, { includeArchived: true });
      console.log(`Confirmed: ${o.id} (verified=true, confirmations=${loc?.entry.fm.confirmations ?? '?'})`);
    }
    if (confirmIds.length > 1) {
      console.log(`Confirmed ${ok.length} of ${confirmIds.length} entries.`);
    }
    for (const f of failed) {
      console.log(`Skipped: ${f.id} — ${f.reason ?? f.status}`);
    }
    return 0;
  }
  if (dismissId) {
    const loc = moveToArchive(home, dismissId);
    if (!loc) throw new UsageError(`Entry not found: ${dismissId}`);
    index.upsert(loc.entry, loc.path, serializeEntry(loc.entry));
    console.log(`Archived (reversible; still searchable with --all under archive/): ${dismissId}`);
    return 0;
  }
  if (staleId) {
    const loc = updateEntry(home, staleId, (fm) => {
      fm.status = 'stale';
    });
    if (!loc) throw new UsageError(`Entry not found: ${staleId}`);
    index.upsert(loc.entry, loc.path, serializeEntry(loc.entry));
    console.log(`Manually cooled down: ${staleId}`);
    return 0;
  }

  const openId = args._[0]?.trim();
  if (openId) return showEntry(home, openId);

  const all = listEntries(home);
  const unverified = all.filter((l) => !l.entry.fm.verified && l.entry.fm.status === 'active');
  const inbox = unverified.filter((l) => inReviewInbox(l.entry.fm));

  // 主题级策略（review.toml）。低置信 / 未锚定的条目不静默——那是安全阀，
  // 无论策略怎么写都要人看一眼。
  const policies = loadTopicPolicies(home);
  const silenced = (fm: Frontmatter): boolean => {
    if (!fm.topic) return false;
    const policy = policies.get(fm.topic);
    if (!policy || policy === 'always') return false;
    if (fm.confidence <= 0.35 || fm.tags.includes('ungrounded')) return false;
    if (policy === 'never') return true;
    return index.topicReviewedBefore(fm.topic);
  };
  const silencedCount = inbox.filter((l) => silenced(l.entry.fm)).length;
  let queue = inbox.filter((l) => !silenced(l.entry.fm));
  const parked = unverified.length - queue.length;

  const printSilenced = (): void => {
    if (silencedCount === 0) return;
    console.log(
      `${silencedCount} entr${silencedCount === 1 ? 'y' : 'ies'} silenced by review.toml policy (not a defect; check omem topic list).`,
    );
  };
  const source = flagStr(args.flags, 'source');
  const topic = flagStr(args.flags, 'topic');
  if (source) queue = queue.filter((l) => l.entry.fm.source === source);
  if (topic) queue = queue.filter((l) => l.entry.fm.topic === topic);
  queue.sort((a, b) => (b.entry.fm.created || '').localeCompare(a.entry.fm.created || ''));

  const stale = all.filter((l) => l.entry.fm.status === 'stale');

  // --ui 复用同一份队列（含 --source / --topic 过滤），但全量交给页面：
  // 页面能滚动，PAGE=10 只是给终端输出省屏用的。
  if (uiMode) {
    if (queue.length === 0) {
      console.log('Queue is empty.');
      if (!source && !topic && parked > 0) {
        console.log(`${parked} older unverified entries stay in the library.`);
      }
      return 0;
    }
    const timeoutSec = flagNum(args.flags, 'timeout');
    return runReviewUi({
      home,
      index,
      entries: queue,
      noOpen: flagBool(args.flags, 'no-open'),
      port: flagNum(args.flags, 'port') ?? 0,
      timeoutMs: timeoutSec ? timeoutSec * 1000 : DEFAULT_UI_TIMEOUT_MS,
    });
  }

  const showAll = flagBool(args.flags, 'all');
  const shown = showAll ? queue : queue.slice(0, PAGE);

  if (shown.length === 0 && stale.length === 0) {
    console.log('Queue is empty.');
    printSilenced();
    if (!source && !topic && parked > 0) {
      console.log(`${parked} older unverified ${parked === 1 ? 'entry stays' : 'entries stay'} in the library.`);
    }
    return 0;
  }

  if (shown.length > 0) {
    const scope = showAll || queue.length <= PAGE ? '' : ' newest';
    console.log(`Pending ${queue.length} · showing ${shown.length}${scope}\n`);
    for (const l of shown) {
      const fm = l.entry.fm;
      console.log(`  ${fm.id}  ${fm.confidence.toFixed(2)}  ${fm.source.padEnd(6)} ${fm.topic ?? '-'}`);
    }
    console.log('');
    if (!showAll && queue.length > PAGE) {
      console.log(`  … ${queue.length - PAGE} more.  omem review --all`);
    }
    console.log('Open one:  omem review <id>');
  }
  if (stale.length > 0) {
    console.log(`Cooled: ${stale.length} (search weight ×${config.process.stale_weight}). Restore one with omem review --confirm <id>.`);
  }
  if (silencedCount > 0) {
    printSilenced();
  }
  return 0;
}

function showEntry(home: string, id: string): number {
  const loc = findById(home, id, { includeArchived: true });
  if (!loc) throw new UsageError(`Entry not found: ${id}`);
  const fm = loc.entry.fm;
  console.log(`File: ${loc.path}`);
  console.log(`confidence ${fm.confidence.toFixed(2)} · ${fm.source} · ${fm.type}${fm.topic ? ` · topic ${fm.topic}` : ''} ${formatStaleness(fm)}`);
  console.log('');
  console.log(loc.entry.body.trimEnd());
  console.log('');
  console.log('Next');
  console.log(`  omem review --confirm ${fm.id}`);
  console.log(`  omem review --dismiss ${fm.id}`);
  return 0;
}
