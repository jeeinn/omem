// omem verify：从 md 重建内存视图 + 重渲染 MEMORY-INDEX + 账本复算比对（重构方案 §4 / §11）。
//
// 为什么 verify 要管三件事：索引本来就是派生物（重建它没有代价），MEMORY-INDEX.md 是人读的
// 视图（重渲染保证它不落后），而 confidence 是**信任数字**——它写在文件里，却由证据域决定，
// 证据域会变（会话被删、原文被改）。只重建不比对，等于只检查了「文件还在不在」。
//
// --quotes（v0.4.0 T1）：审计 evidence_current 是否为 ## user 原文逐字子串。
// 只读报告；失败靠退出码 2 表达（policy rejection），不回写 frontmatter、不改 confidence。
import { openCtx } from '../core/ctx.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { driftNotice, verifyConfidence, verifyQuoteCoverage } from '../process/score.js';
import type { QuoteCoverage } from '../process/score.js';
import { appendLog } from '../core/log.js';
import { flagBool } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

/** 覆盖率报告的唯一渲染处：CLI 与潜在调用方共用，保证逐字可复现（不含时间戳）。 */
export function quoteCoverageNotice(c: QuoteCoverage): string[] {
  const ratio = c.ratio === null ? 'n/a (no quotes to check)' : `${(c.ratio * 100).toFixed(1)}%`;
  const lines = [
    `Quote coverage: ${c.matched}/${c.quotes} verified verbatim (${ratio})`,
    `  entries checked ${c.checked} · skipped ${c.skipped} · zero-quote ${c.noQuote} (listed separately, not in denominator)`,
  ];
  if (c.misses.length > 0) {
    lines.push(`  ${c.misses.length} miss(es):`);
    for (const m of c.misses) {
      const preview = m.quote.length > 60 ? `${m.quote.slice(0, 60)}…` : m.quote;
      lines.push(`    ${m.topic} [${m.layer}/${m.reason}] "${preview}"`);
    }
  } else if (c.quotes > 0) {
    lines.push('  Every quote is a verbatim substring of a ## user section.');
  }
  return lines;
}

async function cmdVerify(args: ParsedArgs): Promise<number> {
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
  } else {
    console.log(`${check.drifts.length} entr(ies) differ from their ledger:`);
    for (const d of check.drifts) {
      console.log(`  ${d.topic}  stored ${d.stored.toFixed(2)}  ledger ${d.min.toFixed(2)}–${d.max.toFixed(2)}  (${driftNotice(d)})`);
    }
    console.log('Nothing was rewritten. Review the entries above, then update them by writing the topic again.');
  }

  // --quotes：审计模式，独立退出码。无此旗标时 verify 行为与 v0.3.2 完全一致（永远返回 0）。
  if (flagBool(args.flags, 'quotes')) {
    const coverage = verifyQuoteCoverage(home, index);
    for (const line of quoteCoverageNotice(coverage)) console.log(line);
    appendLog(home, 'quote-coverage', {
      checked: coverage.checked,
      quotes: coverage.quotes,
      matched: coverage.matched,
      ratio: coverage.ratio,
      misses: coverage.misses.length,
      noQuote: coverage.noQuote,
      skipped: coverage.skipped,
    });
    return coverage.misses.length > 0 ? 2 : 0;
  }

  return 0;
}

export { cmdVerify };
