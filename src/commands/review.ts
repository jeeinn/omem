// omem review：短队列 + 按 topic 打开正文。
// 默认只收「近 14 天写下的」和「置信度 ≤0.35 或带 ungrounded」的未确认活文档。
// --confirm / --dismiss / --stale 仍是原来的三个动作；身份是 topic（D1-B′）。
import { openCtx } from '../core/ctx.js';
import { findTopicIndexed, listEntries, moveToArchive, updateTopic } from '../core/store.js';
import { applyReviewDecisions, formatStaleness, gcScan } from '../core/lifecycle.js';
import { deriveTitle } from '../core/entry.js';
import { truncate } from '../core/util.js';
import { loadTopicPolicies } from '../core/review-policy.js';
import { serializeEntry } from '../core/entry.js';
import type { Frontmatter } from '../core/entry.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagNum, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import { DEFAULT_UI_TIMEOUT_MS, runReviewUi } from './review-ui.js';

const PAGE = 10;
const RECENT_DAYS = 14;

function topicList(raw: string | undefined): string[] {
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
  const confirmTopics = topicList(flagStr(args.flags, 'confirm'));
  const dismissTopic = flagStr(args.flags, 'dismiss');
  const staleTopic = flagStr(args.flags, 'stale');
  if (flagStr(args.flags, 'supersedes')) {
    throw new UsageError('--supersedes has been removed: writing to a topic overwrites its document (git keeps the history).');
  }

  // D8：冷却扫描并入 review（原 omem gc）。它是「人工动作」的一种，
  // 独立成命令只会让命令面板里多一条一年用一次的入口。
  if (flagBool(args.flags, 'gc')) {
    const days = flagNum(args.flags, 'days') ?? config.process.stale_after_days;
    if (!Number.isFinite(days) || days <= 0) throw new UsageError('--days must be a positive number');
    const { marked, total } = gcScan(home, index, { staleAfterDays: days, apply: true });
    console.log(
      `Scanned ${total} active documents (threshold: ${days} days unconfirmed): marked ${marked.length} stale (marked only, nothing deleted)`,
    );
    for (const l of marked) {
      console.log(`- \`${l.entry.fm.topic}\` ${truncate(deriveTitle(l.entry.body), 50)} ${formatStaleness(l.entry.fm)}`);
    }
    if (marked.length > 0) console.log('\nStale documents are down-weighted in search; restore one with omem review --confirm <topic>');
    return 0;
  }

  const uiMode = flagBool(args.flags, 'ui');
  if (uiMode && (confirmTopics.length > 0 || dismissTopic || staleTopic || args._[0]?.trim())) {
    throw new UsageError('--ui cannot be combined with --confirm / --dismiss / --stale / <topic>');
  }

  if (confirmTopics.length > 0) {
    // 终端里敲 --confirm 是显式动作。没有「展开详情」的概念，所以不降级为 assent，
    // 保持 verified=true / confidence=0.9 的既有语义。
    const outcomes = applyReviewDecisions(
      home,
      index,
      confirmTopics.map((topic) => ({ topic, action: 'confirm' as const })),
      { requireReadForVerified: false },
    );
    const ok = outcomes.filter((o) => o.status === 'ok');
    const failed = outcomes.filter((o) => o.status !== 'ok');
    if (ok.length === 0) {
      throw new UsageError(`Topic not found: ${failed.map((f) => f.topic).join(', ')}`);
    }
    for (const o of ok) {
      const loc = findTopicIndexed(home, index, o.topic, { includeArchived: true });
      console.log(`Confirmed: ${o.topic} (verified=true, confirmations=${loc?.entry.fm.confirmations ?? '?'})`);
    }
    if (confirmTopics.length > 1) {
      console.log(`Confirmed ${ok.length} of ${confirmTopics.length} entries.`);
    }
    for (const f of failed) {
      console.log(`Skipped: ${f.topic} — ${f.reason ?? f.status}`);
    }
    return 0;
  }
  if (dismissTopic) {
    const loc = moveToArchive(home, dismissTopic);
    if (!loc) throw new UsageError(`Topic not found: ${dismissTopic}`);
    index.upsert(loc.entry, loc.path, serializeEntry(loc.entry));
    console.log(`Archived (reversible; still searchable with --all under archive/): ${dismissTopic}`);
    return 0;
  }
  if (staleTopic) {
    const loc = updateTopic(home, staleTopic, (fm) => {
      fm.status = 'stale';
    });
    if (!loc) throw new UsageError(`Topic not found: ${staleTopic}`);
    index.upsert(loc.entry, loc.path, serializeEntry(loc.entry));
    console.log(`Manually cooled down: ${staleTopic}`);
    return 0;
  }

  const openTopic = args._[0]?.trim();
  if (openTopic) return showEntry(home, index, openTopic);

  const all = listEntries(home);
  const unverified = all.filter((l) => !l.entry.fm.verified && l.entry.fm.status === 'active');
  const inbox = unverified.filter((l) => inReviewInbox(l.entry.fm));

  // 主题级策略（review.toml）。低置信 / 未锚定的条目不静默——那是安全阀，
  // 无论策略怎么写都要人看一眼。
  const policies = loadTopicPolicies(home);
  const silenced = (fm: Frontmatter): boolean => {
    const policy = policies.get(fm.topic);
    if (!policy || policy === 'always') return false;
    if (fm.confidence <= 0.35 || fm.tags.includes('ungrounded')) return false;
    if (policy === 'never') return true;
    return index.topicReviewedBefore(fm.topic);
  };
  const silencedCount = inbox.filter((l) => silenced(l.entry.fm)).length;
  let queue = inbox.filter((l) => !silenced(l.entry.fm));
  // 只统计 14 天窗口外的旧条目。被策略静默的数量单独报告（printSilenced）：
  // 把两者混进一个数字，会让「older」这个形容词变成错的。
  const olderParked = unverified.length - inbox.length;

  const printSilenced = (): void => {
    if (silencedCount === 0) return;
    console.log(
      `${silencedCount} entr${silencedCount === 1 ? 'y' : 'ies'} silenced by review.toml policy (not a defect; check omem topics list).`,
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
      printSilenced();
      if (!source && !topic && olderParked > 0) {
        console.log(`${olderParked} older unverified ${olderParked === 1 ? 'entry stays' : 'entries stay'} in the library.`);
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
    if (!source && !topic && olderParked > 0) {
      console.log(`${olderParked} older unverified ${olderParked === 1 ? 'entry stays' : 'entries stay'} in the library.`);
    }
    return 0;
  }

  if (shown.length > 0) {
    const scope = showAll || queue.length <= PAGE ? '' : ' newest';
    console.log(`Pending ${queue.length} · showing ${shown.length}${scope}\n`);
    for (const l of shown) {
      const fm = l.entry.fm;
      console.log(`  ${fm.topic}  ${fm.confidence.toFixed(2)}  ${fm.source.padEnd(6)} ${fm.domain}`);
    }
    console.log('');
    if (!showAll && queue.length > PAGE) {
      console.log(`  … ${queue.length - PAGE} more.  omem review --all`);
    }
    console.log('Open one:  omem review <topic>');
  }
  if (stale.length > 0) {
    console.log(`Cooled: ${stale.length} (search weight ×${config.process.stale_weight}). Restore one with omem review --confirm <topic>.`);
  }
  if (silencedCount > 0) {
    printSilenced();
  }
  return 0;
}

function showEntry(home: string, index: ReturnType<typeof openCtx>['index'], topic: string): number {
  const loc = findTopicIndexed(home, index, topic, { includeArchived: true });
  if (!loc) throw new UsageError(`Topic not found: ${topic}`);
  const fm = loc.entry.fm;
  console.log(`File: ${loc.path}`);
  console.log(`confidence ${fm.confidence.toFixed(2)} · ${fm.source} · ${fm.type} · topic ${fm.topic} ${formatStaleness(fm)}`);
  console.log('');
  console.log(loc.entry.body.trimEnd());
  console.log('');
  console.log('Next');
  console.log(`  omem review --confirm ${fm.topic}`);
  console.log(`  omem review --dismiss ${fm.topic}`);
  return 0;
}
