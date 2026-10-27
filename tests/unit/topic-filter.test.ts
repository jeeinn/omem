// topic / status 检索维度（2026-10-27）：topic 是写入侧的主键，却曾经是检索侧的盲区。
// 这条测试锁住三件事：按 topic 直接取活文档、按 status 读历史版本、matched 与 showing 分开报数。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { searchEntriesPage } from '../../src/core/search.js';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { handleTool } from '../../src/mcp/tools.js';
import { defaultConfig } from '../../src/core/config.js';
import type { ToolCtx } from '../../src/mcp/tools.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;
let ctx: ToolCtx;

function add(id: string, topic: string | undefined, body: string, fm: Partial<Frontmatter> = {}): void {
  const e = { fm: newFrontmatter({ id, type: 'fact', domain: 'coding', topic, ...fm }), body };
  const { path, content } = writeEntry(home, e);
  index.upsert(e, path, content);
}

function textOf(r: Awaited<ReturnType<typeof handleTool>>): string {
  return r.content.map((c) => c.text).join('\n');
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  ctx = { home, config: defaultConfig(), index };
  add('2026-10-20-old', 'omem-mcp-surface', '旧版正文 参数面', { status: 'superseded', created: '2026-10-20T00:00:00.000Z' });
  add('2026-10-27-new', 'omem-mcp-surface', '新版正文 参数面', { created: '2026-10-27T00:00:00.000Z' });
  add('2026-10-26-other', 'deploy-pipeline', '流水线配置说明');
  add('2026-10-25-notopic', undefined, '没有主题的条目 参数面');
  // 25 条批量命中：用来验证 top_k 的夹取边界（20）与配置值不被夹取。
  for (let i = 0; i < 25; i++) add(`2026-09-01-b${String(i).padStart(2, '0')}`, undefined, `批量条目 bulk-${i}`);
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('searchEntriesPage: topic / status', () => {
  it('topic 精确过滤，默认只给 active', () => {
    const page = searchEntriesPage(index, { topic: 'omem-mcp-surface' });
    expect(page.rows.map((r) => r.id)).toEqual(['2026-10-27-new']);
    expect(page.matched).toBe(1);
  });

  it('status 显式指定时可以读回历史版本', () => {
    const page = searchEntriesPage(index, { topic: 'omem-mcp-surface', status: ['superseded'] });
    expect(page.rows.map((r) => r.id)).toEqual(['2026-10-20-old']);
  });

  it('topic + query 组合是在主题内搜索', () => {
    const page = searchEntriesPage(index, { topic: 'deploy-pipeline', query: '流水线' });
    expect(page.rows.map((r) => r.id)).toEqual(['2026-10-26-other']);
  });

  it('topic 不存在时返回空而不是报错', () => {
    const page = searchEntriesPage(index, { topic: 'no-such-topic' });
    expect(page.rows).toEqual([]);
    expect(page.matched).toBe(0);
  });

  it('matched 报总数，showing 受 limit 限制', () => {
    const page = searchEntriesPage(index, { query: '参数面', limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.matched).toBe(2); // new + notopic
  });
});

describe('search_memory 工具面：topic 与 status', () => {
  it('只给 topic 就能拿到 active id（supersedes 不再靠写失败来发现）', async () => {
    const r = await handleTool('search_memory', { topic: 'omem-mcp-surface' }, ctx);
    expect(textOf(r)).toContain('2026-10-27-new');
    expect(textOf(r)).not.toContain('2026-10-20-old');
    expect((r.structuredContent as any).matched).toBe(1);
  });

  it('topic 大小写与空格被归一化后仍能命中', async () => {
    const r = await handleTool('search_memory', { topic: 'Omem MCP Surface' }, ctx);
    expect(textOf(r)).toContain('2026-10-27-new');
  });

  it('status 可以读回 superseded 版本', async () => {
    const r = await handleTool('search_memory', { topic: 'omem-mcp-surface', status: ['superseded'] }, ctx);
    expect(textOf(r)).toContain('2026-10-20-old');
  });

  it('非法 status 明确报错，不静默降级', async () => {
    const r = await handleTool('search_memory', { query: '参数面', status: ['bogus'] }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('status must be one of');
  });

  it('什么都没给时报错，而不是返回全部', async () => {
    const r = await handleTool('search_memory', {}, ctx);
    expect(r.isError).toBe(true);
  });

  it('matched 与 showing 分开报，并提示还有多少没返回', async () => {
    const r = await handleTool('search_memory', { query: '参数面', top_k: 1 }, ctx);
    const text = textOf(r);
    expect(text).toContain('matched 2 · showing 1');
    expect(text).toContain('Showing the first 1 of 2');
  });

  it('零结果区分「过滤器写错」与「真的没有」', async () => {
    const filtered = textOf(await handleTool('search_memory', { query: '参数面', domain: 'nonexistent' }, ctx));
    const plain = textOf(await handleTool('search_memory', { query: '完全不存在的东西zzz' }, ctx));
    expect(filtered).toContain('Filters in effect');
    expect(filtered).toContain('Drop the filter and retry');
    expect(plain).not.toContain('Filters in effect');
  });
});

describe('search_memory: top_k 边界', () => {
  it('显式 100 被夹到 20，而不是把全部命中倒进上下文', async () => {
    const r = await handleTool('search_memory', { query: '批量条目', top_k: 100 }, ctx);
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as any).matched).toBe(25);
    expect((r.structuredContent as any).showing).toBe(20);
  });

  it('非整数取整而不是抛 datatype mismatch', async () => {
    const r = await handleTool('search_memory', { query: '批量条目', top_k: 3.7 }, ctx);
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as any).showing).toBe(3);
  });

  it('小于 1 的值被夹到 schema 下限 1（与 minimum:1 同口径，不再静默回落）', async () => {
    for (const input of [0, -1]) {
      const r = await handleTool('search_memory', { query: '批量条目', top_k: input }, ctx);
      expect((r.structuredContent as any).showing, `top_k=${input}`).toBe(1);
    }
  });

  it('配置默认值不被工具面夹取（1-20 只约束显式传参）', async () => {
    const wide = { ...ctx, config: { ...ctx.config, search: { top_k: 30 } } };
    const r = await handleTool('search_memory', { query: '批量条目' }, wide);
    expect((r.structuredContent as any).showing).toBe(25);
  });
});
