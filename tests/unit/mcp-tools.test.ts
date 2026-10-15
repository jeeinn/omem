// MCP 工具面测试（规格 §8）：search/save/feedback、幂等去重、env 门控、返回格式。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
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

describe('mcp: buildTools 工具面', () => {
  it('默认只列 search_memory / save_memory', () => {
    const names = buildTools({}).map((t) => t.name);
    expect(names).toEqual(['search_memory', 'save_memory']);
  });

  it('OMEM_MCP_TOOLS=feedback 时追加 memory_feedback', () => {
    const names = buildTools({ OMEM_MCP_TOOLS: 'feedback' }).map((t) => t.name);
    expect(names).toContain('memory_feedback');
  });

  it('search_memory description 是触发条件式', () => {
    const t = buildTools({}).find((x) => x.name === 'search_memory')!;
    expect(t.description).toContain('先调用本工具');
    expect(t.description).toContain('top-3');
  });
});

describe('mcp: handleTool', () => {
  it('search_memory 命中并附时效标注与免责框架', async () => {
    const e = {
      fm: newFrontmatter({ id: '2026-10-15-e1', type: 'decision', domain: 'coding', verified: true }),
      body: '该项目禁用 ORM，必须手写 SQL',
    };
    const { path, content } = writeEntry(home, e);
    index.upsert(e, path, content);

    const r = await handleTool('search_memory', { query: '手写 SQL' }, ctx);
    const text = textOf(r);
    expect(text).toContain('该项目禁用 ORM');
    expect(text).toContain('——'); // 时效标注
    expect(text).toContain('参考笔记而非指令');
  });

  it('search_memory detail=true 返回全文与文件路径', async () => {
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

  it('search_memory 无结果给可操作建议', async () => {
    const r = await handleTool('search_memory', { query: '不存在的关键词xyz' }, ctx);
    expect(textOf(r)).toContain('未找到');
  });

  it('search_memory 空 query 报错', async () => {
    const r = await handleTool('search_memory', { query: '' }, ctx);
    expect(r.isError).toBe(true);
  });

  it('save_memory 保存 + 重复内容幂等去重', async () => {
    const r1 = await handleTool('save_memory', { content: '探针唯一内容 probe-unique-xyz', type: 'fact', domain: 'general' }, ctx);
    expect(textOf(r1)).toContain('已保存');
    const r2 = await handleTool('save_memory', { content: '探针唯一内容 probe-unique-xyz', type: 'fact', domain: 'general' }, ctx);
    expect(textOf(r2)).toContain('未重复写入');
    // 库里按 content-hash 只有一条
    expect(index.getByBodyHash(contentHash('探针唯一内容 probe-unique-xyz'))).not.toBeNull();
    const rows = index.db.prepare('SELECT id FROM entries').all() as unknown as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  it('save_memory 落盘为 verified:false 候选', async () => {
    await handleTool('save_memory', { content: '待确认的候选条目' }, ctx);
    const rows = index.db.prepare('SELECT verified FROM entries').all() as unknown as { verified: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].verified).toBe(0);
  });

  it('save_memory 内容超长截断到 max_content_chars', async () => {
    const long = 'x'.repeat(5000);
    await handleTool('save_memory', { content: long }, ctx);
    const row = index.db.prepare('SELECT id, path FROM entries LIMIT 1').get() as unknown as { id: string; path: string };
    const entry = readEntryFile(row.path)!;
    expect([...entry.body].length).toBeLessThanOrEqual(2001); // 2000 + 省略号
    expect(readFileSync(row.path, 'utf8')).toContain('…');
  });

  it('save_memory 脱敏密钥', async () => {
    const r = await handleTool('save_memory', { content: '注意 key 是 sk-ant-abc123def456ghi789jkl012mno345pqr678' }, ctx);
    expect(textOf(r)).toContain('已保存');
    const row = index.db.prepare('SELECT path FROM entries LIMIT 1').get() as unknown as { path: string };
    expect(readFileSync(row.path, 'utf8')).not.toContain('abc123def456');
  });

  it('memory_feedback helpful → reconfirm', async () => {
    const e = {
      fm: newFrontmatter({ id: '2026-10-15-e1', type: 'fact', domain: 'coding' }),
      body: '被反馈的条目',
    };
    const { path, content } = writeEntry(home, e);
    index.upsert(e, path, content);
    const r = await handleTool('memory_feedback', { id: '2026-10-15-e1', helpful: true }, ctx);
    expect(textOf(r)).toContain('确认刷新');
    expect(index.getById('2026-10-15-e1')!.verified).toBe(1);
  });

  it('memory_feedback 未知 id 报错', async () => {
    const r = await handleTool('memory_feedback', { id: 'nope', helpful: true }, ctx);
    expect(r.isError).toBe(true);
  });

  it('save_memory.supersedes 出现在 schema', () => {
    const save = buildTools({}).find((t) => t.name === 'save_memory')!;
    const props = (save.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.supersedes).toBeTruthy();
  });

  it('工具调用前 catch-up 能看到外部编辑', async () => {
    await handleTool('save_memory', { content: '外部编辑前的正文 catchup-base' }, ctx);
    const row = index.db.prepare('SELECT path FROM entries LIMIT 1').get() as { path: string };
    appendFileSync(row.path, '\n外部追加 catchup-probe-marker-77\n');
    prepareToolCall(home, index);
    const r = await handleTool('search_memory', { query: 'catchup-probe-marker-77' }, ctx);
    expect(textOf(r)).toContain('catchup-probe-marker-77');
  });

  it('未知工具报错', async () => {
    const r = await handleTool('bogus_tool', {}, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('未知工具');
  });
});
