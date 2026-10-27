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

  it('summary does not treat code punctuation as a sentence boundary', () => {
    // 核心用例：旧正则切成 "sys_service.status !"。coding 域占库里绝大多数。
    const code = 'sys_service.status != 0 有两种情况：服务未注册、或注册已过期。前者要回到开通流程，后者只需续期。';
    expect(deriveSummary(code)).toBe('sys_service.status != 0 有两种情况：服务未注册、或注册已过期。前者要回到开通流程，后者只需续期。');
    expect(deriveSummary('版本 v1.2.3 发布了。第二句在这里。')).toBe('版本 v1.2.3 发布了。第二句在这里。');
    // 已知限制：缩写点（e.g. / i.e.）后接空格仍被当作句界。
    // 规则本身是「拉丁句末符只有后接空白才算句界」，缩写与真句号在字符层无法区分；
    // 换来的是 != 、v1.2.3、路径里的点不再切断摘要，收益远大于这点残留。
    expect(deriveSummary('调用 e.g. 这样写。然后结束。')).toBe('调用 e.g. 这样写。');
    // 拉丁句末符后接空白仍算句界：英文正文不能被当成一句。
    expect(deriveSummary('First sentence. Second sentence. Third.')).toBe('First sentence. Second sentence.');
  });
});
