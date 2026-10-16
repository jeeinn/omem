// 通用工具：hash / id / 时间 / 原子写 / 错误类型。
// 全部同步 IO——CLI 短生命周期、MCP server 操作均为亚毫秒级，同步换取简单与可读性。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 归一化内容用于去重：忽略大小写、空白与标点（中英混合安全）。 */
export function normalizeForHash(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** content-hash：条目级幂等去重的指纹（规格 §8 save_memory 幂等）。 */
export function contentHash(s: string): string {
  return sha256hex(normalizeForHash(s)).slice(0, 16);
}

/** id 形如 2026-10-15-a1b2c3（规格 §2.2）。 */
export function newId(seed = ''): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${date}-${sha256hex(seed + Date.now() + Math.random()).slice(0, 6)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 相对时间，用于时效标注（规格 §4.4）。 */
export function relTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'time unknown';
  const diff = Math.max(0, now.getTime() - then);
  const min = 60_000, hour = 3_600_000, day = 86_400_000, month = 30 * day, year = 365 * day;
  if (diff < min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} hours ago`;
  if (diff < month) return `${Math.floor(diff / day)} days ago`;
  if (diff < year) return `${Math.floor(diff / month)} months ago`;
  return `${Math.floor(diff / year)} years ago`;
}

export function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/** 递归复制目录（不依赖 fs.cp，避免稳定性差异）。 */
export function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dest, name);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

/** --since 解析：7d / 24h / 30m / YYYY-MM-DD / ISO。 */
export function parseSince(s: string): Date {
  const m = s.match(/^(\d+)\s*([dhm])$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000;
    return new Date(Date.now() - n * unit);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new UsageError(`Cannot parse --since value: ${s} (supported: 7d / 24h / 30m / YYYY-MM-DD)`);
  }
  return d;
}

// ── 错误类型 → 退出码（规格 §7：0 成功 / 1 用法错误 / 2 后端不可用） ──

export class UsageError extends Error {
  readonly exitCode = 1;
}

export class BackendUnavailableError extends Error {
  readonly exitCode = 2;
  constructor(msg: string, readonly hint?: string) {
    super(msg);
  }
}

export class ProfileBlockedError extends Error {
  readonly exitCode = 2;
}
