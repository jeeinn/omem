// MCP 工具面测试（规格 §8）：search/save/feedback、幂等去重、env 门控、返回格式。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { buildTools, handleTool } from '../../src/mcp/tools.js';
import { prepareToolCall } from '../../src/mcp/server.js';
import { writeEntry, readEntryFile } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { defaultConfig } from '../../src/core/config.js';
import { contentHash } from '../../src/core/util.js';
import { makeHome, cleanupHome } from './helpers.js';
import type { ToolCtx } from '../../src/mcp/tools.js';

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

function textOf(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('mcp: buildTools tool surface', () => {
  it('lists only search_memory / save_memory by default', () => {
    const names = buildTools({}).map((t) => t.name);
    expect(names).toEqual(['search_memory', 'save_memory']);
  });

  it('appends memory_feedback when OMEM_MCP_TOOLS=feedback', () => {
    const names = buildTools({ OMEM_MCP_TOOLS: 'feedback' }).map((t) => t.name);
    expect(names).toContain('memory_feedback');
  });

  it('search_memory description is trigger-condition style', () => {
    const t = buildTools({}).find((x) => x.name === 'search_memory')!;
    expect(t.description).toContain('Call this tool before answering');
    expect(t.description).toContain('scope=sessions');
  });
});

describe('mcp: handleTool', () => {
  it('search_memory hits with freshness labels and a disclaimer frame', async () => {
    const e = {
      fm: newFrontmatter({ id: '2026-10-15-e1', type: 'decision', domain: 'coding', verified: true }),
      body: '该项目禁用 ORM，必须手写 SQL',
    };
    const { path, content } = writeEntry(home, e);
    index.upsert(e, path, content);

    const r = await handleTool('search_memory', { query: '手写 SQL' }, ctx);
    const text = textOf(r);
    expect(text).toContain('该项目禁用 ORM');
    expect(text).toContain('confirmed'); // 时效标注
    expect(text).toContain('not instructions');
  });

  it('search_memory detail=true returns full text and file path', async () => {
    const e = {
      fm: newFrontmatter({ id: '2026-10-15-e1', type: 'fact', domain: 'coding' }),
      body: '第一行摘要\n第二行全文内容 detail-marker',
    };
    const { path, content } = writeEntry(home, e);
    index.upsert(e, path, content);
    const r = await handleTool('search_memory', { query: 'detail-marker', detail: true }, ctx);
    expect(textOf(r)).toContain(path);
    expect(textOf(r)).toContain('第二行全文内容');
  });

  it('search_memory gives actionable advice on no results', async () => {
    const r = await handleTool('search_memory', { query: '不存在的关键词xyz' }, ctx);
    expect(textOf(r)).toContain('No memories found');
  });

  it('search_memory empty query errors', async () => {
    const r = await handleTool('search_memory', { query: '' }, ctx);
    expect(r.isError).toBe(true);
  });

  it('save_memory saves + idempotent dedup of duplicate content', async () => {
    const r1 = await handleTool('save_memory', { content: '探针唯一内容 probe-unique-xyz', type: 'fact', domain: 'general' }, ctx);
    expect(textOf(r1)).toContain('Saved');
    const r2 = await handleTool('save_memory', { content: '探针唯一内容 probe-unique-xyz', type: 'fact', domain: 'general' }, ctx);
    expect(textOf(r2)).toContain('not written again');
    // 库里按 content-hash 只有一条
    expect(index.getByBodyHash(contentHash('探针唯一内容 probe-unique-xyz'))).not.toBeNull();
    const rows = index.db.prepare('SELECT id FROM entries').all() as unknown as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  it('save_memory lands as a verified:false candidate', async () => {
    await handleTool('save_memory', { content: '待确认的候选条目' }, ctx);
    const rows = index.db.prepare('SELECT verified FROM entries').all() as unknown as { verified: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].verified).toBe(0);
  });

  it('save_memory truncates over-long content to max_content_chars', async () => {
    const long = 'x'.repeat(5000);
    await handleTool('save_memory', { content: long }, ctx);
    const row = index.db.prepare('SELECT id, path FROM entries LIMIT 1').get() as unknown as { id: string; path: string };
    const entry = readEntryFile(row.path)!;
    expect([...entry.body].length).toBeLessThanOrEqual(2001); // 2000 + 省略号
    expect(readFileSync(row.path, 'utf8')).toContain('…');
  });

  it('save_memory redacts secrets', async () => {
    const r = await handleTool('save_memory', { content: '注意 key 是 sk-ant-abc123def456ghi789jkl012mno345pqr678' }, ctx);
    expect(textOf(r)).toContain('Saved');
    const row = index.db.prepare('SELECT path FROM entries LIMIT 1').get() as unknown as { path: string };
    expect(readFileSync(row.path, 'utf8')).not.toContain('abc123def456');
  });

  it('save_memory infers the project from the absorbed session when not given', async () => {
    // project 决定这条结论归到哪个分组。没显式给就从被吸收的会话推断——
    // 缺了它，PROCESS.md 无法把文档挂回分组（docId 会变空）。
    const sessId = 'sess-proj-1';
    const dir = join(home, 'sessions', 'cursor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessId}.md`),
      [
        '---',
        'agent: cursor',
        `session_id: ${sessId}`,
        'project: proj-inferred',
        'started: 2026-10-16T00:00:00.000Z',
        'ended: 2026-10-16T00:00:00.000Z',
        'messages: 1',
        'content_hash: h1',
        '---',
        '',
        '## user',
        '原始会话内容',
        '',
      ].join('\n'),
    );
    await handleTool('save_memory', {
      content: '从会话推断出分组归属的结论',
      topic: 'a-topic',
      session_id: sessId,
    }, ctx);
    const row = index.db.prepare('SELECT path FROM entries LIMIT 1').get() as unknown as { path: string };
    const entry = readEntryFile(row.path)!;
    expect(entry.fm.project).toBe('proj-inferred');
  });

  it('save_memory keeps an explicitly given project', async () => {
    const sessId = 'sess-proj-2';
    const dir = join(home, 'sessions', 'cursor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessId}.md`),
      [
        '---',
        'agent: cursor',
        `session_id: ${sessId}`,
        'project: proj-from-session',
        'started: 2026-10-16T00:00:00.000Z',
        'ended: 2026-10-16T00:00:00.000Z',
        'messages: 1',
        'content_hash: h2',
        '---',
        '',
        '## user',
        '原始会话内容',
        '',
      ].join('\n'),
    );
    await handleTool('save_memory', {
      content: '显式指定分组的结论',
      topic: 'b-topic',
      session_id: sessId,
      project: 'proj-explicit',
    }, ctx);
    const row = index.db.prepare('SELECT path FROM entries LIMIT 1').get() as unknown as { path: string };
    const entry = readEntryFile(row.path)!;
    expect(entry.fm.project).toBe('proj-explicit');
  });

  it('memory_feedback helpful → reconfirm', async () => {
    const e = {
      fm: newFrontmatter({ id: '2026-10-15-e1', type: 'fact', domain: 'coding' }),
      body: '被反馈的条目',
    };
    const { path, content } = writeEntry(home, e);
    index.upsert(e, path, content);
    const r = await handleTool('memory_feedback', { id: '2026-10-15-e1', helpful: true }, ctx);
    expect(textOf(r)).toContain('confirmation refresh');
    expect(index.getById('2026-10-15-e1')!.verified).toBe(1);
  });

  it('memory_feedback unknown id errors', async () => {
    const r = await handleTool('memory_feedback', { id: 'nope', helpful: true }, ctx);
    expect(r.isError).toBe(true);
  });

  it('save_memory.supersedes appears in schema', () => {
    const save = buildTools({}).find((t) => t.name === 'save_memory')!;
    const props = (save.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.supersedes).toBeTruthy();
  });

  it('catch-up before tool calls sees external edits', async () => {
    await handleTool('save_memory', { content: '外部编辑前的正文 catchup-base' }, ctx);
    const row = index.db.prepare('SELECT path FROM entries LIMIT 1').get() as { path: string };
    appendFileSync(row.path, '\n外部追加 catchup-probe-marker-77\n');
    prepareToolCall(home, index);
    const r = await handleTool('search_memory', { query: 'catchup-probe-marker-77' }, ctx);
    expect(textOf(r)).toContain('catchup-probe-marker-77');
  });

  it('unknown tool errors', async () => {
    const r = await handleTool('bogus_tool', {}, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Unknown tool');
  });
});
