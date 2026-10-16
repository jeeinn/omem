// omem redact：唯一硬删除途径（规格 §4.2 X 层；§7）。
// --id 删一条（已点名，直接删）；--source 按来源批量删，**默认只预览，必须显式 --yes 才删**。
// 批量删除不可逆（只能靠数据仓 git 历史捞回），因此不允许一次按键误触——
// 预览会给出条数、占全库比例、域名/状态分布与样例，确认无误后再带 --yes 重跑。
import { openCtx } from '../core/ctx.js';
import { deleteEntry, listEntries } from '../core/store.js';
import type { Located } from '../core/store.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';
import { UsageError } from '../core/util.js';
import { flagStr, flagBool } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { EntrySource } from '../core/entry.js';

const SOURCES: EntrySource[] = ['rules', 'agent', 'llm', 'manual'];
const USAGE = 'Usage: omem redact --id <id> | omem redact --source rules|agent|llm|manual [--yes] (hard delete; still recoverable from git history)';
const SAMPLE_LIMIT = 5;

/** 批量预览：只打印将删什么，不动任何文件。 */
function printPreview(source: string, matches: Located[], total: number): void {
  console.log(`Dry run: ${matches.length} entries match source=${source}. Nothing was deleted.`);
  if (total > 0) {
    const pct = ((matches.length / total) * 100).toFixed(1);
    console.log(`  Coverage: ${matches.length}/${total} entries in the repo (${pct}%). ${total - matches.length} will be kept.`);
    if (matches.length === total) console.log('  ! This matches EVERY entry in the repo — it will be emptied.');
  }

  const tally = (pick: (fm: any) => string): string => {
    const m = new Map<string, number>();
    for (const l of matches) {
      const k = pick(l.entry.fm) || '(none)';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ');
  };
  console.log(`  By domain: ${tally((fm) => String(fm.domain ?? ''))}`);
  console.log(`  By status: ${tally((fm) => String(fm.status ?? ''))}`);

  console.log(`  Samples (max ${SAMPLE_LIMIT}):`);
  for (const l of matches.slice(0, SAMPLE_LIMIT)) {
    const c = String(l.entry.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    console.log(`    - ${l.entry.fm.id ?? '?'}  ${c}`);
  }

  console.log('');
  console.log('Hard delete cannot be undone except through the data repo\'s git history.');
  console.log(`Re-run to actually delete: omem redact --source ${source} --yes`);
}

export async function cmdRedact(args: ParsedArgs): Promise<number> {
  const id = flagStr(args.flags, 'id');
  const source = flagStr(args.flags, 'source');
  const yes = flagBool(args.flags, 'yes');
  if (id && source) throw new UsageError(USAGE);
  if (!id && !source) throw new UsageError(USAGE);
  const { home, index } = openCtx();
  try {
    if (id) {
      const ok = deleteEntry(home, id);
      if (!ok) throw new UsageError(`Entry not found: ${id}`);
      index.remove(id);
      generateMemoryIndex(home, index);
      appendLog(home, 'redact', { id });
      console.log(`Hard deleted: ${id}`);
      console.log('(Still traceable in the data repo\'s git history: git -C ~/.omem log -- <file path>)');
      return 0;
    }
    if (!SOURCES.includes(source as EntrySource)) throw new UsageError(USAGE);
    const all = listEntries(home, { includeArchived: true });
    const matches = all.filter((l) => l.entry.fm.source === source);
    const ids = matches.map((l) => l.entry.fm.id).filter((x): x is string => typeof x === 'string');

    if (ids.length === 0) {
      console.log(`No entries match source=${source}. Nothing to delete.`);
      return 0;
    }
    if (!yes) {
      printPreview(source!, matches, all.length);
      return 0;
    }

    for (const entryId of ids) {
      deleteEntry(home, entryId);
      index.remove(entryId);
    }
    generateMemoryIndex(home, index);
    appendLog(home, 'redact', { source, count: ids.length });
    console.log(`Hard deleted ${ids.length} entries (source=${source}).`);
    console.log('(Still traceable in the data repo\'s git history.)');
    return 0;
  } finally {
    index.close();
  }
}
