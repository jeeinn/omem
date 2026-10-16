// 数据模型测试：frontmatter 契约往返、容错解析、title/summary 派生（规格 §2.2）。
import { describe, it, expect } from 'vitest';
import {
  serializeEntry,
  parseEntry,
  newFrontmatter,
  deriveTitle,
  deriveSummary,
} from '../../src/core/entry.js';
import type { Entry } from '../../src/core/entry.js';

function sampleEntry(): Entry {
  return {
    fm: newFrontmatter({
      id: '2026-10-15-a1b2c3',
      type: 'preference',
      domain: 'coding',
      profile: 'home',
      status: 'active',
      confidence: 0.42,
      verified: false,
      source: 'rules',
      session_id: 'sess-1',
      project: 'fp123',
      tags: ['sql', 'orm'],
      supersedes: [],
    }),
    body: '这个项目以后都用手写 SQL，不要用 ORM。\n第二行补充说明。',
  };
}

describe('entry: frontmatter contract', () => {
  it('serialize → parse round-trip is identical', () => {
    const e = sampleEntry();
    const back = parseEntry(serializeEntry(e));
    expect(back).not.toBeNull();
    expect(back!.fm.id).toBe('2026-10-15-a1b2c3');
    expect(back!.fm.type).toBe('preference');
    expect(back!.fm.domain).toBe('coding');
    expect(back!.fm.confidence).toBeCloseTo(0.42);
    expect(back!.fm.verified).toBe(false);
    expect(back!.fm.source).toBe('rules');
    expect(back!.fm.tags).toEqual(['sql', 'orm']);
    expect(back!.body).toBe('这个项目以后都用手写 SQL，不要用 ORM。\n第二行补充说明。');
  });

  it('serialization contains all 15 fields in stable order', () => {
    const text = serializeEntry(sampleEntry());
    const keys = text.split('\n').slice(1, text.split('\n').indexOf('---', 1));
    expect(keys[0]).toBe('id: 2026-10-15-a1b2c3');
    expect(keys).toContain('status: active');
    expect(keys).toContain('confirmations: 0');
    expect(keys).toContain('supersedes: []');
    expect(keys).toContain('tags: ["sql", "orm"]');
  });

  it('text without frontmatter returns null', () => {
    expect(parseEntry('只是普通文本')).toBeNull();
  });

  it('tolerant: unknown type/status/profile fall back to defaults', () => {
    const back = parseEntry(
      ['---', 'id: x1', 'type: bogus', 'domain: coding', 'profile: mars', 'status: weird', 'confidence: 0.5', '---', '', '正文'].join('\n'),
    );
    expect(back!.fm.type).toBe('fact');
    expect(back!.fm.status).toBe('active');
    expect(back!.fm.profile).toBe('home');
  });

  it('confidence is clipped to [0,1]', () => {
    const back = parseEntry(['---', 'id: x1', 'type: fact', 'confidence: 7.5', '---', '', '正文'].join('\n'));
    expect(back!.fm.confidence).toBe(1);
  });

  it('title takes the first line, strips markdown markers, truncates when long', () => {
    expect(deriveTitle('## 标题行\n第二行')).toBe('标题行');
    expect(deriveTitle('短标题')).toBe('短标题');
    expect([...deriveTitle('x'.repeat(100))].length).toBe(60);
  });

  it('summary takes the first two sentences', () => {
    expect(deriveSummary('第一句。第二句！第三句？')).toBe('第一句。第二句！');
    expect([...deriveSummary('没有标点的很长内容'.repeat(20))].length).toBe(120);
  });
});
