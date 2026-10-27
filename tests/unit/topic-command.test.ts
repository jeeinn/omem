// omem topic set / rename 元数据修补测试（Issue 3：content-hash 去重早于 topic 校验的绕行痛点）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { writeEntry, readEntryFile } from '../../src/core/store.js';
import { newFrontmatter, serializeEntry } from '../../src/core/entry.js';
import { makeHome, cleanupHome } from './helpers.js';
import { cmdTopic } from '../../src/commands/topic.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  vi.stubEnv('OMEM_HOME', home);
  index = new OmemIndex(home);
});
afterEach(() => {
  index.close();
  vi.unstubAllEnvs();
  cleanupHome(home);
});

/** 建一条 active 文档入库，返回其 id。 */
function seedEntry(opts: { idPrefix?: string; topic?: string; status?: string; verified?: boolean; confidence?: number; body?: string } = {}): string {
  const id = opts.idPrefix ?? '2026-10-15';
  const fm = newFrontmatter({
    id,
    type: 'fact',
    domain: 'coding',
    status: (opts.status ?? 'active') as any,
    verified: opts.verified ?? true,
    confidence: opts.confidence ?? 0.9,
    topic: opts.topic,
  });
  const body = opts.body ?? '原始正文 unchanged-body-marker';
  const entry = { fm, body };
  const { path } = writeEntry(home, entry);
  index.upsert(entry, path, serializeEntry(entry));
  return id;
}

describe('omem topic set', () => {
  it('sets topic on an active entry without changing confidence / verified / body / id', async () => {
    const id = seedEntry({ verified: true, confidence: 0.9, body: 'unchanged-body' });
    const before = readEntryFile(`${home}/knowledge/coding/2026/${id}.md`)!;
    expect(before.fm.topic).toBeUndefined();

    const rc = await cmdTopic({ _: ['set', id, 'my-topic'], flags: {} });
    expect(rc).toBe(0);

    const after = readEntryFile(`${home}/knowledge/coding/2026/${id}.md`)!;
    expect(after.fm.topic).toBe('my-topic');
    expect(after.fm.confidence).toBe(0.9);
    expect(after.fm.verified).toBe(true);
    expect(after.fm.id).toBe(id);
    expect(after.body).toBe('unchanged-body');
    expect(after.fm.supersedes).toEqual([]);
  });

  it('keeps normalized form (lowercase, spaces \u2192 hyphens)', async () => {
    const id = seedEntry();
    const rc = await cmdTopic({ _: ['set', id, 'Knee Rehab Topics'], flags: {} });
    expect(rc).toBe(0);
    const entry = readEntryFile(`${home}/knowledge/coding/2026/${id}.md`)!;
    expect(entry.fm.topic).toBe('knee-rehab-topics');
  });

  it('rejects when target topic is owned by a different active entry', async () => {
    const id1 = seedEntry({ idPrefix: '2026-10-15-a' });
    const id2 = seedEntry({ idPrefix: '2026-10-15-b', topic: 'taken' });
    await expect(cmdTopic({ _: ['set', id1, 'taken'], flags: {} })).rejects.toThrow(/already belongs to active/);
  });

  it('noop when the entry already has the same topic', async () => {
    const id = seedEntry({ topic: 'already' });
    const rc = await cmdTopic({ _: ['set', id, 'already'], flags: {} });
    expect(rc).toBe(0);
  });

  it('refuses to set on a superseded entry', async () => {
    const id = seedEntry({ status: 'superseded' });
    await expect(cmdTopic({ _: ['set', id, 'x'], flags: {} })).rejects.toThrow(/topic can only be set on active/);
  });

  it('updates the index topic column (topic becomes queryable)', async () => {
    const id = seedEntry();
    expect(index.activeTopics()).toHaveLength(0);

    await cmdTopic({ _: ['set', id, 'indexed-topic'], flags: {} });
    expect(index.activeTopics()).toContain('indexed-topic');
    const row = index.getById(id);
    expect(row?.topic).toBe('indexed-topic');
  });

  it('dry-run does not write to disk or index', async () => {
    const id = seedEntry({ body: 'dry-run-should-not-change' });
    const rc = await cmdTopic({ _: ['set', id, 'no-write'], flags: { 'dry-run': true } });
    expect(rc).toBe(0);
    const entry = readEntryFile(`${home}/knowledge/coding/2026/${id}.md`)!;
    expect(entry.fm.topic).toBeUndefined();
    expect(index.activeTopics()).toHaveLength(0);
  });
});

describe('omem topic rename', () => {
  it('renames topic across all active matches', async () => {
    const id1 = seedEntry({ idPrefix: '2026-10-15-a', topic: 'old-name', body: 'doc-a' });
    const id2 = seedEntry({ idPrefix: '2026-10-15-b', topic: 'old-name', body: 'doc-b' });
    const id3 = seedEntry({ idPrefix: '2026-10-15-c', topic: 'other-topic', body: 'doc-c' });

    const rc = await cmdTopic({ _: ['rename', 'old-name', 'new-name'], flags: {} });
    expect(rc).toBe(0);

    const e1 = readEntryFile(`${home}/knowledge/coding/2026/${id1}.md`)!;
    const e2 = readEntryFile(`${home}/knowledge/coding/2026/${id2}.md`)!;
    const e3 = readEntryFile(`${home}/knowledge/coding/2026/${id3}.md`)!;
    expect(e1.fm.topic).toBe('new-name');
    expect(e2.fm.topic).toBe('new-name');
    expect(e3.fm.topic).toBe('other-topic');
    // Bodies and confidence untouched
    expect(e1.body).toBe('doc-a');
    expect(e1.fm.confidence).toBe(0.9);
  });

  it('rejects rename when target already owned by a different topic', async () => {
    seedEntry({ idPrefix: '2026-10-15-a', topic: 'src' });
    seedEntry({ idPrefix: '2026-10-15-b', topic: 'occupied' });
    await expect(cmdTopic({ _: ['rename', 'src', 'occupied'], flags: {} })).rejects.toThrow(/already belongs to active/);
  });

  it('dry-run previews count without writing', async () => {
    seedEntry({ topic: 'preview-me' });
    const rc = await cmdTopic({ _: ['rename', 'preview-me', 'renamed'], flags: { 'dry-run': true } });
    expect(rc).toBe(0);
    // Entry still has the old name
    const row = index.db.prepare('SELECT topic FROM entries').all() as { topic: string | null }[];
    expect(row).toHaveLength(1);
    expect(row[0].topic).toBe('preview-me');
  });

  it('normalizes the new name (lowercase, spaces collapsed)', async () => {
    const id = seedEntry({ topic: 'raw' });
    const rc = await cmdTopic({ _: ['rename', 'raw', 'Fancy  New   Name'], flags: {} });
    expect(rc).toBe(0);
    const entry = readEntryFile(`${home}/knowledge/coding/2026/${id}.md`)!;
    expect(entry.fm.topic).toBe('fancy-new-name');
  });

  it('errors when old topic has no active matches', async () => {
    const rc = await cmdTopic({ _: ['rename', 'nonexistent-topic', 'any'], flags: {} });
    expect(rc).toBe(0); // No error, just a message
  });
});
