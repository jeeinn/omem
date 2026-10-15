// omem gc：只标记 stale，只报告不删除（规格 §4.2/§7）。
// 阈值：--days N（默认 config.process.stale_after_days = 180）。
import { openCtx } from '../core/ctx.js';
import { gcScan, formatStaleness } from '../core/lifecycle.js';
import { deriveTitle } from '../core/entry.js';
import { truncate } from '../core/util.js';
import { flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdGc(args: ParsedArgs): Promise<number> {
  const { home, config, index } = openCtx();
  const daysArg = flagStr(args.flags, 'days');
  const days = daysArg ? Number(daysArg) : config.process.stale_after_days;
  if (!Number.isFinite(days) || days <= 0) {
    console.error('用法错误: --days 需为正数');
    return 1;
  }
  const { marked, total } = gcScan(home, index, { staleAfterDays: days, apply: true });
  console.log(`扫描 active ${total} 条（阈值 ${days} 天未确认）：标记 stale ${marked.length} 条（只标记，未删除）`);
  for (const l of marked) {
    console.log(`- \`${l.entry.fm.id}\` ${truncate(deriveTitle(l.entry.body), 50)} ${formatStaleness(l.entry.fm)}`);
  }
  if (marked.length > 0) {
    console.log('\nstale 条目检索时降权；确认后恢复：omem review --confirm <id>');
  }
  return 0;
}
