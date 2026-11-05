// D4 归档/冷却主题显式恢复：写入不得静默撤销用户的归档处置。
// 覆盖 commitEntry 核心、CLI --reactivate、MCP reactivate，以及「拒绝不进 warnings、不提交」。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { findByTopic, moveToArchive, updateTopic } from '../../src/core/store.js';
import { cmdAdd } from '../../src/commands/add.js';
import { buildTools, handleTool } from '../../src/mcp/tools.js';
import type { ToolCtx } from '../../src/mcp/tools.js';
import { makeHome, cleanupHome } from './helpers.js';

const TOPIC = 'legacy-stack';
const NEW_BODY = '现在主要使用 TypeScript 开发新项目';

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

function write(extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  return commitEntry(home, defaultConfig(), index, {
    content: NEW_BODY,
    type: 'fact' as const,
    topic: TOPIC,
    source: 'manual' as const,
    confidence: 0.9,
    overCap: 'reject' as const,
    ...extra,
  }, opts);
}

function seed(): void {
  commitEntry(home, defaultConfig(), index, {
    content: '用户以前主要使用 PHP 开发后端',
    type: 'fact' as const,
    topic: TOPIC,
    source: 'manual' as const,
    confidence: 0.9,
    overCap: 'reject' as const,
  });
}

function archive(): string {
  const loc = moveToArchive(home, TOPIC)!;
  index.upsert(loc.entry, loc.path, readFileSync(loc.path, 'utf8'));
  return loc.path;
}

function cool(): void {
  const loc = updateTopic(home, TOPIC, (fm) => { fm.status = 'stale'; })!;
  index.upsert(loc.entry, loc.path, readFileSync(loc.path, 'utf8'));
}

function textOf(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('commitEntry: archived/stale topics need an explicit reactivate', () => {
  it('refuses an archived topic and leaves the archived file untouched', () => {
    seed();
    const archivedPath = archive();
    const r = write();
    expect(r.status).toBe('needs-reactivation');
    expect(r.reactivation).toMatchObject({ topic: TOPIC, from: 'archived', to: 'active', location: 'archive' });
    expect(existsSync(archivedPath)).toBe(true);
    expect(findByTopic(home, TOPIC, { includeArchived: true })!.entry.fm.status).toBe('archived');
  });

  it('refuses a stale topic too', () => {
    seed();
    cool();
    const r = write();
    expect(r.status).toBe('needs-reactivation');
    expect(r.reactivation?.from).toBe('stale');
    expect(findByTopic(home, TOPIC, { includeArchived: true })!.entry.fm.status).toBe('stale');
  });

  it('dry_run reports the same refusal without writing', () => {
    seed();
    const archivedPath = archive();
    const r = write({}, { dryRun: true });
    expect(r.status).toBe('needs-reactivation');
    expect(r.dryRun).toBe(true);
    expect(existsSync(archivedPath)).toBe(true);
  });

  it('reactivate:true restores to active and moves the file back to knowledge/', () => {
    seed();
    const archivedPath = archive();
    const r = write({ reactivate: true });
    expect(r.status).toBe('written');
    expect(r.reactivated).toEqual({ from: 'archived', to: 'active' });
    const loc = findByTopic(home, TOPIC, { includeArchived: true })!;
    expect(loc.entry.fm.status).toBe('active');
    expect(loc.location).toBe('knowledge');
    expect(existsSync(archivedPath)).toBe(false);
  });

  it('reactivate:true brings a stale topic back without any status residue', () => {
    seed();
    cool();
    const r = write({ reactivate: true });
    expect(r.status).toBe('written');
    expect(r.reactivated).toEqual({ from: 'stale', to: 'active' });
    expect(findByTopic(home, TOPIC, { includeArchived: true })!.entry.fm.status).toBe('active');
  });

  it('an active topic is unaffected, with or without the flag', () => {
    seed();
    expect(write().status).toBe('written');
    // 换一份正文，否则第二次写入会被 content-hash 去重挡下（那是另一条不变量）。
    const second = commitEntry(home, defaultConfig(), index, {
      content: '另一个完全不同的结论：用户维护着两个代码仓库',
      type: 'fact' as const,
      topic: TOPIC,
      source: 'manual' as const,
      confidence: 0.9,
      overCap: 'reject' as const,
      reactivate: true,
    });
    expect(second.status).toBe('written');
    expect(second.reactivated).toBeUndefined();
    expect(findByTopic(home, TOPIC, { includeArchived: true })!.entry.fm.status).toBe('active');
  });
});

describe('CLI: --reactivate', () => {
  it('prints the CLI-form hint and writes nothing', async () => {
    seed();
    const archivedPath = archive();
    const prev = process.env.OMEM_HOME;
    process.env.OMEM_HOME = home;
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); });
    let code = -1;
    try {
      code = await cmdAdd({ _: [NEW_BODY], flags: { topic: TOPIC } });
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prev;
    }
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('--reactivate');
    expect(out).toContain('Nothing was written');
    expect(existsSync(archivedPath)).toBe(true);
  });
});

describe('MCP: reactivate', () => {
  it('refuses with needs_reactivation: caller-aware copy, no warnings, no commit', async () => {
    seed();
    const archivedPath = archive();
    const r = await handleTool('save_memory', { topic: TOPIC, content: NEW_BODY }, ctx);
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status).toBe('needs-reactivation');
    expect(sc.reactivation).toMatchObject({ from: 'archived', to: 'active', location: 'archive' });
    expect(sc.warnings).toEqual([]);
    expect(sc.vcs).toBeUndefined();
    const text = textOf(r);
    expect(text).toContain('reactivate: true');
    expect(text).not.toContain('--reactivate');
    expect(existsSync(archivedPath)).toBe(true);

    const schema = buildTools({}).find((t) => t.name === 'save_memory')!.outputSchema as any;
    const declared = new Set(Object.keys(schema.properties ?? {}));
    for (const k of Object.keys(sc)) if (sc[k] !== undefined) expect(declared.has(k)).toBe(true);
  });

  it('reactivate:true restores the topic and reports it in both channels', async () => {
    seed();
    archive();
    const r = await handleTool('save_memory', { topic: TOPIC, content: NEW_BODY, reactivate: true }, ctx);
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status).toBe('written');
    expect(sc.reactivated).toEqual({ from: 'archived', to: 'active' });
    expect(textOf(r)).toContain('Reactivated');
    const loc = findByTopic(home, TOPIC, { includeArchived: true })!;
    expect(loc.entry.fm.status).toBe('active');
    expect(loc.location).toBe('knowledge');
  });
});
