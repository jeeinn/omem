// 生命周期测试（规格 §4）：gc / reconfirm / MEMORY-INDEX / 时效标注。
//
// D1-B′ 之后没有 supersede 状态机：更新 = 覆盖同一份文件，版本由 git 承担。
// 因此这里只保留仍然存在的那几层：stale（只标记）、reconfirm（人工过目）、热层、时效标注。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { gcScan, reconfirm, generateMemoryIndex, formatStaleness } from '../../src/core/lifecycle.js';
import { files } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function add(topic: string, body: string, fm: Partial<Frontmatter> = {}) {
  const e = {
    fm: newFrontmatter({ topic, type: 'fact', domain: 'coding', ...fm }),
    body,
  };
  const { path, content } = writeEntry(home, e);
  index.upsert(e, path, content);
  return { entry: e, path };
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('lifecycle: gc (mark stale only)', () => {
  it('超过阈值未确认的 active 条目 → stale，文件不删', () => {
    add('fresh-topic', '新条目', { last_confirmed: new Date().toISOString() });
    add('old-topic', '老条目', { created: '2026-01-01T00:00:00.000Z', last_confirmed: '2026-01-01T00:00:00.000Z' });

    const { marked, total } = gcScan(home, index, { staleAfterDays: 180, apply: true });

    expect(total).toBe(2);
    expect(marked).toHaveLength(1);
    expect(marked[0].entry.fm.topic).toBe('old-topic');
    expect(index.getByTopic('old-topic')!.status).toBe('stale');
    expect(index.getByTopic('old-topic')!.path).toContain('old-topic.md');
  });

  it('apply=false 只报告不写盘', () => {
    add('old-topic', '老条目', { created: '2026-01-01T00:00:00.000Z', last_confirmed: '2026-01-01T00:00:00.000Z' });
    const { marked } = gcScan(home, index, { staleAfterDays: 180, apply: false });
    expect(marked).toHaveLength(1);
    expect(index.getByTopic('old-topic')!.status).toBe('active');
  });
});

describe('lifecycle: reconfirm', () => {
  it('人工过目刷新 verified / last_confirmed / confirmations', () => {
    add('review-me', '条目');
    const loc = reconfirm(home, index, 'review-me')!;
    expect(loc.entry.fm.verified).toBe(true);
    expect(loc.entry.fm.confirmations).toBe(1);
    expect(index.getByTopic('review-me')!.verified).toBe(1);

    reconfirm(home, index, 'review-me');
    expect(index.getByTopic('review-me')!.confirmations).toBe(2);
  });

  it('不存在的 topic 返回 null', () => {
    expect(reconfirm(home, index, 'nope')).toBeNull();
  });
});

describe('lifecycle: MEMORY-INDEX 热层', () => {
  it('≤80 行，verified 优先于低置信', () => {
    add('low-topic', '低置信条目');
    add('high-topic', '高置信已验证条目', { verified: true, confidence: 0.9 });

    const { lines, total } = generateMemoryIndex(home, index);

    expect(lines).toBeLessThanOrEqual(80);
    expect(total).toBe(2);
    const text = readFileSync(files.memoryIndex(home), 'utf8');
    const iHigh = text.indexOf('高置信已验证条目');
    const iLow = text.indexOf('低置信条目');
    expect(iHigh).toBeGreaterThan(-1);
    expect(iLow).toBeGreaterThan(-1);
    expect(iHigh).toBeLessThan(iLow);
  });

  it('超过 80 行预算时截断并说明长尾', () => {
    for (let i = 0; i < 100; i++) add(`pad-topic-${String(i).padStart(3, '0')}`, `条目 ${i}`);
    const { lines } = generateMemoryIndex(home, index);
    expect(lines).toBeLessThanOrEqual(80);
    expect(readFileSync(files.memoryIndex(home), 'utf8')).toContain('not shown');
  });
});

describe('lifecycle: 时效标注', () => {
  it('四种形态：confirmed / cooled / archived / unconfirmed', () => {
    const base = { type: 'fact' as const, domain: 'd' };
    expect(formatStaleness(newFrontmatter({ ...base, topic: 'x', verified: true }))).toContain('confirmed');
    expect(formatStaleness(newFrontmatter({ ...base, topic: 'x', status: 'stale' }))).toContain('cooled');
    expect(formatStaleness(newFrontmatter({ ...base, topic: 'x', status: 'archived' }))).toContain('archived');
    expect(formatStaleness(newFrontmatter({ ...base, topic: 'x' }))).toContain('unconfirmed');
  });

  it('归档优先于 verified：已作废的记忆不能显示成有效确认', () => {
    const fm = newFrontmatter({ topic: 'x', type: 'fact', domain: 'd', verified: true, status: 'archived' });
    expect(formatStaleness(fm)).toContain('archived');
    expect(formatStaleness(fm)).not.toContain('confirmed');
  });
});
