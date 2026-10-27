// omem add：手动写入一条记忆（source: manual，verified: true——用户显式断言即确认）。
// 过滤、去重、落盘走 commitEntry。--force 只绕过禁区与代码密度。
import { openCtx } from '../core/ctx.js';
import { commitEntry } from '../core/commit.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { MemoryType } from '../core/entry.js';

const USAGE = 'Usage: omem add <content> [--type preference|fact|decision|experience] [--domain X] [--tags a,b] [--project fp] [--topic name] [--supersedes id1,id2] [--force]';

export async function cmdAdd(args: ParsedArgs): Promise<number> {
  const content = args._.join(' ').trim();
  if (!content) throw new UsageError(USAGE);
  const ctx = openCtx();
  try {
    const typeArg = flagStr(args.flags, 'type');
    const type: MemoryType = (['preference', 'fact', 'decision', 'experience'] as MemoryType[]).includes(typeArg as MemoryType)
      ? (typeArg as MemoryType)
      : 'fact';
    const tags = (flagStr(args.flags, 'tags') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const supersedes = (flagStr(args.flags, 'supersedes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const result = commitEntry(ctx.home, ctx.config, ctx.index, {
      content,
      type,
      domain: flagStr(args.flags, 'domain'),
      tags,
      project: flagStr(args.flags, 'project'),
      topic: flagStr(args.flags, 'topic'),
      source: 'manual',
      confidence: 0.9,
      verified: true,
      supersedes,
    }, { force: flagBool(args.flags, 'force') });

    if ((result.redacted ?? 0) > 0 && result.status !== 'redacted-empty') {
      console.log(`Redacted ${result.redacted} sensitive spot(s)`);
    }
    if (result.status === 'deduped') {
      console.log(`Content already exists (id: ${result.id}); not written again.`);
      return 0;
    }
    if (result.status === 'excluded' || result.status === 'redacted-empty') {
      console.log(`Not written: ${result.reason}`);
      if (result.reason?.includes('already has an active document')) {
        console.log('--force does not bypass a topic update. Re-run with the --supersedes id from the message above.');
      } else if (!flagBool(args.flags, 'force') && result.status === 'excluded' && result.reason !== 'Content is empty' && !result.reason?.startsWith('Old entries not found')) {
        console.log('To record it anyway, add --force (does not bypass redaction or dedup).');
      }
      return 0;
    }
    console.log(`Saved id: ${result.id}`);
    console.log(`File: ${result.path}`);
    if (supersedes.length > 0) console.log(`Supersedes: ${supersedes.join(', ')}`);
    for (const w of result.warnings ?? []) console.log(`Note: ${w}`);
    return 0;
  } finally {
    ctx.index.close();
  }
}
