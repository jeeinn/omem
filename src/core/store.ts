// 存储层：knowledge/archive 下 md 文件的 CRUD。
// D1-B′：一份活文档 = `knowledge/<domain>/<topic>.md` —— 没有年份分桶、没有 id，路径即身份。
// 全部原子写（临时文件 + rename）；外部编辑（Obsidian）是一等公民——store 不做缓存，永远读盘。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { dirs } from './paths.js';
import type { Entry, Frontmatter } from './entry.js';
import { normalizeDomain, normalizeTopic, parseEntry, serializeEntry } from './entry.js';
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

/**
 * 路径 = 身份的投影：`<root>/<domain>/<topic>.md`。
 *
 * 这里再归一化一次 topic，不是冗余：`updateTopic` / `moveToArchive` 也会走这条路，
 * 外部编辑过的脏 topic（`../../x`）否则能让文件写出知识库。与 `normalizeDomain` 同一教训。
 */
export function entryPath(home: string, fm: Frontmatter, location: 'knowledge' | 'archive' = 'knowledge'): string {
  const root = location === 'archive' ? dirs.archive(home) : dirs.knowledge(home);
  const topic = normalizeTopic(fm.topic) ?? 'untitled';
  return join(root, normalizeDomain(fm.domain), `${topic}.md`);
}

export function writeEntry(home: string, entry: Entry): WriteResult {
  const content = serializeEntry(entry);
  const path = entryPath(home, entry.fm);
  atomicWrite(path, content);
  return { path, content };
}

export function readEntryFile(path: string): Entry | null {
  if (!existsSync(path)) return null;
  return parseEntry(readFileSync(path, 'utf8'), path);
}

/**
 * 单层扫描：`<root>/<domain>/*.md`。
 *
 * 旧布局（`<domain>/<YYYY>/<id>.md`）不再递归——D9 已定不兼容、要求 `omem init --force`。
 * 悄悄读旧文件反而更糟：它们会以「topic = 旧 id」的形态混进检索结果。
 */
function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const domain of readdirSync(dir)) {
    const sub = join(dir, domain);
    let st;
    try {
      st = statSync(sub);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const name of readdirSync(sub)) {
      if (name.endsWith('.md') && !name.endsWith('.conflict.md')) out.push(join(sub, name));
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

/**
 * 按 topic 定位。只做 readdir + existsSync：不解析任何正文，所以即使库里有几千份文件，
 * 一次定位也只碰 2–3 个目录项。
 */
export function findByTopic(
  home: string,
  topic: string,
  opts: { includeArchived?: boolean } = {},
): Located | null {
  const key = normalizeTopic(topic);
  if (!key) return null;
  const roots: { root: string; location: 'knowledge' | 'archive' }[] = [
    { root: dirs.knowledge(home), location: 'knowledge' },
  ];
  if (opts.includeArchived) roots.push({ root: dirs.archive(home), location: 'archive' });
  for (const { root, location } of roots) {
    if (!existsSync(root)) continue;
    for (const domain of readdirSync(root)) {
      const path = join(root, domain, `${key}.md`);
      if (!existsSync(path)) continue;
      const entry = readEntryFile(path);
      if (entry) return { entry, path, location };
    }
  }
  return null;
}

/**
 * 按 topic 定位，优先走索引：索引里存着上次落盘的路径，命中时只读那一份文件。
 *
 * 索引可能陈旧（手工移动、外部工具改名），路径失效时回落 `findByTopic`——正确性不打折。
 */
export function findTopicIndexed(
  home: string,
  index: OmemIndex,
  topic: string,
  opts: { includeArchived?: boolean } = {},
): Located | null {
  const key = normalizeTopic(topic);
  if (!key) return null;
  const path = index.pathByTopic(key);
  if (path && existsSync(path)) {
    const entry = readEntryFile(path);
    if (entry) {
      const location: 'knowledge' | 'archive' = path.startsWith(dirs.archive(home) + sep) ? 'archive' : 'knowledge';
      if (location === 'archive' && !opts.includeArchived) return null;
      return { entry, path, location };
    }
  }
  return findByTopic(home, key, opts);
}

/** 读-改-写。domain 变更时迁移文件位置（topic 变更请走 `topics rename`）。 */
export function updateTopic(home: string, topic: string, mutate: (fm: Frontmatter) => void): Located | null {
  const loc = findByTopic(home, topic, { includeArchived: true });
  if (!loc) return null;
  const fm = { ...loc.entry.fm };
  mutate(fm);
  const entry: Entry = { fm, body: loc.entry.body };
  const newPath = entryPath(home, fm, loc.location);
  atomicWrite(newPath, serializeEntry(entry));
  if (newPath !== loc.path) rmSync(loc.path, { force: true });
  return { entry, path: newPath, location: loc.location };
}

/** 归档：移入 archive/ 并置 status=archived（仍在版本控制内）。 */
export function moveToArchive(home: string, topic: string): Located | null {
  const loc = findByTopic(home, topic, { includeArchived: true });
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
export function deleteTopic(home: string, topic: string): boolean {
  const loc = findByTopic(home, topic, { includeArchived: true });
  if (!loc) return false;
  rmSync(loc.path, { force: true });
  return true;
}

/** 导出知识库文件清单（供索引对账 / rebuild 使用）。 */
export function allEntryFiles(home: string): { knowledge: string[]; archive: string[] } {
  return { knowledge: walkMd(dirs.knowledge(home)), archive: walkMd(dirs.archive(home)) };
}

export { mkdirSync, writeFileSync, renameSync };
