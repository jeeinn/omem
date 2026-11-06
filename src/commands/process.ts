// omem process：只 drain API 待加工队列，不扫采集器（见 docs/omem-process-command-plan.md）。
// --since / --session / --dry-run / --base / --model / --limit
import { openCtx } from '../core/ctx.js';
import { runApiProcess, type RunReport } from '../process/pipeline.js';
import { UsageError } from '../core/util.js';
import { findRemovedConfigKeys } from '../core/config.js';
import { files } from '../core/paths.js';
import { createRunProgress } from '../cli-progress.js';
import { flagBool, flagStr, flagNum } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

/** API 加工结束时的总结和下一步。 */
export function processSummaryLines(report: RunReport, dryRun: boolean): string[] {
  const lines: string[] = ['Summary'];
  for (const n of report.notes) {
    if (n.includes('not found') || n.startsWith('dry-run:')) lines.push(`  ${n}`);
  }
  const elapsed = report.elapsedMs !== undefined ? ` · elapsed ${formatElapsed(report.elapsedMs)}` : '';
  lines.push(
    `  sessions ${report.sessions} · written ${report.written.length} · `
      + `deduped ${report.deduped} · failed ${report.failed ?? 0} · parse_failed ${report.parseFailed ?? 0} · `
      + `quarantined ${report.quarantined ?? 0} · pending ${report.queuePending ?? 0}${elapsed}`,
  );
  lines.push('');
  lines.push('Next');
  if (dryRun) lines.push('  Drop --dry-run to call the endpoint.');
  else if ((report.queuePending ?? 0) > 0 || (report.failed ?? 0) > 0 || (report.parseFailed ?? 0) > 0) {
    lines.push('  omem process                  continue what is still pending');
    lines.push('  omem process --dry-run        see the endpoint, the queue and the rough size (no requests)');
  } else lines.push('  omem search "<query>"');
  if ((report.duplicateTopics ?? 0) > 0) {
    lines.push('  Possible duplicate topics were logged. Review them with omem review before they fragment.');
  }
  return lines;
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

export async function cmdProcess(args: ParsedArgs): Promise<number> {
  const extra = args._.filter((t) => t !== '');
  if (extra.length > 0) {
    throw new UsageError(
      `omem process takes no subcommand (got "${extra.join(' ')}"). It only drains the API queue; collect sessions with omem sync first.`,
    );
  }
  if (flagStr(args.flags, 'tier') !== undefined || flagBool(args.flags, 'tier')) {
    throw new UsageError('omem process has no --tier; it always uses the API queue. Collect with omem sync.');
  }
  if (flagStr(args.flags, 'collectors') !== undefined || flagBool(args.flags, 'collectors')) {
    throw new UsageError('omem process does not scan collectors. Run omem sync [--collectors …] first, then omem process.');
  }

  const { home, config, index } = openCtx();
  try {
    const opts = {
      since: flagStr(args.flags, 'since'),
      sessionId: flagStr(args.flags, 'session'),
      dryRun: flagBool(args.flags, 'dry-run'),
      apiBase: flagStr(args.flags, 'base'),
      apiModel: flagStr(args.flags, 'model'),
      apiLimit: flagNum(args.flags, 'limit'),
    };

    const progress = createRunProgress();
    let report: RunReport;
    try {
      report = await runApiProcess(home, config, index, { ...opts, onProgress: progress.update });
    } catch (e) {
      progress.clear();
      throw e;
    }
    progress.clear();

    for (const r of findRemovedConfigKeys(home)) {
      console.log(`config.toml: ignoring removed key ${r}`);
      console.log(`  → delete that line from ${files.config(home)} to avoid confusion.`);
    }

    for (const line of processSummaryLines(report, Boolean(opts.dryRun))) console.log(line);
    return 0;
  } finally {
    index.close();
  }
}
