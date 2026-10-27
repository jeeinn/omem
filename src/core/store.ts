// 存储层：knowledge/archive 下 md 文件的 CRUD（规格 §2.1 目录布局）。
// 全部原子写（临时文件 + rename）；外部编辑（Obsidian）是一等公民——store 不做缓存，永远读盘。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { dirs } from './paths.js';
import type { Entry, Frontmatter } from './entry.js';
import { normalizeDomain, parseEntry, serializeEntry } from './entry.js';
import { atomicWrite } from './util.js';
import type { OmemIndex } from './index.js';

export interface Located {
  entry: Entry;
  path: string;
  location: 'knowledge' | 'archive';
}

export interface WriteResult {
  path: string;
  content: string;
}

export function entryPath(home: string, fm: Frontmatter, location: 'knowledge' | 'archive' = 'knowledge'): string {
  const root = location === 'archive' ? dirs.archive(home) : dirs.knowledge(home);
  const year = (fm.created || '').slice(0, 4) || String(new Date().getFullYear());
  // 在这里归一化而不是只在 commitEntry：updateEntry / moveToArchive 也走这条路径，
  // 外部编辑过的脏 domain（`../../x`）否则会让文件被写出知识库。
  return join(root, normalizeDomain(fm.domain), year, `${fm.id}.md`);
}

export function writeEntry(home: string, entry: Entry): WriteResult {
  const content = serializeEntry(entry);
  const path = entryPath(home, entry.fm);
  atomicWrite(path, content);
  return { path, content };
}

export function readEntryFile(path: string): Entry | null {
  if (!existsSync(path)) return null;
  return parseEntry(readFileSync(path, 'utf8'));
}

function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const domain of readdirSync(dir)) {
    const d1 = join(dir, domain);
    if (!statSync(d1).isDirectory()) continue;
    for (const year of readdirSync(d1)) {
      const d2 = join(d1, year);
      if (!statSync(d2).isDirectory()) continue;
      for (const name of readdirSync(d2)) {
        if (name.endsWith('.md') && !name.endsWith('.conflict.md')) out.push(join(d2, name));
      }
    }
  }
  return out;
}

export function listEntries(home: string, opts: { includeArchived?: boolean } = {}): Located[] {
  const out: Located[] = [];
  for (const path of walkMd(dirs.knowledge(home))) {
    const entry = readEntryFile(path);
    if (entry) out.push({ entry, path, location: 'knowledge' });
  }
  if (opts.includeArchived) {
    for (const path of walkMd(dirs.archive(home))) {
      const entry = readEntryFile(path);
      if (entry) out.push({ entry, path, location: 'archive' });
    }
  }
  return out;
}

export function findById(home: string, id: string, opts: { includeArchived?: boolean } = {}): Located | null {
  for (const loc of listEntries(home, { includeArchived: true })) {
    if (loc.entry.fm.id === id) {
      if (loc.location === 'archive' && !opts.includeArchived) return null;
      return loc;
    }
  }
  return null;
}

/**
 * 按 id 定位，优先走索引：先查一次 SQL 拿路径，只读那一份文件。
 *
 * `findById` 每次调用都会遍历并解析全部 md，适合低频场景；review 队列、批量确认、
 * 版本链追溯这类「每个条目都要定位」的路径用它，千条库下差一个数量级。
 * 索引可能陈旧（手工新增、外部移动），所以路径失效时回落全库扫描——正确性不打折。
 */
export function findByIdIndexed(
  home: string,
  index: OmemIndex,
  id: string,
  opts: { includeArchived?: boolean } = {},
): Located | null {
  const path = index.pathById(id);
  if (path && existsSync(path)) {
    const entry = readEntryFile(path);
    if (entry) {
      const location: 'knowledge' | 'archive' = path.startsWith(dirs.archive(home) + sep) ? 'archive' : 'knowledge';
      if (location === 'archive' && !opts.includeArchived) return null;
      return { entry, path, location };
    }
  }
  return findById(home, id, opts);
}

/** 读-改-写。domain/created 变更时迁移文件位置。 */
export function updateEntry(home: string, id: string, mutate: (fm: Frontmatter) => void): Located | null {
  const loc = findById(home, id, { includeArchived: true });
  if (!loc) return null;
  const fm = { ...loc.entry.fm };
  mutate(fm);
  const entry: Entry = { fm, body: loc.entry.body };
  const newPath = entryPath(home, fm, loc.location);
  const content = serializeEntry(entry);
  atomicWrite(newPath, content);
  if (newPath !== loc.path) rmSync(loc.path, { force: true });
  return { entry, path: newPath, location: loc.location };
}

/** 归档：移入 archive/ 并置 status=archived（规格 §4.2 L3；仍在版本控制内）。 */
export function moveToArchive(home: string, id: string): Located | null {
  const loc = findById(home, id, { includeArchived: true });
  if (!loc) return null;
  if (loc.location === 'archive') return loc;
  const fm: Frontmatter = { ...loc.entry.fm, status: 'archived' };
  const entry: Entry = { fm, body: loc.entry.body };
  const newPath = entryPath(home, fm, 'archive');
  atomicWrite(newPath, serializeEntry(entry));
  rmSync(loc.path, { force: true });
  return { entry, path: newPath, location: 'archive' };
}

/** 硬删除：唯一途径是 omem redact（规格 §4.2 X 层）。 */
export function deleteEntry(home: string, id: string): boolean {
  const loc = findById(home, id, { includeArchived: true });
  if (!loc) return false;
  rmSync(loc.path, { force: true });
  return true;
}

/** 导出知识库文件清单（供 catch-up / rebuild 使用）。 */
export function allEntryFiles(home: string): { knowledge: string[]; archive: string[] } {
  return { knowledge: walkMd(dirs.knowledge(home)), archive: walkMd(dirs.archive(home)) };
}

export { mkdirSync, writeFileSync, renameSync };
