// omem add：手动写入一条记忆（source: manual，verified: true——用户显式断言即确认）。
import { openCtx } from '../core/ctx.js';
import { writeEntry } from '../core/store.js';
import { newFrontmatter } from '../core/entry.js';
import { contentHash, newId } from '../core/util.js';
import { redactSecrets } from '../core/redact.js';
import { currentProfile } from '../core/profile.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';
import { inferDomain } from '../process/rules.js';
import { UsageError } from '../core/util.js';
import { flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { MemoryType } from '../core/entry.js';

export async function cmdAdd(args: ParsedArgs): Promise<number> {
  const content = args._.join(' ').trim();
  if (!content) throw new UsageError('用法: omem add <内容> [--type preference|fact|decision|experience] [--domain X] [--tags a,b] [--project fp]');
  const { home, config, index } = openCtx();

  const { text, hits } = redactSecrets(content);
  if (hits > 0) console.log(`已脱敏 ${hits} 处敏感内容`);

  const hash = contentHash(text);
  const dup = index.getByBodyHash(hash);
  if (dup) {
    console.log(`内容已存在（id: ${dup.id}），未重复写入。`);
    return 0;
  }

  const typeArg = flagStr(args.flags, 'type');
  const type: MemoryType = (['preference', 'fact', 'decision', 'experience'] as MemoryType[]).includes(typeArg as MemoryType)
    ? (typeArg as MemoryType)
    : 'fact';
  const domain = flagStr(args.flags, 'domain') ?? inferDomain(text);
  const tags = (flagStr(args.flags, 'tags') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const project = flagStr(args.flags, 'project');

  const entry = {
    fm: newFrontmatter({
      id: newId(text),
      type,
      domain,
      profile: currentProfile(config),
      status: 'active',
      confidence: 0.9, // 手动写入：高置信
      verified: true, // 用户显式断言即已确认（规格 §2.2：人工确认前恒 false 指自动采集产物）
      source: 'manual',
      project,
      tags,
    }),
    body: text,
  };
  const { path, content: fileContent } = writeEntry(home, entry);
  index.upsert(entry, path, fileContent);
  generateMemoryIndex(home, index);
  appendLog(home, 'add', { id: entry.fm.id, domain, type });
  console.log(`已保存 id: ${entry.fm.id}`);
  console.log(`文件: ${path}`);
  return 0;
}
