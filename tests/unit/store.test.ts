// 存储层测试：md CRUD、目录布局、原子写、归档与硬删（规格 §2.1）。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeEntry,
  readEntryFile,
  listEntries,
  findById,
  updateEntry,
  moveToArchive,
  deleteEntry,
  entryPath,
} from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { dirs } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

function entry(id: string, domain = 'coding', body = '测试条目正文') {
  return {
    fm: newFrontmatter({ id, type: 'fact', domain, created: '2026-10-15T00:00:00.000Z' }),
    body,
  };
}

describe('store: md file CRUD', () => {
  it('writes land in knowledge/<domain>/<YYYY>/<id>.md', () => {
    const home = makeHome();
    try {
      const { path } = writeEntry(home, entry('2026-10-15-aaa111'));
      expect(path).toBe(join(home, 'knowledge', 'coding', '2026', '2026-10-15-aaa111.md'));
      expect(existsSync(path)).toBe(true);
      const back = readEntryFile(path);
      expect(back!.fm.id).toBe('2026-10-15-aaa111');
      expect(back!.body).toBe('测试条目正文');
    } finally {
      cleanupHome(home);
    }
  });

  it('listEntries / findById / archive isolation', () => {
    const home = makeHome();
    try {
      writeEntry(home, entry('2026-10-15-aaa111'));
      writeEntry(home, entry('2026-10-15-bbb222', 'general'));
      expect(listEntries(home)).toHaveLength(2);
      expect(listEntries(home, { includeArchived: true })).toHaveLength(2);

      moveToArchive(home, '2026-10-15-bbb222');
      expect(listEntries(home)).toHaveLength(1); // 归档默认不进列表
      expect(findById(home, '2026-10-15-bbb222')).toBeNull();
      const archived = findById(home, '2026-10-15-bbb222', { includeArchived: true });
      expect(archived!.location).toBe('archive');
      expect(archived!.entry.fm.status).toBe('archived');
      expect(existsSync(join(home, 'archive', 'general', '2026', '2026-10-15-bbb222.md'))).toBe(true);
    } finally {
      cleanupHome(home);
    }
  });

  it('updateEntry migrates the file when domain changes', () => {
    const home = makeHome();
    try {
      writeEntry(home, entry('2026-10-15-aaa111', 'general'));
      const updated = updateEntry(home, '2026-10-15-aaa111', (fm) => {
        fm.domain = 'coding';
      });
      expect(updated!.path).toBe(join(home, 'knowledge', 'coding', '2026', '2026-10-15-aaa111.md'));
      expect(existsSync(join(home, 'knowledge', 'general', '2026', '2026-10-15-aaa111.md'))).toBe(false);
    } finally {
      cleanupHome(home);
    }
  });

  it('deleteEntry hard-deletes', () => {
    const home = makeHome();
    try {
      const { path } = writeEntry(home, entry('2026-10-15-aaa111'));
      expect(deleteEntry(home, '2026-10-15-aaa111')).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(deleteEntry(home, '2026-10-15-nonexistent')).toBe(false);
    } finally {
      cleanupHome(home);
    }
  });

  it('entryPath year comes from created', () => {
    const home = makeHome();
    try {
      const e = entry('2025-01-02-ccc333');
      e.fm.created = '2025-01-02T00:00:00.000Z';
      expect(entryPath(home, e.fm)).toBe(join(home, 'knowledge', 'coding', '2025', '2025-01-02-ccc333.md'));
    } finally {
      cleanupHome(home);
    }
  });

  it('serialized content contains frontmatter delimiters', () => {
    const home = makeHome();
    try {
      writeEntry(home, entry('2026-10-15-aaa111'));
      const files = readFileSync(join(home, 'knowledge', 'coding', '2026', '2026-10-15-aaa111.md'), 'utf8');
      expect(files.startsWith('---\n')).toBe(true);
      expect(files).toContain('id: 2026-10-15-aaa111');
      expect(files).toContain('测试条目正文');
    } finally {
      cleanupHome(home);
    }
  });
});
