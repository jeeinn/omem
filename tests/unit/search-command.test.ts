// omem search 的 CLI 层输出契约（规格 §7）。空占位 "Found 3 :" 是 beta.3 的展示缺陷，这里锁住格式。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { main } from '../../src/cli.js';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;

function addEntry(id: string, body: string): void {
  writeEntry(home, { fm: newFrontmatter({ id, type: 'fact', domain: 'coding' }), body });
}

function capture(): string[] {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  return out;
}

beforeEach(() => {
  home = makeHome();
  vi.stubEnv('OMEM_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupHome(home);
});

describe('cli: omem search output', () => {
  it('one hit reads "Found 1 memory:" (never an empty placeholder)', async () => {
    addEntry('2026-10-15-a1b2c3', 'Doris 数仓在每天凌晨做数据维护');
    const out = capture();
    expect(await main(['search', 'Doris'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Found 1 memory:');
    expect(text).not.toMatch(/Found \d+\s+:/);
  });

  it('several hits use the plural form', async () => {
    addEntry('2026-10-15-b1b2c3', 'Doris 数仓的第一条笔记');
    addEntry('2026-10-15-c1b2c3', 'Doris 数仓的第二条笔记');
    const out = capture();
    await main(['search', 'Doris']);
    expect(out.join('\n')).toContain('Found 2 memories:');
  });

  it('--all keeps the remark attached to the sentence', async () => {
    addEntry('2026-10-15-d1b2c3', 'Doris 归档场景的笔记');
    const out = capture();
    await main(['search', 'Doris', '--all']);
    expect(out.join('\n')).toContain('Found 1 memory (including archived and superseded):');
  });

  it('prints the topic on the hit line so it is visible without opening the file', async () => {
    writeEntry(home, {
      fm: newFrontmatter({ id: '2026-10-15-e1b2c3', type: 'fact', domain: 'coding', topic: 'pool-tuning' }),
      body: 'Doris 连接池上限的笔记',
    });
    const out = capture();
    await main(['search', 'Doris']);
    expect(out.join('\n')).toContain('topic:pool-tuning');
  });

  it('omits the topic segment when the entry has none', async () => {
    addEntry('2026-10-15-f1b2c3', 'Doris 无主题笔记');
    const out = capture();
    await main(['search', 'Doris']);
    expect(out.join('\n')).not.toContain('topic:');
  });

  it('--all shows the concrete superseding id on a superseded entry (defect: stale label)', async () => {
    writeEntry(home, { fm: newFrontmatter({ id: '2026-10-15-old', type: 'fact', domain: 'coding', status: 'superseded', superseded_by: '2026-10-16-new' }), body: 'Doris 旧约定' });
    writeEntry(home, { fm: newFrontmatter({ id: '2026-10-16-new', type: 'fact', domain: 'coding' }), body: 'Doris 新约定' });
    const out = capture();
    await main(['search', 'Doris', '--all']);
    const text = out.join('\n');
    expect(text).toContain('superseded by 2026-10-16-new');
    expect(text).not.toContain('confirmed just now');
  });
});
