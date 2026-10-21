// omem run：加工会话（规格 §7）。采集器：claude-code、workbuddy、cursor，都只读。
// --since 7d|YYYY-MM-DD · --session <id> · --tier agent|api · --dry-run · --base/--model/--limit（API 档）
import { openCtx } from '../core/ctx.js';
import { runPipeline, runPipelineAsync, resolveTier } from '../process/pipeline.js';
import { UsageError } from '../core/util.js';
import { findRemovedConfigKeys } from '../core/config.js';
import { files } from '../core/paths.js';
import { flagBool, flagStr, flagNum } from '../cli-args.js';
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

    const report = tier === 'api'
      ? await runPipelineAsync(home, config, index, opts)
      : runPipeline(home, config, index, opts);

    // 残留的已移除配置键同样在这里点名：init 之外的用户日常也会跑 run，别让它一直沉默。
    for (const r of findRemovedConfigKeys(home)) {
      console.log(`config.toml: ignoring removed key ${r}`);
      console.log(`  → delete that line from ${files.config(home)} to avoid confusion.`);
    }

    if (tier === 'api') {
      console.log(
        `Processing complete (tier api${opts.dryRun ? ', dry-run' : ''}): sessions ${report.sessions} (skipped unchanged ${report.skipped}), `
          + `messages ${report.messages}, candidates ${report.candidates}, written ${report.written.length}, `
          + `deduped ${report.deduped}, failed ${report.failed ?? 0}, parse_failed ${report.parseFailed ?? 0}, quarantined ${report.quarantined ?? 0}`,
      );
    } else {
      console.log(
        `Processing complete (tier ${report.tier}${opts.dryRun ? ', dry-run' : ''}): sessions ${report.sessions} (skipped unchanged ${report.skipped}), `
          + `messages ${report.messages}, candidates ${report.candidates}, written ${report.written.length}, `
          + `deduped ${report.deduped}, redacted ${report.redacted}, excluded ${report.excluded}`,
      );
    }
    for (const n of report.notes) console.log(`  · ${n}`);
    return 0;
  } finally {
    // Windows 上 SQLite 句柄不释放会导致 OMEM_HOME 删除 EBUSY（同 cmdSync 的处置）
    index.close();
  }
}
