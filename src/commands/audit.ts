// omem audit：使用日志尾部（规划 5.4-5 调用率可观测；评估 4.5 服务层审计）。
import { openCtx } from '../core/ctx.js';
import { tailLog } from '../core/log.js';
import { flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdAudit(args: ParsedArgs): Promise<number> {
  const { home } = openCtx();
  const n = Number(flagStr(args.flags, 'tail') ?? 20);
  const lines = tailLog(home, Number.isFinite(n) && n > 0 ? n : 20);
  if (lines.length === 0) {
    console.log('暂无使用日志。');
    return 0;
  }
  for (const l of lines) console.log(l);
  return 0;
}
