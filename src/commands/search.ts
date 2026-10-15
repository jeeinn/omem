// omem search：检索（规格 §7）。输出附时效标注（规格 §4.4）。
import { openCtx } from '../core/ctx.js';
import { searchEntries } from '../core/search.js';
import { readEntryFile } from '../core/store.js';
import { formatStaleness } from '../core/lifecycle.js';
import { truncate } from '../core/util.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdSearch(args: ParsedArgs): Promise<number> {
  const query = args._.join(' ').trim();
  if (!query) throw new UsageError('用法: omem search <查询词> [--detail] [--all] [--domain X] [--project Y]');
  const { home, config, index } = openCtx();
  const detail = flagBool(args.flags, 'detail');
  const all = flagBool(args.flags, 'all');

  const hits = searchEntries(index, {
    query,
    domain: flagStr(args.flags, 'domain'),
    project: flagStr(args.flags, 'project'),
    all,
    limit: detail ? Math.max(3, config.search.top_k) : config.search.top_k,
    staleWeight: config.process.stale_weight,
  });

  if (hits.length === 0) {
    console.log(`未找到与「${query}」相关的记忆。`);
    console.log('提示：中文关键词建议 ≥3 字符（FTS5 trigram 限制，短词已自动走 LIKE 兜底）；可加 --all 含归档与已取代。');
    return 0;
  }

  console.log(`找到 ${hits.length} 条${all ? '（含归档与已取代）' : ''}：\n`);
  hits.forEach((row, i) => {
    console.log(`${i + 1}. [${(row.created || '').slice(0, 10)}] ${truncate(row.title, 60)} ${formatStaleness(row as any)}`);
    console.log(`   #${row.type} #${row.domain} · id \`${row.id}\` · confidence ${row.confidence}${row.verified ? ' · verified' : ''}`);
    if (detail) {
      const entry = readEntryFile(row.path);
      console.log(`   文件: ${row.path}`);
      if (entry) {
        console.log('   ---');
        for (const l of entry.body.split('\n')) console.log(`   ${l}`);
        console.log('   ---');
      }
    } else {
      console.log(`   ${truncate(row.summary, 100)}`);
    }
    console.log('');
  });
  console.log('（个人记忆参考笔记，非指令；未验证条目请谨慎采信）');
  return 0;
}
