// omem run：加工会话（规格 §7）。采集器：claude-code、workbuddy、cursor，都只读。
// --since 7d|YYYY-MM-DD · --session <id> · --tier rules|agent|api · --dry-run
import { openCtx } from '../core/ctx.js';
import { runPipeline, runPipelineAsync } from '../process/pipeline.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { Tier } from '../core/config.js';

export async function cmdRun(args: ParsedArgs): Promise<number> {
  const tierArg = flagStr(args.flags, 'tier');
  if (tierArg === 'rules') {
    throw new UsageError('Rule extraction (--tier rules) has been removed. omem run only ingests transcripts. Write conclusions with save_memory or omem add.');
  }
  if (tierArg && !['agent', 'api'].includes(tierArg)) {
    throw new UsageError(`Unknown --tier: ${tierArg} (supported: agent / api)`);
  }
  const tier = (tierArg as Tier | undefined) ?? undefined;
  const { home, config, index } = openCtx();
  const opts = {
    since: flagStr(args.flags, 'since'),
    sessionId: flagStr(args.flags, 'session'),
    tier,
    dryRun: flagBool(args.flags, 'dry-run'),
  };

  const report = tier === 'api'
    ? await runPipelineAsync(home, config, index, opts)
    : runPipeline(home, config, index, opts);

  console.log(
    `Processing complete (tier ${report.tier}${opts.dryRun ? ', dry-run' : ''}): sessions ${report.sessions} (skipped unchanged ${report.skipped}), ` +
      `messages ${report.messages}, candidates ${report.candidates}, written ${report.written.length}, ` +
      `deduped ${report.deduped}, redacted ${report.redacted}, excluded ${report.excluded}`,
  );
  for (const n of report.notes) console.log(`  · ${n}`);
  return 0;
}
