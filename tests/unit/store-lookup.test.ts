// findByIdIndexed：走索引的快路径，以及索引陈旧时的回落保证。
//
// 存在理由：findById 每次调用都遍历并解析全部 md。review 队列、批量确认、版本链
// 追溯是「每个条目都要定位」的路径，千条库下会退化成 O(n²)。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { findById, findByIdIndexed, moveToArchive, writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function add(id: string, fm: Partial<Frontmatter> = {}): string {
  const e = { fm: newFrontmatter({ id, type: 'fact', domain: 'coding', ...fm }), body: `正文 ${id}` };
  const { path, content } = writeEntry(home, e);
  index.upsert(e, path, content);
  return path;
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('findByIdIndexed', () => {
  it('索引命中时返回与 findById 相同的结果', () => {
    add('2026-10-27-a1');

    const fast = findByIdIndexed(home, index, '2026-10-27-a1', { includeArchived: true });
    const slow = findById(home, '2026-10-27-a1', { includeArchived: true });

    expect(fast?.path).toBe(slow?.path);
    expect(fast?.location).toBe(slow?.location);
    expect(fast?.entry.fm.id).toBe('2026-10-27-a1');
  });

  it('索引里没有该条目时回落全库扫描（手工新增的 md 也能找到）', () => {
    add('2026-10-27-a2');
    // 模拟「索引陈旧」：清掉索引行，文件仍在磁盘
    index.db.prepare('DELETE FROM entries WHERE id = ?').run('2026-10-27-a2');

    const loc = findByIdIndexed(home, index, '2026-10-27-a2', { includeArchived: true });

    expect(loc).not.toBeNull();
    expect(loc!.entry.fm.id).toBe('2026-10-27-a2');
  });

  it('索引路径失效（文件被移走）时回落，返回 null 而不是抛错', () => {
    const path = add('2026-10-27-a3');
    rmSync(path, { force: true });

    expect(findByIdIndexed(home, index, '2026-10-27-a3', { includeArchived: true })).toBeNull();
  });

  it('已归档条目默认不可见，includeArchived 时才返回', () => {
    add('2026-10-27-a4');
    const moved = moveToArchive(home, '2026-10-27-a4')!;
    index.upsert(moved.entry, moved.path, '');

    expect(findByIdIndexed(home, index, '2026-10-27-a4')).toBeNull();
    const archived = findByIdIndexed(home, index, '2026-10-27-a4', { includeArchived: true });
    expect(archived?.location).toBe('archive');
  });

  it('不存在的 id 返回 null（两条路径都不命中）', () => {
    add('2026-10-27-a5');
    expect(findByIdIndexed(home, index, '2026-10-27-nope', { includeArchived: true })).toBeNull();
  });
});

describe('pathById', () => {
  it('返回索引里的路径，未索引时返回 null', () => {
    const path = add('2026-10-27-b1');

    expect(index.pathById('2026-10-27-b1')).toBe(path);
    expect(index.pathById('2026-10-27-nope')).toBeNull();
  });
});
