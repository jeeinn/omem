// 阶段 D 的两个修复：domain 归一化（路径穿越）与 topic 当前文档的排序口径。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { entryPath, findByTopic, updateTopic, writeEntry } from '../../src/core/store.js';
import { newFrontmatter, normalizeDomain } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { dirs } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function add(id: string, body: string, fm: Partial<Frontmatter> = {}): void {
  const e = { fm: newFrontmatter({ topic: id, type: 'fact', domain: 'coding', ...fm }), body };
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
    const fm = newFrontmatter({ topic: '2026-10-27-x1', type: 'fact', domain: '../../escape' });
    const path = entryPath(home, fm);
    const root = dirs.knowledge(home) + sep;

    expect(path.startsWith(root)).toBe(true);
    expect(path).not.toContain('..');
  });

  it('updateTopic 修改成脏 domain 时文件不迁移到知识库外', () => {
    add('2026-10-27-x2', '正文');
    const before = findByTopic(home, '2026-10-27-x2')!;

    const updated = updateTopic(home, '2026-10-27-x2', (fm) => {
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
      { content: '一条结论', type: 'fact', topic: 'domain-check', domain: 'Coding/../../x', source: 'agent', confidence: 0.55, verified: false },
      { refreshIndex: false, refreshGuide: false },
    );

    expect(r.status).toBe('written');
    const fm = findByTopic(home, r.topic!)!.entry.fm;
    expect(fm.domain).toBe('coding-x');
    expect(fm.domain).not.toContain('..');
    expect(fm.domain).not.toContain('/');
  });
});

