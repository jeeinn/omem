// omem verify：从 md 重建内存视图 + 重渲染 MEMORY-INDEX + 账本复算比对（重构方案 §4 / §11）。
//
// 为什么 verify 要管三件事：索引本来就是派生物（重建它没有代价），MEMORY-INDEX.md 是人读的
// 视图（重渲染保证它不落后），而 confidence 是**信任数字**——它写在文件里，却由证据域决定，
// 证据域会变（会话被删、原文被改）。只重建不比对，等于只检查了「文件还在不在」。
import { openCtx } from '../core/ctx.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { verifyConfidence } from '../process/score.js';

export async function cmdVerify(): Promise<number> {
  const { home, index } = openCtx();
  const total = index.rebuild();
  const idx = generateMemoryIndex(home, index);
  console.log(`Index fully rebuilt: ${total} entries (in-memory index, derived from markdown)`);
  console.log(`MEMORY-INDEX.md regenerated: ${idx.lines} lines / ${idx.total} active entries`);

  // 复算只报告、不改写：自动改写会在每次 verify 时抖动 git 历史。
  const check = verifyConfidence(home, index);
  console.log(`Confidence check: ${check.checked} checked / ${check.skipped} skipped (manual, llm, human-reviewed)`);
  if (check.drifts.length === 0) {
    console.log('All checked entries match their ledger.');
    return 0;
  }
  console.log(`${check.drifts.length} entr(ies) differ from their ledger:`);
  for (const d of check.drifts) {
    const why = d.verdict === 'overstated'
      ? 'stored above ledger — the evidence may no longer anchor (session deleted or edited)'
      : 'stored below ledger — more independent sources exist than were counted';
    console.log(`  ${d.topic}  stored ${d.stored.toFixed(2)}  ledger ${d.min.toFixed(2)}–${d.max.toFixed(2)}  (${why})`);
  }
  console.log('Nothing was rewritten. Review the entries above, then update them by writing the topic again.');
  return 0;
}
