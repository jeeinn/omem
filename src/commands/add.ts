// omem add：手动写入一条记忆（source: manual，verified: true——用户显式断言即确认）。
// 过滤、去重、落盘走 commitEntry。--force 只绕过禁区与代码密度。
import { openCtx } from '../core/ctx.js';
import { commitEntry, metadataDrift } from '../core/commit.js';
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
    const topic = flagStr(args.flags, 'topic');
    const supersedes = (flagStr(args.flags, 'supersedes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const result = commitEntry(ctx.home, ctx.config, ctx.index, {
      content,
      type,
      domain: flagStr(args.flags, 'domain'),
      tags,
      project: flagStr(args.flags, 'project'),
      topic,
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
      // 去重只挡正文：请求的 topic/type/tags 若与既有文档不同，差异要能看出来并给出路，
      // 否则用户会以为 --topic 生效了。比对口径与 MCP 共用 metadataDrift；
      // type 只在显式给了合法值时才比对（没给或给错时它回落成 fact，报漂移是误伤）。
      const diffs = metadataDrift(result.existing, { topic, type: typeArg === type ? typeArg : undefined, tags });
      if (diffs.length > 0) {
        console.log(`Metadata not applied: ${diffs.join('; ')}.`);
        console.log(`Change the body and re-run with --supersedes ${result.id}, or run: omem topic set ${result.id} <topic>`);
      }
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
