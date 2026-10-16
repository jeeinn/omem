// omem snapshot：每日快照兜底（规格 §2.1；评估第 8 章数据丢失对策）。滚动保留 7 份。
import { openCtx } from '../core/ctx.js';
import { runSnapshot } from '../core/snapshot.js';
import { appendLog } from '../core/log.js';

export async function cmdSnapshot(): Promise<number> {
  const { home } = openCtx();
  const { path, pruned } = runSnapshot(home);
  appendLog(home, 'snapshot', { path, pruned: pruned.length });
  console.log(`Snapshot created: ${path}`);
  if (pruned.length > 0) console.log(`Pruned by rolling retention: ${pruned.join(', ')}`);
  return 0;
}
