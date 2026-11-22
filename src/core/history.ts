// as_of 历史视图：从 git 提交历史里读某时点的 Markdown，派生出与当前索引同形状的行。
// 纪律：Markdown 仍是唯一事实源——这里读的是 git 里提交的 Markdown，不是新建一套历史数据库。
//       历史行带 `snapshotBody`，详情与证据从它读，绝不把调用方引向当前磁盘正文。
//       历史视图只读；它不作为写入基线，也不进 checkpointer / 不写回 index。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseEntry } from './entry.js';
import { entryToRow } from './index.js';
import type { EntryRow } from './index.js';
import { BackendUnavailableError, UsageError } from './util.js';

export interface AsOfRow extends EntryRow {
  /** 该时点的正文；详情与证据必须读它，不能用 row.path 读当前磁盘文件。 */
  snapshotBody: string;
  /** 解析后的提交 sha，回执里给调用方核对。 */
  snapshotRev: string;
}

export interface AsOfResult {
  rev: string;
  /** 提交时间（ISO），便于回执说明「这是何时快照」。 */
  committedAt: string;
  rows: AsOfRow[];
}

function git(home: string, args: string[]): string {
  return execFileSync('git', args, { cwd: home, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitTry(home: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    return { ok: true, out: git(home, args), err: '' };
  } catch (e: any) {
    return { ok: false, out: '', err: String(e?.stderr ?? e?.message ?? e).trim() };
  }
}

/**
 * 解析 as_of 为提交 sha。支持三种写法：
 *   - ISO 8601 时间戳（含 T 或空格 + 时区）→ 该时刻之前最近的一笔提交
 *   - `HEAD~N` / `HEAD^` → git 相对引用
 *   - 完整或短 sha → git 解析
 * 只从当前 HEAD 的历史里取，不读其它分支/远端——可见性口径与 `omem backup` 拉下来的本地历史一致。
 */
export function resolveAsOf(home: string, asOf: string): { rev: string; committedAt: string } {
  const value = asOf.trim();
  if (!value) throw new UsageError('as_of is empty; pass an ISO timestamp (e.g. 2026-11-20T12:00:00Z) or a git ref (HEAD~1).');
  const repo = gitTry(home, ['rev-parse', '--is-inside-work-tree']);
  if (!repo.ok || repo.out !== 'true') {
    throw new BackendUnavailableError(
      'as_of needs the memory home to be a git repository.',
      'Run omem backup once to initialise the data repo, or omit as_of to search current documents.',
    );
  }
  const isTime = /^\d{4}-\d{2}-\d{2}[T ].*/.test(value);
  const isRef = /^(HEAD([~^]\d*)+|[0-9a-fA-F]{4,40})$/.test(value);
  if (!isTime && !isRef) {
    throw new UsageError(`Cannot parse as_of "${value}"; use an ISO timestamp (2026-11-20T12:00:00Z), HEAD~N, or a commit sha.`);
  }
  const revSpec = isTime ? `HEAD` : value;
  const args = isTime
    ? ['rev-list', '-1', '--before=' + value, 'HEAD']
    : ['rev-parse', '--verify', value + '^{commit}'];
  const found = gitTry(home, args);
  if (!found.ok || !found.out) {
    throw new UsageError(
      isTime
        ? `No commit before ${value} in ${revSpec} history.`
        : `No commit resolved from as_of "${value}".`,
    );
  }
  const rev = found.out.split('\n')[0].trim();
  const at = gitTry(home, ['log', '-1', '--format=%cI', rev]);
  return { rev, committedAt: at.ok ? at.out : '' };
}

/**
 * 读某个提交时点的全部活文档与归档文档，返回可直接喂给 rank 的行。
 *
 * 关键取舍：`git ls-tree` 逐条 `git show` 而不是 `git archive`——后者要解包到临时目录，
 * 会把历史正文落到磁盘上，违背「历史视图只读、不留副本」。`git show blob` 直接进内存。
 */
export function readAsOf(home: string, asOf: string): AsOfResult {
  const { rev, committedAt } = resolveAsOf(home, asOf);
  const tree = gitTry(home, ['ls-tree', '-r', '--name-only', '-z', rev]);
  if (!tree.ok) throw new BackendUnavailableError(`Cannot read git tree ${rev}.`);
  const files = tree.out.split('\0').filter((p) =>
    /^(knowledge|archive)\/.*\.md$/.test(p) && !p.endsWith('.conflict.md'),
  );
  // ls-tree -z 不用 -- 分隔时输出带 NUL 边界，split 后路径已是原始字节：不含换行转义。
  const rows: AsOfRow[] = [];
  for (const rel of files) {
    const shown = gitTry(home, ['show', `${rev}:${rel}`]);
    if (!shown.ok) continue;
    const parsed = parseEntry(shown.out, rel);
    if (!parsed) continue;
    const slot = entryToRow(parsed, rel, shown.out, Buffer.byteLength(shown.out), 0);
    rows.push({
      ...slot.row,
      // 历史行的 path 是 git 对象引用而非磁盘路径：详情读取方看到它必须改用 snapshotBody。
      path: `${rev}:${rel}`,
      snapshotBody: parsed.body,
      snapshotRev: rev,
    });
  }
  return { rev, committedAt, rows };
}
