// omem redact：唯一硬删除途径（规格 §4.2 X 层；§7）。
// --id 删一条；--source 按来源批量删。删 Markdown 与索引行。git 历史仍可恢复。
import { openCtx } from '../core/ctx.js';
import { deleteEntry, listEntries } from '../core/store.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';
import { UsageError } from '../core/util.js';
import { flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { EntrySource } from '../core/entry.js';

const SOURCES: EntrySource[] = ['rules', 'agent', 'llm', 'manual'];
const USAGE = 'Usage: omem redact --id <id> | omem redact --source rules|agent|llm|manual (hard delete; still recoverable from git history)';

export async function cmdRedact(args: ParsedArgs): Promise<number> {
  const id = flagStr(args.flags, 'id');
  const source = flagStr(args.flags, 'source');
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
    const matches = listEntries(home, { includeArchived: true }).filter((l) => l.entry.fm.source === source);
    const ids = matches.map((l) => l.entry.fm.id);
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
