// 生命周期测试（规格 §4）：supersede / gc / reconfirm / MEMORY-INDEX。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { writeEntry, updateEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { applySupersedes, gcScan, reconfirm, generateMemoryIndex, formatStaleness } from '../../src/core/lifecycle.js';
import { readFileSync } from 'node:fs';
import { files } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function add(id: string, body: string, fm: Partial<ReturnType<typeof newFrontmatter>> = {}) {
  const e = {
    fm: newFrontmatter({ id, type: 'fact', domain: 'coding', ...fm }),
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

describe('lifecycle: supersede (mandatory in V0.1)', () => {
  it('new entry declares supersedes → old entry set superseded with superseded_by backfilled', () => {
    add('2026-10-01-old', '旧约定：用 MySQL');
    const loc = add('2026-10-15-new', '新约定：用 Postgres', { supersedes: ['2026-10-01-old'] });
    const n = applySupersedes(home, index, loc);
    expect(n).toBe(1);
    const old = index.getById('2026-10-01-old')!;
    expect(old.status).toBe('superseded');
    expect(old.path).toContain('2026-10-01-old'); // 文件仍在（永不自动删除）
  });
});

describe('lifecycle: gc (mark stale only)', () => {
  it('active entries unconfirmed past the threshold → stale', () => {
    add('2026-10-15-fresh', '新条目', { last_confirmed: new Date().toISOString() });
    add('2026-01-01-old', '老条目', { created: '2026-01-01T00:00:00.000Z', last_confirmed: '2026-01-01T00:00:00.000Z' });
    const { marked, total } = gcScan(home, index, { staleAfterDays: 180, apply: true });
    expect(total).toBe(2);
    expect(marked).toHaveLength(1);
    expect(marked[0].entry.fm.id).toBe('2026-01-01-old');
    expect(index.getById('2026-01-01-old')!.status).toBe('stale');
    // 不删除文件
    expect(index.getById('2026-01-01-old')!.path).toContain('2026-01-01-old');
  });

  it('dry mode (apply=false) reports only, no writes', () => {
    add('2026-01-01-old', '老条目', { created: '2026-01-01T00:00:00.000Z', last_confirmed: '2026-01-01T00:00:00.000Z' });
    const { marked } = gcScan(home, index, { staleAfterDays: 180, apply: false });
    expect(marked).toHaveLength(1);
    expect(index.getById('2026-01-01-old')!.status).toBe('active');
  });
});

describe('lifecycle: reconfirm', () => {
  it('confirmation refresh updates verified/last_confirmed/confirmations', () => {
    add('2026-10-15-e1', '条目');
    const loc = reconfirm(home, index, '2026-10-15-e1')!;
    expect(loc.entry.fm.verified).toBe(true);
    expect(loc.entry.fm.confirmations).toBe(1);
    expect(index.getById('2026-10-15-e1')!.verified).toBe(1);
    reconfirm(home, index, '2026-10-15-e1');
    expect(index.getById('2026-10-15-e1')!.confirmations).toBe(2);
  });
});

describe('lifecycle: MEMORY-INDEX hot layer', () => {
  it('≤80 lines, active sorted by verified/confidence/time', () => {
    add('2026-10-15-low', '低置信条目');
    add('2026-10-15-high', '高置信已验证条目', { verified: true, confidence: 0.9 });
    const { lines, total } = generateMemoryIndex(home, index);
    expect(lines).toBeLessThanOrEqual(80);
    expect(total).toBe(2);
    const text = readFileSync(files.memoryIndex(home), 'utf8');
    const iHigh = text.indexOf('高置信已验证条目');
    const iLow = text.indexOf('低置信条目');
    expect(iHigh).toBeGreaterThan(-1);
    expect(iLow).toBeGreaterThan(-1);
    expect(iHigh).toBeLessThan(iLow); // verified 优先
  });

  it('truncates and hints at the long tail past the 80-line budget', () => {
    for (let i = 0; i < 100; i++) {
      add(`2026-10-15-pad${String(i).padStart(3, '0')}`, `条目 ${i}`);
    }
    const { lines } = generateMemoryIndex(home, index);
    expect(lines).toBeLessThanOrEqual(80);
    const text = readFileSync(files.memoryIndex(home), 'utf8');
    expect(text).toContain('not shown');
  });
});

describe('lifecycle: freshness label format', () => {
  it('verified / stale / superseded / unconfirmed, four forms', () => {
    expect(formatStaleness(newFrontmatter({ id: 'x', type: 'fact', domain: 'd', verified: true }))).toContain('confirmed');
    expect(formatStaleness(newFrontmatter({ id: 'x', type: 'fact', domain: 'd', status: 'stale' }))).toContain('cooled');
    expect(formatStaleness(newFrontmatter({ id: 'x', type: 'fact', domain: 'd', status: 'superseded', superseded_by: 'y' }))).toContain('y');
    expect(formatStaleness(newFrontmatter({ id: 'x', type: 'fact', domain: 'd' }))).toContain('unconfirmed');
  });

  it('defect fix: a superseded entry shows "superseded by" even when verified (omem add writes verified)', () => {
    const fm = newFrontmatter({ id: 'x', type: 'fact', domain: 'd', verified: true, status: 'superseded', superseded_by: '2026-10-21-new' });
    const label = formatStaleness(fm);
    expect(label).toContain('superseded by 2026-10-21-new');
    expect(label).not.toContain('confirmed'); // 不能把已作废记忆显示成有效确认
  });

  it('defect fix: an archived entry shows "archived" even when verified', () => {
    const fm = newFrontmatter({ id: 'x', type: 'fact', domain: 'd', verified: true, status: 'archived' });
    expect(formatStaleness(fm)).toContain('archived');
    expect(formatStaleness(fm)).not.toContain('confirmed');
  });
});
