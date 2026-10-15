// omem run：加工会话（规格 §7；V0.1 只采集 Claude Code）。
// --since 7d|YYYY-MM-DD · --session <id> · --tier rules|agent|api · --dry-run
import { openCtx } from '../core/ctx.js';
import { runPipeline, runPipelineAsync } from '../process/pipeline.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { Tier } from '../core/config.js';

export async function cmdRun(args: ParsedArgs): Promise<number> {
  const tierArg = flagStr(args.flags, 'tier');
  if (tierArg && !['rules', 'agent', 'api'].includes(tierArg)) {
    throw new UsageError(`未知 --tier: ${tierArg}（支持 rules / agent / api）`);
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
    `加工完成（档 ${report.tier}${opts.dryRun ? '，dry-run' : ''}）：会话 ${report.sessions}（跳过未变化 ${report.skipped}），` +
      `消息 ${report.messages}，候选 ${report.candidates}，写入 ${report.written.length}，` +
      `去重 ${report.deduped}，脱敏 ${report.redacted}，排除 ${report.excluded}`,
  );
  for (const n of report.notes) console.log(`  · ${n}`);
  return 0;
}
