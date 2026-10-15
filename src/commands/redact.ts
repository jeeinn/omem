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
  if (!id) throw new UsageError('用法: omem redact --id <id>（硬删除，请谨慎；git 历史中仍可恢复）');
  const { home, config, index } = openCtx();
  const ok = deleteEntry(home, id);
  if (!ok) throw new UsageError(`未找到条目: ${id}`);
  index.remove(id);
  generateMemoryIndex(home, index);
  appendLog(home, 'redact', { id });
  console.log(`已硬删除: ${id}`);
  console.log('（数据仓 git 历史中仍可回溯：git -C ~/.omem log -- <文件路径>）');
  return 0;
}
