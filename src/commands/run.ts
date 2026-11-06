// omem sync：采集会话到 sessions/ 并刷新 PROCESS.md（规格 §7）。不调用模型。
// 采集器：claude-code、workbuddy、cursor、qwenwork 等，都只读。
// --since 7d|YYYY-MM-DD · --session <id> · --collectors id,id · --dry-run
// 兼容：--tier api 打印 deprecation 后只跑 process（不采集）；下一版可改为拒绝。
import { existsSync } from 'node:fs';
import { openCtx } from '../core/ctx.js';
import { runPipeline, resolveTier, type RunReport } from '../process/pipeline.js';
import { UsageError } from '../core/util.js';
import { findRemovedConfigKeys, type OmemConfig } from '../core/config.js';
import { files } from '../core/paths.js';
import { createRunProgress } from '../cli-progress.js';
import { flagBool, flagStr, flagList } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { Tier } from '../core/config.js';
import { COLLECTOR_IDS, getCollector, type CollectorId } from '../collect/collector.js';
import { cmdProcess, processSummaryLines } from './process.js';

/** 跑完后的总结和下一步。不包含会话路径或逐条结果。 */
export function runSummaryLines(report: RunReport, dryRun: boolean): string[] {
  const lines: string[] = ['Summary'];
  for (const n of report.notes) {
    if (n.includes('not found')) lines.push(`  ${n}`);
  }
  if (report.tier === 'api') {
    // 兼容路径：sync --tier api 已薄包装到 process，文案与 omem process 一致。
    return processSummaryLines(report, dryRun);
  }
  const topics = report.waitingTopics ?? 0;
  const unassigned = report.waitingUnassigned ?? 0;
  const waitingSessions = report.waitingSessions ?? 0;
  lines.push(`  sessions ${report.sessions} (${report.skipped} unchanged) · messages ${report.messages}`);
  const waiting = `${topics} topic group(s) / ${waitingSessions} session(s) waiting`
    + (unassigned > 0 ? ` · ${unassigned} unassigned` : '');
  lines.push(`  ${waiting}${dryRun ? '' : ' · PROCESS.md updated'}`);
  lines.push('');
  lines.push('Next');
  if (dryRun) lines.push('  Drop --dry-run to write sessions and PROCESS.md.');
  else if (topics + unassigned > 0) {
    lines.push('  Read PROCESS.md, then save conclusions with save_memory or omem add.');
    lines.push('  Or run omem process to drain the optional API queue.');
    lines.push('  omem search "<query>"');
  } else {
    lines.push('  Nothing is waiting. Run omem sync again after the next session.');
    lines.push('  omem search "<query>"');
  }
  return lines;
}

/** 缺省表示全量。空值或未知 id 是用法错误。 */
function parseCollectors(flags: ParsedArgs['flags']): CollectorId[] | undefined {
  const raw = flagStr(flags, 'collectors');
  if (raw === undefined) {
    if (flagBool(flags, 'collectors')) {
      throw new UsageError(`--collectors needs a list (${COLLECTOR_IDS.join(', ')})`);
    }
    return undefined;
  }
  const ids = [...new Set(flagList(flags, 'collectors'))];
  if (ids.length === 0) throw new UsageError(`--collectors needs a list (${COLLECTOR_IDS.join(', ')})`);
  const unknown = ids.filter((id) => !(COLLECTOR_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown collector: ${unknown.join(', ')} (supported: ${COLLECTOR_IDS.join(' / ')})`);
  }
  return ids as CollectorId[];
}

/** 目录不存在的不列。缺目录提示仍由流水线记在总结里。 */
function presentCollectors(config: OmemConfig, ids: readonly string[]): string[] {
  return ids.filter((id) => existsSync(getCollector(id, config).root()));
}

export async function cmdRun(args: ParsedArgs): Promise<number> {
  // 子命令一律拒绝：git 操作改名后归 omem backup（sync.ts 有同等保护）。
  // 曾经 `omem sync remote <url>` 会静默吞掉参数去跑采集并返回 0，用户以为远端配好了。
  const extra = args._.filter((t) => t !== '');
  if (extra.length > 0) {
    throw new UsageError(
      `omem sync takes no subcommand (got "${extra.join(' ')}"). Git operations live in omem backup: omem backup remote <url> | status | use <git|webdav|dir> | pull | push. omem sync only ingests session transcripts.`,
    );
  }
  const tierArg = flagStr(args.flags, 'tier');
  if (tierArg === 'rules') {
    throw new UsageError('Rule extraction (--tier rules) has been removed. omem sync only ingests transcripts. Write conclusions with save_memory or omem add.');
  }
  if (tierArg && !['agent', 'api'].includes(tierArg)) {
    throw new UsageError(`Unknown --tier: ${tierArg} (supported: agent / api). Prefer omem process for the API queue.`);
  }

  // 兼容一期：--tier api → 只跑 process，不采集（避免「只想 drain」时再扫一遍采集器）。
  if (tierArg === 'api') {
    console.warn(
      'Deprecated: omem sync --tier api. Use omem process instead (API drain only; sync no longer calls a model).',
    );
    if (flagStr(args.flags, 'collectors') !== undefined || flagBool(args.flags, 'collectors')) {
      console.warn('Note: --collectors is ignored on the deprecated sync --tier api path (no scan).');
    }
    // 剥掉 process 不认识的旗标，再交给同一条命令实现。
    const { tier: _tier, collectors: _collectors, ...rest } = args.flags;
    return cmdProcess({ _: args._, flags: rest });
  }

  const collectors = parseCollectors(args.flags);
  const { home, config, index } = openCtx();
  try {
    const present = presentCollectors(config, collectors ?? COLLECTOR_IDS);
    if (present.length > 0) console.log(`Collectors: ${present.join(', ')}`);

    // sync 永不调模型。default_tier=api 曾经让裸 sync 走 API——现改为只采集并提示。
    const { tier: resolved } = resolveTier(config, tierArg as Tier | undefined);
    if (resolved === 'api' && !tierArg) {
      console.warn(
        'Note: process.default_tier=api no longer makes omem sync call a model. Run omem process to drain the API queue.',
      );
    }

    const opts = {
      since: flagStr(args.flags, 'since'),
      sessionId: flagStr(args.flags, 'session'),
      collectors,
      tier: 'agent' as Tier,
      dryRun: flagBool(args.flags, 'dry-run'),
    };

    const progress = createRunProgress();
    let report;
    try {
      report = runPipeline(home, config, index, { ...opts, onProgress: progress.update });
    } catch (e) {
      progress.clear();
      throw e;
    }
    progress.clear();

    // 残留的已移除配置键同样在这里点名：init 之外的用户日常也会跑 run，别让它一直沉默。
    for (const r of findRemovedConfigKeys(home)) {
      console.log(`config.toml: ignoring removed key ${r}`);
      console.log(`  → delete that line from ${files.config(home)} to avoid confusion.`);
    }

    for (const line of runSummaryLines(report, Boolean(opts.dryRun))) console.log(line);
    return 0;
  } finally {
    // Windows 上 SQLite 句柄不释放会导致 OMEM_HOME 删除 EBUSY（同 cmdSync 的处置）
    index.close();
  }
}
