// 每日快照兜底（规格 §2.1 snapshots/ 滚动保留 7 份；评估第 8 章数据丢失对策）。
import { existsSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirs, files } from './paths.js';
import { copyDir } from './util.js';

export function createSnapshot(home: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const dest = join(dirs.snapshots(home), date);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  copyDir(dirs.knowledge(home), join(dest, 'knowledge'));
  if (existsSync(dirs.archive(home))) copyDir(dirs.archive(home), join(dest, 'archive'));
  if (existsSync(files.config(home))) {
    copyFileSync(files.config(home), join(dest, 'config.toml'));
  }
  return dest;
}

export function pruneSnapshots(home: string, keep = 7): string[] {
  const root = dirs.snapshots(home);
  if (!existsSync(root)) return [];
  const dirsByDate = readdirSync(root)
    .filter((n) => statSync(join(root, n)).isDirectory())
    .sort()
    .reverse();
  const pruned: string[] = [];
  for (const name of dirsByDate.slice(keep)) {
    rmSync(join(root, name), { recursive: true, force: true });
    pruned.push(name);
  }
  return pruned;
}

export function runSnapshot(home: string, keep = 7): { path: string; pruned: string[] } {
  const path = createSnapshot(home);
  const pruned = pruneSnapshots(home, keep);
  return { path, pruned };
}
