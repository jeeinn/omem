// omem skip：把判定为无沉淀价值的会话记入台账，让它们退出待吸收清单。
// 台账是数据文件（skip.json），随库走 git；不删任何会话文件，remove 随时可反悔。
import { readFileSync } from 'node:fs';
import { openCtx, type Ctx } from '../core/ctx.js';
import { files } from '../core/paths.js';
import { UsageError, atomicWrite } from '../core/util.js';
import { loadSkipLedger } from '../process/guide.js';
import { refreshProcessGuide } from '../process/guide.js';
import { splitSessionKey } from '../collect/session-store.js';

const REASONS = new Set(['noise', 'duplicate', 'no-value', 'agent-authored']);

interface SkipRecord {
  session_id: string;
  agent?: string;
  reason: string;
  decided_at: string;
}

function readLedger(home: string): SkipRecord[] {
  // 台账损坏时不静默：loadSkipLedger 会降级为空清单，这里显式提示一句。
  try {
    JSON.parse(readFileSync(files.skipLedger(home), 'utf8'));
    return loadSkipLedger(home);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.log(`warning: skip ledger is corrupt, starting from an empty list (${(err as Error).message})`);
    }
    return [];
  }
}

function writeLedger(home: string, records: SkipRecord[]): void {
  atomicWrite(files.skipLedger(home), `${JSON.stringify(records, null, 2)}
`);
}

export async function cmdSkip(args: { _: string[]; flags: Record<string, string | boolean> }): Promise<number> {
  const [action, target] = args._;
  const ctx = openCtx();
  try {
    return await skipInner(ctx, action, target, args.flags);
  } finally {
    ctx.index.close();
  }
}

async function skipInner(
  ctx: Ctx,
  action: string | undefined,
  target: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const records = readLedger(ctx.home);

  if (!action || action === 'list') {
    if (records.length === 0) {
      console.log('skip ledger is empty.');
    } else {
      for (const r of records) console.log(`${r.session_id}  ${r.reason}  ${r.decided_at.slice(0, 10)}`);
    }
    return 0;
  }

  if (action === 'remove') {
    if (!target) throw new UsageError('usage: omem skip remove <session-id>');
    const bare = splitSessionKey(target).sessionId;
    const next = records.filter((r) => r.session_id !== target && r.session_id !== bare);
    if (next.length === records.length) {
      console.log(`not in ledger: ${target}`);
      return 0;
    }
    writeLedger(ctx.home, next);
    refreshProcessGuide(ctx.home, ctx.index, ctx.config);
    console.log(`Removed ${target} from skip ledger; PROCESS.md refreshed.`);
    return 0;
  }

  // 默认视为 add：omem skip <session-id> [--reason x]
  const sessionId = action;
  const reason = typeof flags.reason === 'string' && flags.reason ? flags.reason : 'no-value';
  if (!REASONS.has(reason)) {
    throw new UsageError(`--reason must be one of: ${[...REASONS].join(', ')}`);
  }
  if (records.some((r) => r.session_id === sessionId)) {
    console.log(`already skipped: ${sessionId}`);
    return 0;
  }
  const bare = splitSessionKey(sessionId).sessionId;
  records.push({
    session_id: bare || sessionId,
    agent: splitSessionKey(sessionId).agent || undefined,
    reason,
    decided_at: new Date().toISOString(),
  });
  writeLedger(ctx.home, records);
  refreshProcessGuide(ctx.home, ctx.index, ctx.config);
  console.log(`Skipped ${sessionId} (${reason}); PROCESS.md refreshed. Undo with omem skip remove ${sessionId}.`);
  return 0;
}
