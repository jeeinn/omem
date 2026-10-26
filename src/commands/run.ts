// omem sync：加工会话（规格 §7）。采集器：claude-code、workbuddy、cursor，都只读。
// 终端只打进度、总结和下一步。待办明细留在 PROCESS.md，不列到屏幕上。
// --since 7d|YYYY-MM-DD · --session <id> · --tier agent|api · --dry-run · --base/--model/--limit（API 档）
import { openCtx } from '../core/ctx.js';
import { runPipeline, runPipelineAsync, resolveTier, type RunReport } from '../process/pipeline.js';
import { UsageError } from '../core/util.js';
import { findRemovedConfigKeys } from '../core/config.js';
import { files } from '../core/paths.js';
import { createRunProgress } from '../cli-progress.js';
import { flagBool, flagStr, flagNum } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { Tier } from '../core/config.js';

/** 跑完后的总结和下一步。不包含会话路径或逐条结果。 */
export function runSummaryLines(report: RunReport, dryRun: boolean): string[] {
  const lines: string[] = ['Summary'];
  for (const n of report.notes) {
    if (n.includes('not found')) lines.push(`  ${n}`);
  }
  if (report.tier === 'api') {
    const elapsed = report.elapsedMs !== undefined ? ` · elapsed ${formatElapsed(report.elapsedMs)}` : '';
    lines.push(
      `  sessions ${report.sessions} (${report.skipped} unchanged) · written ${report.written.length} · `
        + `deduped ${report.deduped} · failed ${report.failed ?? 0} · parse_failed ${report.parseFailed ?? 0} · `
        + `quarantined ${report.quarantined ?? 0} · pending ${report.queuePending ?? 0}${elapsed}`,
    );
    lines.push('');
    lines.push('Next');
    if (dryRun) lines.push('  Drop --dry-run to call the endpoint.');
    else if ((report.queuePending ?? 0) > 0 || (report.failed ?? 0) > 0 || (report.parseFailed ?? 0) > 0) {
      lines.push('  omem sync --tier api     continue what is still pending');
      lines.push('  omem api status         see the endpoint and the queue');
    } else lines.push('  omem search "<query>"');
    if ((report.duplicateTopics ?? 0) > 0) {
      lines.push('  Possible duplicate topics were logged. Review them with omem review before they fragment.');
    }
    return lines;
  }
  const topics = report.waitingTopics ?? 0;
  const unassigned = report.waitingUnassigned ?? 0;
  lines.push(`  sessions ${report.sessions} (${report.skipped} unchanged) · messages ${report.messages}`);
  const waiting = `${topics} topic group(s) waiting` + (unassigned > 0 ? ` · ${unassigned} unassigned` : '');
  lines.push(`  ${waiting}${dryRun ? '' : ' · PROCESS.md updated'}`);
  lines.push('');
  lines.push('Next');
  if (dryRun) lines.push('  Drop --dry-run to write sessions and PROCESS.md.');
  else if (topics + unassigned > 0) {
    lines.push('  Read PROCESS.md, then save conclusions with save_memory or omem add.');
    lines.push('  omem search "<query>"');
  } else {
    lines.push('  Nothing is waiting. Run omem sync again after the next session.');
    lines.push('  omem search "<query>"');
  }
  return lines;
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

export async function cmdRun(args: ParsedArgs): Promise<number> {
  const tierArg = flagStr(args.flags, 'tier');
  if (tierArg === 'rules') {
    throw new UsageError('Rule extraction (--tier rules) has been removed. omem sync only ingests transcripts. Write conclusions with save_memory or omem add.');
  }
  if (tierArg && !['agent', 'api'].includes(tierArg)) {
    throw new UsageError(`Unknown --tier: ${tierArg} (supported: agent / api)`);
  }
  const { home, config, index } = openCtx();
  try {
    // 分发看 resolveTier 之后的档位（文档 §4）：default_tier=api 且不带 flag 也必须走 API 路径
    const { tier } = resolveTier(config, tierArg as Tier | undefined);
    const opts = {
      since: flagStr(args.flags, 'since'),
      sessionId: flagStr(args.flags, 'session'),
      tier,
      dryRun: flagBool(args.flags, 'dry-run'),
      apiBase: flagStr(args.flags, 'base'),
      apiModel: flagStr(args.flags, 'model'),
      apiLimit: flagNum(args.flags, 'limit'),
    };

    const progress = createRunProgress();
    let report;
    try {
      report = tier === 'api'
        ? await runPipelineAsync(home, config, index, { ...opts, onProgress: progress.update })
        : runPipeline(home, config, index, { ...opts, onProgress: progress.update });
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
