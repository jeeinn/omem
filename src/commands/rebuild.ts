// omem rebuild：从 md 全量重建索引 + 重生成 MEMORY-INDEX（规格 §7；§2.3 一致性保证的落地）。
import { openCtx } from '../core/ctx.js';
import { generateMemoryIndex } from '../core/lifecycle.js';

export async function cmdRebuild(): Promise<number> {
  const { home, index } = openCtx();
  const total = index.rebuild();
  const idx = generateMemoryIndex(home, index);
  console.log(`索引已全量重建：${total} 条（index/omem.db）`);
  console.log(`MEMORY-INDEX.md 已重生成：${idx.lines} 行 / active ${idx.total} 条`);
  return 0;
}
