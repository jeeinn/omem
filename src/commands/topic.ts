// omem topics：活文档主题的可见性入口（D1-B′：topic 既是身份，也是文件名）。
//
// 为什么需要 list：PROCESS.md 之外，人需要一个「库里有哪些主题」的全量视图。
// 为什么需要 rename：改名 = 移动文件，得有一条会校验重名、会同步索引的安全通道。
import { rmSync } from 'node:fs';
import { openCtx } from '../core/ctx.js';
import { normalizeTopic } from '../core/entry.js';
import { listEntries, writeEntry } from '../core/store.js';
import { deriveTitle, serializeEntry } from '../core/entry.js';
import type { Ctx } from '../core/ctx.js';
import { UsageError } from '../core/util.js';
import { flagBool } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { Located } from '../core/store.js';

const USAGE =
  'Usage: omem topics [list] | '
  + 'omem topics rename <old> <new> [--dry-run]';
const NAME_WIDTH = 44;

interface TopicRow {
  name: string;
  named: string;
  last: string;
  confidence: number;
  title: string;
}

function sortByCreatedDesc(entries: Located[]): Located[] {
  return [...entries].sort((a, b) => ((a.entry.fm.created || '') < (b.entry.fm.created || '') ? 1 : -1));
}

/**
 * `omem topics rename <old> <new> [--dry-run]`：改名 = 移动文件。
 *
 * 拒绝重名而不是加后缀：`foo` 与 `foo-2` 并存会让「一个主题一份活文档」失效，
 * 而那个不变式正是这次重构的地基。
 */
function cmdTopicsRename(ctx: Ctx, args: ParsedArgs, dryRun: boolean): number {
  const rawOld = String(args._[1] ?? '').trim();
  const rawNew = args._[2];
  if (!rawOld || rawNew === undefined) throw new UsageError(USAGE);
  const oldName = normalizeTopic(rawOld);
  const newName = normalizeTopic(rawNew);
  if (!oldName || !newName) throw new UsageError('Topic must not be empty after normalization');
  if (oldName === newName) throw new UsageError('Old and new topic are the same.');

  const loc = listEntries(ctx.home, { includeArchived: true })
    .find((l) => l.entry.fm.topic === oldName);
  if (!loc) throw new UsageError(`Topic not found: ${oldName}`);

  const clash = listEntries(ctx.home).find((l) => l.entry.fm.topic === newName);
  if (clash) {
    throw new UsageError(
      `Target topic "${newName}" already exists (${deriveTitle(clash.entry.body, 40)}). Pick another name.`,
    );
  }

  if (dryRun) {
    console.log(`[dry-run] Would rename topic "${oldName}" → "${newName}" (file moves, history kept by git).`);
    return 0;
  }

  const fm = { ...loc.entry.fm, topic: newName };
  const entry = { ...loc.entry, fm };
  // 改名保持原位置：归档中的主题改名后仍在 archive/，不会被"复活"成 active。
  const written = writeEntry(ctx.home, entry, loc.location);
  // 旧路径必须删掉：留下两份 = 两个身份。
  if (written.path !== loc.path) rmSync(loc.path, { force: true });
  ctx.index.remove(oldName);
  ctx.index.upsert(entry, written.path, serializeEntry(entry));
  console.log(`Renamed topic "${oldName}" → "${newName}". File: ${written.path}`);
  return 0;
}

export async function cmdTopics(args: ParsedArgs): Promise<number> {
  const sub = args._[0] ?? 'list';
  if (sub !== 'list' && sub !== 'rename') throw new UsageError(USAGE);

  const dryRun = flagBool(args.flags, 'dry-run');
  const ctx = openCtx();
  try {
    if (sub === 'rename') return cmdTopicsRename(ctx, args, dryRun);

    const all = listEntries(ctx.home, { includeArchived: true });
    // 词表要含冷却（stale）的主题：它仍是活文档，只是不再「新鲜」。
    // 把 cooled 的主题藏起来，用户就会再造一个近重复的 topic——那正是这个命令要防的事。
    const living = all.filter((l) => l.entry.fm.status !== 'archived');

    const groups = new Map<string, Located[]>();
    for (const loc of living) {
      const name = loc.entry.fm.topic;
      const list = groups.get(name);
      if (list) list.push(loc);
      else groups.set(name, [loc]);
    }

    const rows: TopicRow[] = [...groups.entries()].map(([name, docs]) => {
      const sorted = sortByCreatedDesc(docs);
      const newest = sorted[0];
      return {
        name,
        named: newest.entry.fm.project ?? '-',
        last: (newest.entry.fm.created || '').slice(0, 10),
        confidence: newest.entry.fm.confidence,
        title: deriveTitle(newest.entry.body, 50),
      };
    });
    rows.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));

    if (rows.length === 0) {
      console.log('No living-document topics yet. Pass a topic when writing (every memory is one).');
      return 0;
    }

    console.log(`${rows.length} topic(s) · ${living.length} living document(s)`);
    console.log('');
    console.log(`${'TOPIC'.padEnd(NAME_WIDTH)}PROJECT  LAST        CONF  TITLE`);
    for (const r of rows) {
      const name = r.name.length > NAME_WIDTH - 1 ? `${r.name.slice(0, NAME_WIDTH - 2)}…` : r.name;
      console.log(
        `${name.padEnd(NAME_WIDTH)}${r.named.padEnd(9)}${r.last.padEnd(12)}${r.confidence.toFixed(2)}  ${r.title}`,
      );
    }
    return 0;
  } finally {
    ctx.index.close();
  }
}
