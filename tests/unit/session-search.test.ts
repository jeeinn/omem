// 会话原文检索的片段（审查二-6③）：FTS 路径有 snippet()，LIKE 兜底路径此前只有注释、没有实现。
// 2 字中文查询恰好走 LIKE 兜底——没有片段的话，调用方拿到的就只剩一个文件路径。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { manualSnippet, searchSessions } from '../../src/core/search.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  const dir = join(home, 'sessions', 'claude-code');
  mkdirSync(dir, { recursive: true });
  const filler = '这是与命中位置无关的前后文，用来验证片段只截取命中附近的一段。'.repeat(6);
  writeFileSync(
    join(dir, 'sess-snip-1.md'),
    [
      '---', 'agent: claude-code', 'session_id: sess-snip-1', 'project: local:cafe1234',
      'started: 2026-10-16T00:00:00.000Z', 'ended: 2026-10-16T00:00:00.000Z',
      'messages: 1', 'content_hash: snip-1', '---', '',
      '## user',
      `${filler}关键约定：灰度发布先跑满二十四小时。`,
      filler,
      '',
    ].join('\n'),
  );
  index.catchUp();
  index.rebuild();
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('manualSnippet', () => {
  it('截取命中位置附近的上下文，长度按 code point 算', () => {
    const text = '前'.repeat(200) + '命中词在这里' + '后'.repeat(200);
    const s = manualSnippet(text, '命中词', 20);
    expect(s).toContain('命中词在这里');
    expect([...s].length).toBeLessThan(80);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });

  it('大小写不敏感（对齐 SQLite LIKE），命中在开头或结尾时不加对应省略号', () => {
    expect(manualSnippet('Deploy the Ring app', 'deploy', 40)).toBe('Deploy the Ring app');
    expect(manualSnippet('开头就命中，后面跟着一长串无关文字内容', '开头就命中', 6)).toContain('开头就命中');
  });

  it('needle 不在文本里时返回空串，而不是整篇', () => {
    expect(manualSnippet('some content', 'absent')).toBe('');
    expect(manualSnippet('', 'anything')).toBe('');
  });
});

describe('searchSessions LIKE 兜底路径', () => {
  it('2 字中文查询也带回命中片段', () => {
    const hits = searchSessions(index, '灰度', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toBeTruthy();
    expect(hits[0].snippet).toContain('灰度');
  });

  it('FTS 路径的片段不自带『』标记（标记由渲染层统一加，避免套两层）', () => {
    const hits = searchSessions(index, '灰度发布先跑满二十四小时', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toBeTruthy();
    expect(hits[0].snippet).not.toContain('『');
  });
});
