// 索引与检索集成测试（规格 §2.3；spike 结论：trigram ≥3 字符 MATCH，<3 字符 LIKE 兜底，stale 降权）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { searchEntries } from '../../src/core/search.js';
import { writeEntry } from '../../src/core/store.js';
import { updateEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { files } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function add(id: string, body: string, opts: Partial<{ domain: string; verified: boolean; status: 'active' | 'stale' | 'archived'; confidence: number; tags: string[] }> = {}) {
  const e = {
    fm: newFrontmatter({
      id,
      type: 'fact',
      domain: opts.domain ?? 'coding',
      verified: opts.verified ?? false,
      status: opts.status ?? 'active',
      confidence: opts.confidence ?? 0.5,
      tags: opts.tags ?? [],
    }),
    body,
  };
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

describe('index: FTS5 trigram search', () => {
  it('≥3-char multi-word query (trigram AND semantics)', () => {
    add('2026-10-15-e1', '这个项目禁用 ORM，必须手写 SQL');
    add('2026-10-15-e2', '用户偏好用 Postgres 而非 MySQL 处理数据库');
    const hits = searchEntries(index, { query: '手写 SQL' });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('2026-10-15-e1');
  });

  it('<3-char query falls back to LIKE', () => {
    add('2026-10-15-e1', '这个项目禁用 ORM，必须手写 SQL');
    const hits = searchEntries(index, { query: 'ORM' }); // 3 字符 ASCII
    expect(hits.length).toBeGreaterThan(0);
    const hits2 = searchEntries(index, { query: '写' }); // 1 字符 → LIKE
    expect(hits2.length).toBeGreaterThan(0);
    expect(hits2[0].id).toBe('2026-10-15-e1');
  });

  it('multi-word LIKE AND retry', () => {
    add('2026-10-15-e1', '部署时 docker 镜像构建失败');
    const hits = searchEntries(index, { query: 'docker 失败' }); // docker(5)+失败(2) → 混合长度
    expect(hits.length).toBeGreaterThan(0);
  });

  it('stale entries down-weighted (active before stale)', () => {
    add('2026-10-15-active', '手写 SQL 的约定 active', { status: 'active' });
    add('2026-10-15-stale', '手写 SQL 的约定 stale', { status: 'stale' });
    const hits = searchEntries(index, { query: '手写 SQL', limit: 5 });
    expect(hits[0].id).toBe('2026-10-15-active');
  });

  it('archived excluded by default, --all includes archive', () => {
    add('2026-10-15-arc', '已归档的手写 SQL 条目', { status: 'archived' });
    expect(searchEntries(index, { query: '手写 SQL' })).toHaveLength(0);
    expect(searchEntries(index, { query: '手写 SQL', all: true })).toHaveLength(1);
  });

  it('domain / project filtering', () => {
    add('2026-10-15-c', 'coding 域的手写 SQL', { domain: 'coding' });
    add('2026-10-15-g', 'general 域的手写 SQL', { domain: 'general' });
    expect(searchEntries(index, { query: '手写 SQL', domain: 'general' })).toHaveLength(1);
    expect(searchEntries(index, { query: '手写 SQL', domain: 'general' })[0].id).toBe('2026-10-15-g');
  });

  it('content-hash dedup lookup', () => {
    add('2026-10-15-e1', '手写 SQL 约定');
    const row = index.getById('2026-10-15-e1')!;
    expect(index.getByHash(row.hash)!.id).toBe('2026-10-15-e1');
    expect(index.getByHash('deadbeef')).toBeNull();
  });

  it('empty query returns empty', () => {
    add('2026-10-15-e1', '任意内容');
    expect(searchEntries(index, { query: '   ' })).toHaveLength(0);
  });
});

describe('index: consistency (catch-up / rebuild)', () => {
  it('external edits incrementally reindexed by catch-up', () => {
    add('2026-10-15-e1', '原始内容 手写 SQL');
    expect(searchEntries(index, { query: 'handedit' })).toHaveLength(0);

    // 模拟 Obsidian 外部编辑
    const path = join(home, 'knowledge', 'coding', '2026', '2026-10-15-e1.md');
    writeFileSync(path, `---\nid: 2026-10-15-e1\ntype: fact\ndomain: coding\n---\n\n外部追加 handedit-marker 内容\n`, 'utf8');

    const r = index.catchUp();
    expect(r.reindexed).toBe(1);
    const hits = searchEntries(index, { query: 'handedit-marker' });
    expect(hits).toHaveLength(1);
  });

  it('externally deleted file → catch-up removes the index row', () => {
    add('2026-10-15-e1', '待删除条目');
    rmSync(join(home, 'knowledge', 'coding', '2026', '2026-10-15-e1.md'), { force: true });
    const r = index.catchUp();
    expect(r.removed).toBe(1);
    expect(index.getById('2026-10-15-e1')).toBeNull();
  });

  it('full recovery via rebuild after deleting the db', () => {
    add('2026-10-15-e1', '手写 SQL 约定甲');
    add('2026-10-15-e2', '手写 SQL 约定乙', { domain: 'general' });
    index.close();
    rmSync(files.db(home), { force: true });
    rmSync(files.db(home) + '-wal', { force: true });
    rmSync(files.db(home) + '-shm', { force: true });
    expect(existsSync(files.db(home))).toBe(false);

    index = new OmemIndex(home);
    const total = index.rebuild();
    expect(total).toBe(2);
    expect(searchEntries(index, { query: '手写 SQL' })).toHaveLength(2);
  });

  it('unchanged files take the fast path (reindexed = 0)', () => {
    add('2026-10-15-e1', '稳定内容');
    const r = index.catchUp();
    expect(r.scanned).toBe(1);
    expect(r.reindexed).toBe(0);
  });
});

describe('index: sessions ledger', () => {
  it('put/get session records', () => {
    index.putSession({ session_id: 's1', project_fp: 'fp', msg_count: 6, last_ts: '2026-10-10T09:00:00Z', processed_at: 'now' });
    const rec = index.getSession('s1')!;
    expect(rec.msg_count).toBe(6);
    index.putSession({ session_id: 's1', project_fp: 'fp', msg_count: 9, last_ts: 'x', processed_at: 'now2' });
    expect(index.getSession('s1')!.msg_count).toBe(9);
    expect(index.getSession('nope')).toBeNull();
  });
});
