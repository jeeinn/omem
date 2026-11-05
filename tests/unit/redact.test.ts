// omem redact：单条与按来源批量硬删。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { listEntries } from '../../src/core/store.js';
import { cmdRedact } from '../../src/commands/redact.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  index.close();
  cleanupHome(home);
});

let seedSeq = 0;

function write(content: string, source: 'rules' | 'manual') {
  return commitEntry(home, defaultConfig(), index, { topic: `seed-${++seedSeq}`,
    content,
    type: 'fact',
    source,
    confidence: source === 'manual' ? 0.9 : 0.4,
  });
}

function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OMEM_HOME;
  process.env.OMEM_HOME = home;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.OMEM_HOME;
    else process.env.OMEM_HOME = prev;
  });
}

describe('redact --source', () => {
  it('deletes every rules fragment and leaves other sources', async () => {
    write('规则碎片一 手写 SQL 候选', 'rules');
    write('规则碎片二 另一条候选', 'rules');
    const kept = write('手工记下的结论保留下来', 'manual');
    const code = await withHome(() => cmdRedact({ _: [], flags: { source: 'rules', yes: true } }));
    expect(code).toBe(0);
    const left = listEntries(home, { includeArchived: true });
    expect(left).toHaveLength(1);
    expect(left[0].entry.fm.topic).toBe(kept.topic);
    expect(index.getByTopic(kept.topic!)).not.toBeNull();
  });

  it('without --yes it only previews and deletes nothing', async () => {
    write('规则碎片一 手写 SQL 候选', 'rules');
    write('手工记下的结论保留下来', 'manual');
    const code = await withHome(() => cmdRedact({ _: [], flags: { source: 'rules' } }));
    expect(code).toBe(0);
    expect(listEntries(home, { includeArchived: true })).toHaveLength(2);
  });

  it('preview reports the count and the re-run command', async () => {
    write('规则碎片一 手写 SQL 候选', 'rules');
    write('规则碎片二 另一条候选', 'rules');
    write('手工记下的结论保留下来', 'manual');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); });
    try {
      await withHome(() => cmdRedact({ _: [], flags: { source: 'rules' } }));
    } finally {
      spy.mockRestore();
    }
    const out = lines.join('\n');
    expect(out).toContain('Dry run');
    expect(out).toContain('2');
    expect(out).toContain('--yes');
    expect(out).toContain('1 will be kept');
  });

  it('warns when the match is the entire repo', async () => {
    write('规则碎片一 手写 SQL 候选', 'rules');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); });
    try {
      await withHome(() => cmdRedact({ _: [], flags: { source: 'rules' } }));
    } finally {
      spy.mockRestore();
    }
    expect(lines.join('\n')).toContain('EVERY entry');
  });

  it('zero matches is a no-op, not an error', async () => {
    write('手工记下的结论保留下来', 'manual');
    const code = await withHome(() => cmdRedact({ _: [], flags: { source: 'rules', yes: true } }));
    expect(code).toBe(0);
    expect(listEntries(home, { includeArchived: true })).toHaveLength(1);
  });

  it('rejects an unknown source', async () => {
    await expect(withHome(() => cmdRedact({ _: [], flags: { source: 'bogus' } }))).rejects.toThrow();
  });
});

describe('redact --topic', () => {
  it('without --yes it only previews and deletes nothing', async () => {
    const w = write('待硬删的单条结论', 'manual');
    const code = await withHome(() => cmdRedact({ _: [], flags: { topic: w.topic! } }));
    expect(code).toBe(0);
    expect(listEntries(home, { includeArchived: true })).toHaveLength(1);
  });

  it('preview states the deletion scope and the re-run command', async () => {
    const w = write('待硬删的单条结论', 'manual');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); });
    try {
      await withHome(() => cmdRedact({ _: [], flags: { topic: w.topic! } }));
    } finally {
      spy.mockRestore();
    }
    const out = lines.join('\n');
    expect(out).toContain('Dry run');
    expect(out).toContain(w.topic!);
    expect(out).toContain('--yes');
    expect(out).toContain('Not removed');
    expect(out).toContain('snapshots/');
    expect(out).toContain('remote backup');
    expect(out).toContain('never rewrites git history');
  });

  it('--yes performs the delete and restates the scope', async () => {
    const w = write('待硬删的单条结论', 'manual');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); });
    let code = -1;
    try {
      code = await withHome(() => cmdRedact({ _: [], flags: { topic: w.topic!, yes: true } }));
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    expect(listEntries(home, { includeArchived: true })).toHaveLength(0);
    expect(lines.join('\n')).toContain('Hard deleted');
    expect(lines.join('\n')).toContain('Not removed');
  });

  it('unknown topic is an error on both preview and delete', async () => {
    await expect(withHome(() => cmdRedact({ _: [], flags: { topic: 'missing' } }))).rejects.toThrow();
    await expect(withHome(() => cmdRedact({ _: [], flags: { topic: 'missing', yes: true } }))).rejects.toThrow();
  });
});
