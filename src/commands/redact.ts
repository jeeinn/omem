// omem redact --id <id>：唯一硬删除途径（规格 §4.2 X 层；§7）。
// 删除 md 文件 + 索引条目。git 历史中仍可恢复（数据仓不丢历史）——这是最后的兜底。
import { openCtx } from '../core/ctx.js';
import { deleteEntry } from '../core/store.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';
import { UsageError } from '../core/util.js';
import { flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdRedact(args: ParsedArgs): Promise<number> {
  const id = flagStr(args.flags, 'id');
  if (!id) throw new UsageError('Usage: omem redact --id <id> (hard delete, use with care; still recoverable from git history)');
  const { home, config, index } = openCtx();
  const ok = deleteEntry(home, id);
  if (!ok) throw new UsageError(`Entry not found: ${id}`);
  index.remove(id);
  generateMemoryIndex(home, index);
  appendLog(home, 'redact', { id });
  console.log(`Hard deleted: ${id}`);
  console.log('(Still traceable in the data repo\'s git history: git -C ~/.omem log -- <file path>)');
  return 0;
}
