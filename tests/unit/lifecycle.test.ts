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

describe('lifecycle: supersede（V0.1 必做）', () => {
  it('新条目声明 supersedes → 旧条目置 superseded 并回填 superseded_by', () => {
    add('2026-10-01-old', '旧约定：用 MySQL');
    const loc = add('2026-10-15-new', '新约定：用 Postgres', { supersedes: ['2026-10-01-old'] });
    const n = applySupersedes(home, index, loc);
    expect(n).toBe(1);
    const old = index.getById('2026-10-01-old')!;
    expect(old.status).toBe('superseded');
    expect(old.path).toContain('2026-10-01-old'); // 文件仍在（永不自动删除）
  });
});

describe('lifecycle: gc（只标记 stale）', () => {
  it('超过阈值未确认的 active → stale', () => {
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

  it('dry 模式（apply=false）只报告不落盘', () => {
    add('2026-01-01-old', '老条目', { created: '2026-01-01T00:00:00.000Z', last_confirmed: '2026-01-01T00:00:00.000Z' });
    const { marked } = gcScan(home, index, { staleAfterDays: 180, apply: false });
    expect(marked).toHaveLength(1);
    expect(index.getById('2026-01-01-old')!.status).toBe('active');
  });
});

describe('lifecycle: reconfirm', () => {
  it('确认刷新 verified/last_confirmed/confirmations', () => {
    add('2026-10-15-e1', '条目');
    const loc = reconfirm(home, index, '2026-10-15-e1')!;
    expect(loc.entry.fm.verified).toBe(true);
    expect(loc.entry.fm.confirmations).toBe(1);
    expect(index.getById('2026-10-15-e1')!.verified).toBe(1);
    reconfirm(home, index, '2026-10-15-e1');
    expect(index.getById('2026-10-15-e1')!.confirmations).toBe(2);
  });
});

describe('lifecycle: MEMORY-INDEX 热层', () => {
  it('≤80 行，active 按 verified/置信/时间排序', () => {
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

  it('超过 80 行预算时截断并提示长尾', () => {
    for (let i = 0; i < 100; i++) {
      add(`2026-10-15-pad${String(i).padStart(3, '0')}`, `条目 ${i}`);
    }
    const { lines } = generateMemoryIndex(home, index);
    expect(lines).toBeLessThanOrEqual(80);
    const text = readFileSync(files.memoryIndex(home), 'utf8');
    expect(text).toContain('未展示');
  });
});

describe('lifecycle: 时效标注格式', () => {
  it('verified / stale / superseded / 未确认 四种形态', () => {
    expect(formatStaleness(newFrontmatter({ id: 'x', type: 'fact', domain: 'd', verified: true }))).toContain('确认');
    expect(formatStaleness(newFrontmatter({ id: 'x', type: 'fact', domain: 'd', status: 'stale' }))).toContain('冷却');
    expect(formatStaleness(newFrontmatter({ id: 'x', type: 'fact', domain: 'd', status: 'superseded', superseded_by: 'y' }))).toContain('y');
    expect(formatStaleness(newFrontmatter({ id: 'x', type: 'fact', domain: 'd' }))).toContain('未确认');
  });
});
