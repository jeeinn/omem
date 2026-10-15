// omem add：手动写入一条记忆（source: manual，verified: true——用户显式断言即确认）。
// 过滤、去重、落盘走 commitEntry。--force 只绕过禁区与代码密度。
import { openCtx } from '../core/ctx.js';
import { commitEntry } from '../core/commit.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { MemoryType } from '../core/entry.js';

const USAGE = '用法: omem add <内容> [--type preference|fact|decision|experience] [--domain X] [--tags a,b] [--project fp] [--supersedes id1,id2] [--force]';

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
      source: 'manual',
      confidence: 0.9,
      verified: true,
      supersedes,
    }, { force: flagBool(args.flags, 'force') });

    if ((result.redacted ?? 0) > 0 && result.status !== 'redacted-empty') {
      console.log(`已脱敏 ${result.redacted} 处敏感内容`);
    }
    if (result.status === 'deduped') {
      console.log(`内容已存在（id: ${result.id}），未重复写入。`);
      return 0;
    }
    if (result.status === 'excluded' || result.status === 'redacted-empty') {
      console.log(`未写入：${result.reason}`);
      if (!flagBool(args.flags, 'force') && result.status === 'excluded' && result.reason !== '内容为空' && !result.reason?.startsWith('未找到')) {
        console.log('若仍要记下这条，可加 --force（不绕过脱敏与去重）。');
      }
      return 0;
    }
    console.log(`已保存 id: ${result.id}`);
    console.log(`文件: ${result.path}`);
    if (supersedes.length > 0) console.log(`已取代: ${supersedes.join(', ')}`);
    return 0;
  } finally {
    ctx.index.close();
  }
}
