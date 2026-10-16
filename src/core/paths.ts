// 路径解析：OMEM_HOME（默认 ~/.omem）与目录骨架（规格 §2.1 目录布局）。
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

export function omemHome(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.OMEM_HOME || join(homedir(), '.omem'));
}

export const dirs = {
  knowledge: (h: string) => join(h, 'knowledge'),
  sessions: (h: string) => join(h, 'sessions'),
  archive: (h: string) => join(h, 'archive'),
  index: (h: string) => join(h, 'index'),
  snapshots: (h: string) => join(h, 'snapshots'),
  logs: (h: string) => join(h, 'logs'),
};

export const files = {
  config: (h: string) => join(h, 'config.toml'),
  db: (h: string) => join(h, 'index', 'omem.db'),
  memoryIndex: (h: string) => join(h, 'MEMORY-INDEX.md'),
  processGuide: (h: string) => join(h, 'PROCESS.md'),
  usageLog: (h: string) => join(h, 'logs', 'omem.log'),
};

/** 创建运行期目录骨架（不含 config.toml 与索引内容）。 */
export function ensureHome(home: string): void {
  for (const d of [home, dirs.knowledge(home), dirs.sessions(home), dirs.archive(home), dirs.index(home), dirs.snapshots(home), dirs.logs(home)]) {
    mkdirSync(d, { recursive: true });
  }
}
