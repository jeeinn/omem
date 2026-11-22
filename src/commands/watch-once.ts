// v0.5.0 S2：有界驻留的一次性采集（omem sync --watch-once）。
//
// 这不是 daemon：进程在静默窗到期、或硬上限到点后必然退出，且全程无跨进程锁、
// 无后台生命周期、无自启配置。语义：先全量扫描 → 监听采集器根目录 → 静默窗无事件
// 则复扫确认 → 退出。事件去抖抑制风暴；多轮扫描合并成一次 git 提交。
//
// work profile 边界：assertExportAllowed 只挂在 omem backup（导出），omem sync 采集
// 本不受拦截；hook 自动触发的 watch-once 在 work profile 下会照常写本地库，因此这里
// 显式拒绝自动入口，要求用户手动跑 omem sync（保持既有 sync 语义不变）。
import { existsSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { openCtx } from '../core/ctx.js';
import { runPipeline, commitWatchedRun } from '../process/pipeline.js';
import { beginWriteJournal } from '../core/write-journal.js';
import { COLLECTOR_IDS, getCollector } from '../collect/collector.js';
import { currentProfile } from '../core/profile.js';
import { appendLog } from '../core/log.js';
import { UsageError } from '../core/util.js';
import { flagNum } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { OmemConfig } from '../core/config.js';
import type { OmemIndex } from '../core/index.js';

/** 默认静默窗 2s、总硬上限 30s；都可通过旗标调，且都有上界防慢泄漏变常驻。 */
const QUIET_MS_DEFAULT = 2_000;
const HARD_CAP_MS_DEFAULT = 30_000;
const HARD_CAP_MS_MAX = 120_000;
const DEBOUNCE_MS = 250;

interface WatchOnceResult {
  rounds: number;
  sessions: number;
  events: number;
  reason: 'quiet-window' | 'hard-cap' | 'no-roots';
  elapsedMs: number;
}

function collectorRoots(config: OmemConfig): string[] {
  const roots: string[] = [];
  for (const id of COLLECTOR_IDS) {
    try {
      const root = getCollector(id, config).root();
      if (existsSync(root)) roots.push(root);
    } catch { /* 单个采集器配置异常不拖垮整轮 */ }
  }
  return [...new Set(roots)];
}

/** 可测试的纯编排：watcher 由调用方注入，便于单测用假时钟推进。 */
export async function watchOnceLoop(opts: {
  roots: string[];
  quietMs: number;
  hardCapMs: number;
  scan: (round: number) => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  makeWatcher?: (root: string, onEvent: () => void) => FSWatcher | null;
}): Promise<WatchOnceResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const hardCap = Math.min(opts.hardCapMs, HARD_CAP_MS_MAX);
  let rounds = 0;
  let sessions = opts.scan(++rounds);
  let events = 0;
  let lastEvent = started;
  const watchers: FSWatcher[] = [];

  if (opts.roots.length === 0) {
    return { rounds, sessions, events, reason: 'no-roots', elapsedMs: now() - started };
  }

  const onEvent = (): void => {
    events++;
    lastEvent = now();
  };
  for (const root of opts.roots) {
    const w = (opts.makeWatcher ?? ((r, cb) => {
      try {
        const handle = watch(r, { recursive: false }, cb);
        // Windows 上 fs.watch 的句柄即使 close() 也可能留住事件循环；
        // unref 保证「静默窗到期即退出」不被 watcher 绑架。
        (handle as FSWatcher & { unref?: () => void }).unref?.();
        return handle;
      } catch { return null; }
    }))(root, onEvent);
    if (w) watchers.push(w);
  }

  let reason: WatchOnceResult['reason'] = 'quiet-window';
  try {
    // 静默窗：无事件持续 quietMs 即退出；硬上限兜底防止事件风暴让进程不退出。
    while (now() - started < hardCap) {
      if (now() - lastEvent >= opts.quietMs && now() - started >= DEBOUNCE_MS) break;
      await sleep(Math.min(DEBOUNCE_MS, Math.max(1, hardCap - (now() - started))));
    }
    if (now() - started >= hardCap) reason = 'hard-cap';
    // 复扫确认：只有真的发生过事件才需要第二轮，避免静默退出时多做一次无意义提交。
    if (events > 0) sessions += opts.scan(++rounds);
  } finally {
    for (const w of watchers) { try { w.close(); } catch { /* 已关闭 */ } }
  }
  return { rounds, sessions, events, reason, elapsedMs: now() - started };
}

export async function cmdWatchOnce(args: ParsedArgs, config: OmemConfig, index: OmemIndex, home: string): Promise<number> {
  if (currentProfile(config) === 'work') {
    throw new UsageError(
      'omem sync --watch-once is disabled on the work profile: an automatic collection hook would write company transcripts into the local memory store. ' +
      'Run `omem sync` manually instead (same collection, explicit user action), or switch profile with `omem profile use home`.',
    );
  }
  const quietMs = Math.max(200, Math.min(10_000, flagNum(args.flags, 'quiet-ms') ?? QUIET_MS_DEFAULT));
  const hardCapMs = Math.max(quietMs + 500, Math.min(HARD_CAP_MS_MAX, flagNum(args.flags, 'hard-cap-ms') ?? HARD_CAP_MS_DEFAULT));
  const roots = collectorRoots(config);

  // 多轮共用一个写台账：每轮 deferCommit，退出前合并成一次提交。
  const dryRun = Boolean(args.flags['dry-run']);
  if (!dryRun) beginWriteJournal();
  let result: WatchOnceResult | undefined;
  try {
    result = await watchOnceLoop({
      roots,
      quietMs,
      hardCapMs,
      scan: (round) => {
        const report = runPipeline(home, config, index, {
          tier: 'agent',
          deferCommit: !dryRun,
          dryRun,
        });
        appendLog(home, 'watch-once', { round, sessions: report.sessions });
        return report.sessions;
      },
    });
  } finally {
    // 异常也要收走台账，避免残留的 active 台账污染下一次写入。
    if (!dryRun) commitWatchedRun(home, config, result?.rounds ?? 1, result?.sessions ?? 0);
  }

  console.log(`watch-once: ${result.rounds} round(s), ${result.sessions} session(s), ${result.events} event(s), ${result.elapsedMs}ms (${result.reason}). Process exiting.`);
  appendLog(home, 'watch-once', { event: 'exit', ...result });
  return 0;
}
