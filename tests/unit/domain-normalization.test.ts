// 阶段 D 的两个修复：domain 归一化（路径穿越）与 topic 当前文档的排序口径。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { entryPath, findById, updateEntry, writeEntry } from '../../src/core/store.js';
import { newFrontmatter, normalizeDomain } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { dirs } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function add(id: string, body: string, fm: Partial<Frontmatter> = {}): void {
  const e = { fm: newFrontmatter({ id, type: 'fact', domain: 'coding', ...fm }), body };
  const { path, content } = writeEntry(home, e);
  index.upsert(e, path, content);
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('normalizeDomain', () => {
  it('保留合法字符并转小写', () => {
    expect(normalizeDomain('Coding')).toBe('coding');
    expect(normalizeDomain('iot-boss')).toBe('iot-boss');
    expect(normalizeDomain('数据')).toBe('数据');
  });

  it('路径分隔符与点号被折叠，不产生上级目录', () => {
    expect(normalizeDomain('../../etc')).toBe('etc');
    expect(normalizeDomain('a/b\\c')).toBe('a-b-c');
    expect(normalizeDomain('..')).toBe('general');
  });

  it('空值与纯符号回落 general', () => {
    expect(normalizeDomain(undefined)).toBe('general');
    expect(normalizeDomain('')).toBe('general');
    expect(normalizeDomain('   ')).toBe('general');
    expect(normalizeDomain('///')).toBe('general');
  });
});

describe('entryPath: 脏 domain 不会写出知识库', () => {
  it('domain 含 ../ 时路径仍在 knowledge/ 内', () => {
    const fm = newFrontmatter({ id: '2026-10-27-x1', type: 'fact', domain: '../../escape' });
    const path = entryPath(home, fm);
    const root = dirs.knowledge(home) + sep;

    expect(path.startsWith(root)).toBe(true);
    expect(path).not.toContain('..');
  });

  it('updateEntry 修改成脏 domain 时文件不迁移到知识库外', () => {
    add('2026-10-27-x2', '正文');
    const before = findById(home, '2026-10-27-x2')!;

    const updated = updateEntry(home, '2026-10-27-x2', (fm) => {
      fm.domain = '../../escape';
    });

    const root = dirs.knowledge(home) + sep;
    expect(updated).not.toBeNull();
    expect(updated!.path.startsWith(root)).toBe(true);
    expect(existsSync(before.path)).toBe(false); // 旧路径已清理
    expect(existsSync(updated!.path)).toBe(true);
  });
});

describe('commitEntry: domain 字段本身也被净化', () => {
  it('写入的 frontmatter domain 是归一化后的值', () => {
    const r = commitEntry(
      home,
      defaultConfig(),
      index,
      { content: '一条结论', type: 'fact', domain: 'Coding/../../x', source: 'agent', confidence: 0.55, verified: false },
      { refreshIndex: false, refreshGuide: false },
    );

    expect(r.status).toBe('written');
    const fm = findById(home, r.id!)!.entry.fm;
    expect(fm.domain).toBe('coding-x');
    expect(fm.domain).not.toContain('..');
    expect(fm.domain).not.toContain('/');
  });
});

describe('findActiveByTopic: 按 created 选当前文档', () => {
  it('created 更新的胜出，即使另一条的 last_confirmed 更晚', () => {
    // 模拟「旧版被 review --confirm 过」：created 旧但 last_confirmed 新。
    add('2026-10-01-old', '旧版', {
      topic: 'pool',
      created: '2026-10-01T00:00:00.000Z',
      last_confirmed: '2026-10-27T00:00:00.000Z',
    });
    add('2026-10-20-new', '新版', {
      topic: 'pool',
      created: '2026-10-20T00:00:00.000Z',
      last_confirmed: '2026-10-20T00:00:00.000Z',
    });

    expect(index.findActiveByTopic('pool')!.id).toBe('2026-10-20-new');
  });

  it('不同 topic 互不干扰', () => {
    add('2026-10-27-t1', 'A', { topic: 'alpha' });
    add('2026-10-27-t2', 'B', { topic: 'beta' });

    expect(index.findActiveByTopic('alpha')!.id).toBe('2026-10-27-t1');
    expect(index.findActiveByTopic('beta')!.id).toBe('2026-10-27-t2');
    expect(index.findActiveByTopic('gamma')).toBeNull();
  });
});
