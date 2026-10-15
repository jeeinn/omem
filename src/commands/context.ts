// omem context --for <agent>：上下文导出（评估 4.2/4.5；规格 §7）。
// work profile 默认禁止导出（公司设备合规）——core/profile 守卫。
import { openCtx } from '../core/ctx.js';
import { exportContext, CONTEXT_TARGETS } from '../context/export.js';
import { assertExportAllowed } from '../core/profile.js';
import { appendLog } from '../core/log.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { UsageError } from '../core/util.js';
import { flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdContext(args: ParsedArgs): Promise<number> {
  const target = flagStr(args.flags, 'for');
  if (!target) {
    throw new UsageError(`用法: omem context --for <agent> [--out <file>]（支持: ${CONTEXT_TARGETS.join(' / ')}）`);
  }
  const { home, config, index } = openCtx();
  assertExportAllowed('omem context', config);
  const text = exportContext(home, index, target);
  const out = flagStr(args.flags, 'out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text, 'utf8');
    appendLog(home, 'context', { target, out });
    console.log(`已写入: ${out}`);
  } else {
    console.log(text);
  }
  return 0;
}
