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
import { TOPIC_POLICIES, loadTopicPolicies, saveTopicPolicy } from '../core/review-policy.js';
import type { TopicPolicy } from '../core/review-policy.js';

const USAGE =
  'Usage: omem topics [list] [--all] | omem topics policy <topic> always|once|never|default | '
  + 'omem topics rename <old> <new> [--dry-run]';
const NAME_WIDTH = 44;

interface TopicRow {
  name: string;
  named: string;
  last: string;
  confidence: number;
  policy: TopicPolicy;
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
  if (sub !== 'list' && sub !== 'policy' && sub !== 'rename') throw new UsageError(USAGE);

  const dryRun = flagBool(args.flags, 'dry-run');
  const ctx = openCtx();
  try {
    if (sub === 'rename') return cmdTopicsRename(ctx, args, dryRun);

    const all = listEntries(ctx.home, { includeArchived: true });
    const active = all.filter((l) => l.entry.fm.status === 'active');
    const policies = loadTopicPolicies(ctx.home);

    const groups = new Map<string, Located[]>();
    for (const loc of active) {
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
        policy: policies.get(name) ?? 'always',
        title: deriveTitle(newest.entry.body, 50),
      };
    });
    rows.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));

    if (sub === 'policy') {
      const rawTopic = args._[1];
      const rawValue = args._[2];
      if (!rawTopic || !rawValue) throw new UsageError(USAGE);
      const name = normalizeTopic(rawTopic);
      if (!name) throw new UsageError('Topic must not be empty');
      const value = rawValue === 'default' ? null : (rawValue as TopicPolicy);
      if (value !== null && !TOPIC_POLICIES.includes(value)) {
        throw new UsageError(`Unknown policy "${rawValue}". Use always / once / never / default.`);
      }
      saveTopicPolicy(ctx.home, name, value);
      console.log(value ? `Policy for "${name}": ${value}` : `Policy for "${name}": default (always)`);
      if (!rows.some((r) => r.name === name)) {
        console.log('Note: no active document has this topic yet; the policy applies once one appears.');
      }
      return 0;
    }

    if (rows.length === 0) {
      console.log('No living-document topics yet. Pass a topic when writing (every memory is one).');
      return 0;
    }

    console.log(`${rows.length} topic(s) · ${active.length} living document(s)`);
    console.log('');
    console.log(`${'TOPIC'.padEnd(NAME_WIDTH)}PROJECT  LAST        CONF  POLICY   TITLE`);
    for (const r of rows) {
      const name = r.name.length > NAME_WIDTH - 1 ? `${r.name.slice(0, NAME_WIDTH - 2)}…` : r.name;
      console.log(
        `${name.padEnd(NAME_WIDTH)}${r.named.padEnd(9)}${r.last.padEnd(12)}${r.confidence.toFixed(2)}  ${r.policy.padEnd(9)}${r.title}`,
      );
    }
    console.log('');
    if (rows.some((r) => r.policy !== 'always')) {
      console.log(
        'Policy: once = auto-assent after the topic was reviewed (a confirm or an assent both count); '
          + 'never = stay out of the queue. Set with `omem topics policy <topic> once`.',
      );
    }
    return 0;
  } finally {
    ctx.index.close();
  }
}
