// 存储层测试：md CRUD、目录布局、归档与硬删（规格 §2.1 / D1-B′）。
//
// D1-B′ 的目录布局：knowledge/<domain>/<topic>.md，没有年份分桶、没有 id。
// topic 由文件名承载，frontmatter 里不落盘——这是「单一身份」的实现细节，必须钉住。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeEntry,
  readEntryFile,
  listEntries,
  findByTopic,
  updateTopic,
  moveToArchive,
  deleteTopic,
  entryPath,
} from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import type { Entry } from '../../src/core/entry.js';
import { makeHome, cleanupHome } from './helpers.js';

function entry(topic: string, domain = 'coding', body = '测试条目正文'): Entry {
  return {
    fm: newFrontmatter({ topic, type: 'fact', domain, created: '2026-10-15T00:00:00.000Z' }),
    body,
  };
}

describe('store: md file CRUD', () => {
  it('写入落在 knowledge/<domain>/<topic>.md（无年份、无 id）', () => {
    const home = makeHome();
    try {
      const { path } = writeEntry(home, entry('Deploy Mirror'));
      expect(path).toBe(join(home, 'knowledge', 'coding', 'deploy-mirror.md'));
      expect(existsSync(path)).toBe(true);
      const back = readEntryFile(path);
      expect(back!.fm.topic).toBe('deploy-mirror');
      expect(back!.body).toBe('测试条目正文');
    } finally {
      cleanupHome(home);
    }
  });

  it('topic 由文件名注入：frontmatter 里既没有 id 也没有 topic', () => {
    const home = makeHome();
    try {
      const { path } = writeEntry(home, entry('omem-shape'));
      const raw = readFileSync(path, 'utf8');
      expect(raw).not.toMatch(/^id:/m);
      expect(raw).not.toMatch(/^topic:/m);
      expect(readEntryFile(path)!.fm.topic).toBe('omem-shape');
    } finally {
      cleanupHome(home);
    }
  });

  it('listEntries / findByTopic / 归档隔离', () => {
    const home = makeHome();
    try {
      writeEntry(home, entry('topic-a'));
      writeEntry(home, entry('topic-b', 'general'));
      expect(listEntries(home)).toHaveLength(2);
      expect(listEntries(home, { includeArchived: true })).toHaveLength(2);

      moveToArchive(home, 'topic-b');
      expect(listEntries(home)).toHaveLength(1); // 归档默认不进列表
      expect(findByTopic(home, 'topic-b')).toBeNull();
      const archived = findByTopic(home, 'topic-b', { includeArchived: true });
      expect(archived!.location).toBe('archive');
      expect(archived!.entry.fm.status).toBe('archived');
      expect(existsSync(join(home, 'archive', 'general', 'topic-b.md'))).toBe(true);
    } finally {
      cleanupHome(home);
    }
  });

  it('改 domain 会把文件一起搬走，不留旧副本', () => {
    const home = makeHome();
    try {
      writeEntry(home, entry('move-me', 'general'));
      const updated = updateTopic(home, 'move-me', (fm) => {
        fm.domain = 'coding';
      });
      expect(updated!.path).toBe(join(home, 'knowledge', 'coding', 'move-me.md'));
      expect(existsSync(join(home, 'knowledge', 'general', 'move-me.md'))).toBe(false);
      expect(listEntries(home)).toHaveLength(1);
    } finally {
      cleanupHome(home);
    }
  });

  it('deleteTopic 是硬删；不存在返回 false', () => {
    const home = makeHome();
    try {
      const { path } = writeEntry(home, entry('delete-me'));
      expect(deleteTopic(home, 'delete-me')).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(deleteTopic(home, 'never-existed')).toBe(false);
    } finally {
      cleanupHome(home);
    }
  });

  it('entryPath 只由 domain + topic 决定', () => {
    const home = makeHome();
    try {
      const fm = newFrontmatter({ topic: 'Knee Rehab', type: 'fact', domain: 'general', created: '2025-01-02T00:00:00.000Z' });
      expect(entryPath(home, fm)).toBe(join(home, 'knowledge', 'general', 'knee-rehab.md'));
    } finally {
      cleanupHome(home);
    }
  });

  it('序列化内容带 frontmatter 分隔符', () => {
    const home = makeHome();
    try {
      const { path } = writeEntry(home, entry('serialize-me'));
      const raw = readFileSync(path, 'utf8');
      expect(raw.startsWith('---\n')).toBe(true);
      expect(raw).toContain('测试条目正文');
    } finally {
      cleanupHome(home);
    }
  });
});
