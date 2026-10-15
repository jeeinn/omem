// omem review：待确认队列（规格 §7）。默认列出 unverified 候选 + stale 提示。
// --confirm <id> 确认刷新 · --confirm <id> --supersedes <old> 确认并取代
// --dismiss <id> 归档（可逆）· --stale <id> 手动冷却
import { openCtx } from '../core/ctx.js';
import { findById, listEntries, moveToArchive, updateEntry } from '../core/store.js';
import { applySupersedes, formatStaleness, generateMemoryIndex, reconfirm } from '../core/lifecycle.js';
import { deriveTitle, serializeEntry } from '../core/entry.js';
import { truncate, UsageError } from '../core/util.js';
import { flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

function idList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function cmdReview(args: ParsedArgs): Promise<number> {
  const ctx = openCtx();
  const { home, config, index } = ctx;
  try {
    return await reviewBody(args, home, config, index);
  } finally {
    index.close();
  }
}

async function reviewBody(
  args: ParsedArgs,
  home: string,
  config: ReturnType<typeof openCtx>['config'],
  index: ReturnType<typeof openCtx>['index'],
): Promise<number> {
  const confirmId = flagStr(args.flags, 'confirm');
  const dismissId = flagStr(args.flags, 'dismiss');
  const staleId = flagStr(args.flags, 'stale');
  const supersedes = idList(flagStr(args.flags, 'supersedes'));
  if (supersedes.length > 0 && !confirmId) {
    throw new UsageError('用法: omem review --confirm <id> --supersedes <old-id>');
  }

  if (confirmId) {
    if (supersedes.length > 0) {
      const missing = supersedes.filter((id) => !findById(home, id, { includeArchived: true }));
      if (missing.length > 0) throw new UsageError(`未找到旧条目: ${missing.join(', ')}`);
    }
    const loc = reconfirm(home, index, confirmId);
    if (!loc) throw new UsageError(`未找到条目: ${confirmId}`);
    if (supersedes.length > 0) {
      const updated = updateEntry(home, confirmId, (fm) => {
        fm.supersedes = supersedes;
      });
      if (!updated) throw new UsageError(`未找到条目: ${confirmId}`);
      index.upsert(updated.entry, updated.path, serializeEntry(updated.entry));
      const n = applySupersedes(home, index, updated);
      generateMemoryIndex(home, index);
      console.log(`已确认: ${confirmId}（verified=true，confirmations=${updated.entry.fm.confirmations}）`);
      console.log(`已取代 ${n} 条: ${supersedes.join(', ')}`);
      return 0;
    }
    console.log(`已确认: ${confirmId}（verified=true，confirmations=${loc.entry.fm.confirmations}）`);
    return 0;
  }
  if (dismissId) {
    const loc = moveToArchive(home, dismissId);
    if (!loc) throw new UsageError(`未找到条目: ${dismissId}`);
    index.upsert(loc.entry, loc.path, serializeEntry(loc.entry));
    console.log(`已归档（可逆，archive/ 内仍可检索 --all）: ${dismissId}`);
    return 0;
  }
  if (staleId) {
    const loc = updateEntry(home, staleId, (fm) => {
      fm.status = 'stale';
    });
    if (!loc) throw new UsageError(`未找到条目: ${staleId}`);
    index.upsert(loc.entry, loc.path, serializeEntry(loc.entry));
    console.log(`已手动冷却: ${staleId}`);
    return 0;
  }

  // 默认：列出待确认队列
  const all = listEntries(home);
  const unverified = all.filter((l) => !l.entry.fm.verified && l.entry.fm.status === 'active');
  const stale = all.filter((l) => l.entry.fm.status === 'stale');

  if (unverified.length === 0 && stale.length === 0) {
    console.log('队列为空：没有待确认候选，也没有冷却条目。');
    return 0;
  }
  if (unverified.length > 0) {
    console.log(`待确认候选（unverified，共 ${unverified.length} 条）：\n`);
    for (const l of unverified) {
      const fm = l.entry.fm;
      console.log(`- \`${fm.id}\` [${fm.source}] ${truncate(deriveTitle(l.entry.body), 50)}`);
      console.log(`  confidence ${fm.confidence} · #${fm.type} #${fm.domain} ${formatStaleness(fm)}`);
    }
    console.log('');
  }
  if (stale.length > 0) {
    console.log(`已冷却（stale，检索降权 ×${config.process.stale_weight}，共 ${stale.length} 条）：\n`);
    for (const l of stale.slice(0, 20)) {
      console.log(`- \`${l.entry.fm.id}\` ${truncate(deriveTitle(l.entry.body), 50)} ${formatStaleness(l.entry.fm)}`);
    }
    if (stale.length > 20) console.log(`  …另有 ${stale.length - 20} 条`);
    console.log('');
  }
  console.log('操作：omem review --confirm <id> [--supersedes <old-id>] | --dismiss <id>（归档）| --stale <id>');
  return 0;
}
