// S2 写入差异预览：覆盖行为必须可见，且 dry_run 与真实写入共用同一份计算。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { findByTopic } from '../../src/core/store.js';
import { cmdAdd } from '../../src/commands/add.js';
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

function write(content: string, topic = TOPIC, opts: Record<string, unknown> = {}) {
  return commitEntry(home, defaultConfig(), index, {
    content,
    type: 'fact' as const,
    topic,
    source: 'manual' as const,
    confidence: 0.9,
    overCap: 'reject' as const,
  }, opts);
}

function textOf(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('commitEntry: write diff', () => {
  it('reports previous/incoming when overwriting an existing document', () => {
    write('用户主要使用 PHP 开发后端');
    const r = write('现在主要使用 TypeScript 开发新项目');
    expect(r.status).toBe('written');
    expect(r.updated).toBe(true);
    expect(r.diff).toMatchObject({
      topic: TOPIC,
      previous: '用户主要使用 PHP 开发后端',
      incoming: '现在主要使用 TypeScript 开发新项目',
    });
    expect(r.diff!.previousChars).toBe([...'用户主要使用 PHP 开发后端'].length);
    expect(r.diff!.incomingChars).toBe([...'现在主要使用 TypeScript 开发新项目'].length);
  });

  it('a new topic has no diff', () => {
    const r = write('全新主题的第一句话');
    expect(r.status).toBe('written');
    expect(r.updated).toBe(false);
    expect(r.diff).toBeUndefined();
  });

  it('dry_run shows the same diff without touching the file', () => {
    write('用户主要使用 PHP 开发后端');
    const before = findByTopic(home, TOPIC)!.path;
    const original = readFileSync(before, 'utf8');
    const r = write('现在主要使用 TypeScript 开发新项目', TOPIC, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.diff).toMatchObject({ previous: '用户主要使用 PHP 开发后端' });
    expect(readFileSync(before, 'utf8')).toBe(original);
  });

  it('long bodies are previewed, not dumped whole', () => {
    const long = '旧'.repeat(400);
    write(long);
    const r = write('新'.repeat(400));
    expect(r.diff!.previousChars).toBe(400);
    expect([...r.diff!.previous].length).toBeLessThanOrEqual(161);
    expect(r.diff!.previous.endsWith('…')).toBe(true);
  });

  it('content dedup never claims a replacement happened', () => {
    write('同一份正文');
    const r = write('同一份正文');
    expect(r.status).toBe('deduped');
    expect(r.diff).toBeUndefined();
  });
});

describe('CLI: write diff receipt', () => {
  it('prints Previous and Incoming on an overwrite', async () => {
    write('用户主要使用 PHP 开发后端');
    const prev = process.env.OMEM_HOME;
    process.env.OMEM_HOME = home;
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); });
    try {
      await cmdAdd({ _: ['现在主要使用 TypeScript 开发新项目'], flags: { topic: TOPIC } });
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prev;
    }
    const out = lines.join('\n');
    expect(out).toContain('Existing content of');
    expect(out).toContain('Previous:');
    expect(out).toContain('Incoming:');
    expect(out).toContain('narrower --topic');
  });
});

describe('MCP: write diff receipt', () => {
  it('returns structured diff and readable text, both declared in outputSchema', async () => {
    write('用户主要使用 PHP 开发后端');
    const r = await handleTool('save_memory', { topic: TOPIC, content: '现在主要使用 TypeScript 开发新项目' }, ctx);
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status).toBe('written');
    expect(sc.diff).toMatchObject({ previous: '用户主要使用 PHP 开发后端' });
    expect(textOf(r)).toContain('Previous:');
    expect(textOf(r)).toContain('Incoming:');
    expect(textOf(r)).toContain('narrower topic');
    const schema = buildTools({}).find((t) => t.name === 'save_memory')!.outputSchema as any;
    expect(Object.keys(schema.properties)).toContain('diff');
    for (const k of Object.keys(sc.diff)) expect(Object.keys(schema.properties.diff.properties)).toContain(k);
  });

  it('dry_run also carries the diff but writes nothing', async () => {
    write('用户主要使用 PHP 开发后端');
    const path = findByTopic(home, TOPIC)!.path;
    const original = readFileSync(path, 'utf8');
    const r = await handleTool('save_memory', {
      topic: TOPIC,
      content: '现在主要使用 TypeScript 开发新项目',
      dry_run: true,
    }, ctx);
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.dry_run).toBe(true);
    expect(sc.diff).toMatchObject({ previous: '用户主要使用 PHP 开发后端' });
    expect(textOf(r)).toContain('Previous:');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});
