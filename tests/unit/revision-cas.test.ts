// D3 best-effort 版本比对：revision 复用 index.hash 口径，冲突走 CommitStatus 而非 warnings。
// 验收边界（重要）：这里只验证「检测到变化的一方被拒绝」。二次比对缩小 TOCTOU 窗口，
// 但不是跨进程锁，**不保证**并发写入绝不丢失更新；强一致锁留给后续版本。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry, fileRevision, readCurrentRevision } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { findByTopic } from '../../src/core/store.js';
import { buildTools, handleTool } from '../../src/mcp/tools.js';
import type { ToolCtx } from '../../src/mcp/tools.js';
import { makeHome, cleanupHome } from './helpers.js';

const TOPIC = 'tech-stack';
let home: string;
let index: OmemIndex;
let ctx: ToolCtx;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  ctx = { home, config: defaultConfig(), index };
});
afterEach(() => {
  index.close();
  cleanupHome(home);
});

function write(content: string, extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  return commitEntry(home, defaultConfig(), index, {
    content,
    type: 'fact' as const,
    topic: TOPIC,
    source: 'manual' as const,
    confidence: 0.9,
    overCap: 'reject' as const,
    ...extra,
  }, opts);
}

function revision(): string {
  return readCurrentRevision(findByTopic(home, TOPIC, { includeArchived: true })!.path);
}

function textOf(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('revision baseline (D3)', () => {
  it('uses the same full-file sha256/32 as index.hash, not body_hash', () => {
    write('用户主要使用 PHP');
    const path = findByTopic(home, TOPIC)!.path;
    const onDisk = readFileSync(path, 'utf8');
    expect(revision()).toBe(fileRevision(onDisk));
    expect(revision()).toHaveLength(32);
    // 全文 hash 对大小写敏感；body_hash 归一化后不敏感，不能当版本号。
    expect(fileRevision(onDisk)).not.toBe(fileRevision(onDisk.toLowerCase()));
    write('完全不同的另一句话');
    expect(revision()).not.toBe(fileRevision(onDisk));
  });

  it('search_memory exposes the revision so the write loop can echo it back', async () => {
    write('用户主要使用 PHP');
    const r = await handleTool('search_memory', { query: 'PHP' }, ctx);
    const hit = (r.structuredContent as any).hits[0];
    expect(hit.revision).toBe(revision());
    const props = buildTools({}).find((t) => t.name === 'search_memory')!.outputSchema as any;
    expect(Object.keys(props.properties.hits.items.properties)).toContain('revision');
  });
});

describe('commitEntry: expected_revision', () => {
  it('matching revision writes normally', () => {
    write('用户主要使用 PHP');
    const rev = revision();
    const r = write('现在主要使用 TypeScript', { expected_revision: rev });
    expect(r.status).toBe('written');
    expect(r.staleRevision).toBeUndefined();
  });

  it('mismatched revision refuses: no write, no warnings, no commit info', () => {
    write('用户主要使用 PHP');
    const path = findByTopic(home, TOPIC)!.path;
    const original = readFileSync(path, 'utf8');
    const r = write('现在主要使用 TypeScript', { expected_revision: 'deadbeef' });
    expect(r.status).toBe('stale-revision');
    expect(r.staleRevision).toMatchObject({ topic: TOPIC, expected: 'deadbeef', current: revision() });
    expect(r.warnings ?? []).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('a revision supplied for a non-existent topic is a mismatch (current=none)', () => {
    const r = write('全新的第一句话', { expected_revision: 'deadbeef' });
    expect(r.status).toBe('stale-revision');
    expect(r.staleRevision?.current).toBe('none');
    expect(findByTopic(home, TOPIC, { includeArchived: true })).toBeNull();
  });

  it('dry_run performs the same check', () => {
    write('用户主要使用 PHP');
    const r = write('现在主要使用 TypeScript', { expected_revision: 'deadbeef' }, { dryRun: true });
    expect(r.status).toBe('stale-revision');
    expect(r.dryRun).toBe(true);
  });

  it('omitting expected_revision keeps the legacy path unchanged', () => {
    write('用户主要使用 PHP');
    expect(write('现在主要使用 TypeScript').status).toBe('written');
  });

  it('interleaved writes: the caller holding a stale revision is refused and the newer body is kept', () => {
    // 确定性模拟「A 读到 rev → B 覆盖 → A 用旧 rev 写入」。
    // 这验证的是 best-effort 检测生效，不是「绝不丢失更新」的强一致证明。
    write('最初使用 PHP');
    const staleRev = revision();
    write('B 先改写为 Go');                       // 模拟另一个客户端先写入
    const bBody = findByTopic(home, TOPIC)!.entry.body;
    const r = write('A 再改写为 Rust', { expected_revision: staleRev });
    expect(r.status).toBe('stale-revision');
    expect(findByTopic(home, TOPIC)!.entry.body).toBe(bBody);
  });
});

describe('MCP: expected_revision receipt', () => {
  it('refuses with caller-aware copy, no warnings and no vcs commit', async () => {
    write('用户主要使用 PHP');
    const path = findByTopic(home, TOPIC)!.path;
    const original = readFileSync(path, 'utf8');
    const r = await handleTool('save_memory', {
      topic: TOPIC,
      content: '现在主要使用 TypeScript',
      expected_revision: 'deadbeef',
    }, ctx);
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status).toBe('stale-revision');
    expect(sc.stale_revision).toMatchObject({ expected: 'deadbeef' });
    expect(sc.warnings).toEqual([]);
    expect(sc.vcs).toBeUndefined();
    const text = textOf(r);
    expect(text).toContain('expected_revision');
    expect(text).not.toContain('--expected-revision');
    expect(readFileSync(path, 'utf8')).toBe(original);

    const schema = buildTools({}).find((t) => t.name === 'save_memory')!.outputSchema as any;
    const declared = new Set(Object.keys(schema.properties));
    for (const k of Object.keys(sc)) if (sc[k] !== undefined) expect(declared.has(k)).toBe(true);
  });

  it('a matching revision writes and reports no conflict', async () => {
    write('用户主要使用 PHP');
    const r = await handleTool('save_memory', {
      topic: TOPIC,
      content: '现在主要使用 TypeScript',
      expected_revision: revision(),
    }, ctx);
    expect((r.structuredContent as any).status).toBe('written');
    expect((r.structuredContent as any).stale_revision).toBeUndefined();
  });
});
