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

  it('search_memory exposes the topic so the agent reuses it instead of inventing one', async () => {
    const e = {
      fm: newFrontmatter({ id: '2026-10-15-e2', type: 'fact', domain: 'coding', topic: 'pool-tuning' }),
      body: '手写 SQL 连接池上限设为 20',
    };
    const { path, content } = writeEntry(home, e);
    index.upsert(e, path, content);

    const text = textOf(await handleTool('search_memory', { query: '连接池' }, ctx));

    expect(text).toContain('topic:pool-tuning');
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

  it('save_memory truncates over-long content + warns in response', async () => {
    const long = 'x'.repeat(5000);
    const r = await handleTool('save_memory', { content: long }, ctx);
    const text = textOf(r);
    expect(text).toContain('Saved');
    expect(text).toContain('Truncated'); // Agent is warned about truncation
    const row = index.db.prepare('SELECT id, path FROM entries LIMIT 1').get() as unknown as { id: string; path: string };
    const entry = readEntryFile(row.path)!;
    expect([...entry.body].length).toBeLessThanOrEqual(2001); // 2000 + 省略号
    expect(readFileSync(row.path, 'utf8')).toContain('…');
  });

  it('save_memory truncates correctly with emoji (code points vs UTF-16)', async () => {
    // 1998 ASCII + 3 emoji (each 1 code point but 2 UTF-16 units) = 2001 code points
    const emoji = String.fromCodePoint(0x1F600); 
    const body = 'a'.repeat(1998) + emoji.repeat(3);
    expect([...body].length).toBe(2001); // code points
    expect(body.length).toBe(2004); // UTF-16 units (emoji are surrogate pairs)
    const r = await handleTool('save_memory', { content: body }, ctx);
    const text = textOf(r);
    expect(text).toContain('Saved');
    expect(text).toContain('Truncated');
    const row = index.db.prepare('SELECT path FROM entries LIMIT 1').get() as { path: string };
    const raw = readFileSync(row.path, 'utf8');
    expect(raw).toContain('…'); // truncated body includes ellipsis
    // After truncation: exactly 2000 code points + '…' = 2001 code points
    const entry = readEntryFile(row.path)!;
    expect([...entry.body].length).toBe(2001);
    // Old bug: body.length (UTF-16) would have been miscounted and produced broken surrogate pairs
  });

  it('save_memory dry_run validates without writing', async () => {
    const long = 'y'.repeat(2100); // Over limit, triggers truncation
    const r = await handleTool('save_memory', { content: long, topic: 'dry-run-topic', dry_run: true }, ctx);
    const text = textOf(r);
    expect(text).toContain('[dry-run]');
    expect(text).toContain('written');
    expect(text).toContain('Truncated');
    // No entry written
    const rows = index.db.prepare('SELECT id FROM entries').all();
    expect(rows).toHaveLength(0);
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

  it('save_memory exposes source_sessions + evidence as array fields', () => {
    const save = buildTools({}).find((t) => t.name === 'save_memory')!;
    const props = (save.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.source_sessions).toBeDefined();
    expect((props.source_sessions as any).type).toBe('array');
    expect(props.evidence).toBeDefined();
    expect((props.evidence as any).type).toBe('array');
  });

  it('save_memory absorbs multiple sessions + evidence in one write', async () => {
    // Session D: pre-existing corroborator from an earlier conversation
    const sessD = 'sess-prior-corroborator';
    // Sessions A, B, C: being absorbed in THIS write call
    const sessA = 'sess-multi-a';
    const sessB = 'sess-multi-b';
    const sessC = 'sess-multi-c';
    const dir = join(home, 'sessions', 'cursor');
    mkdirSync(dir, { recursive: true });
    for (const [sid, proj] of [[sessD, 'proj-old'], [sessA, 'proj-X'], [sessB, 'proj-X'], [sessC, 'proj-Y']] as const) {
      writeFileSync(
        join(dir, `${sid}.md`),
        [
          '---',
          'agent: cursor',
          `session_id: ${sid}`,
          `project: ${proj}`,
          'started: 2026-10-16T00:00:00.000Z',
          'ended: 2026-10-16T00:00:00.000Z',
          'messages: 1',
          `content_hash: ${sid}`,
          '---',
          '',
          '## user',
          '部署流程必须通过 CI/CD 验证',
          '',
        ].join('\n'),
      );
    }
    // Rebuild FTS so searchSessions finds corroborating sessions
    index.rebuild();

    const r = await handleTool('save_memory', {
      content: '部署流程结论汇总',
      topic: 'deploy-flow',
      session_id: sessA,
      source_sessions: [sessB, sessC],
      evidence: ['部署流程必须通过 CI/CD 验证'],
    }, ctx);
    const text = textOf(r);
    expect(text).toContain('Saved');
    // Corroboration from pre-existing session D boosts confidence
    expect(text).toMatch(/confidence 0\.[6-9]/);

    const row = index.db.prepare('SELECT path FROM entries LIMIT 1').get() as { path: string };
    const entry = readEntryFile(row.path)!;
    // Additional source sessions tracked
    expect(entry.fm.source_sessions).toContain(sessB);
    expect(entry.fm.source_sessions).toContain(sessC);
    expect(entry.fm.session_id).toBe(sessA);
    // Evidence actually persisted in frontmatter (not empty array)
    expect(Array.isArray(entry.fm.evidence)).toBe(true);
    expect((entry.fm.evidence as string[]).length).toBeGreaterThanOrEqual(1);
  });

  it('save_memory keeps an empty evidence array when none provided', async () => {
    await handleTool('save_memory', { content: '无证据条目案例' }, ctx);
    const row = index.db.prepare('SELECT path FROM entries LIMIT 1').get() as { path: string };
    const entry = readEntryFile(row.path)!;
    expect(Array.isArray(entry.fm.evidence)).toBe(true);
    expect((entry.fm.evidence as unknown[])).toHaveLength(0);
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
