// S3：检索结果必须把证据与时间信息结构化返回，让 Agent 不必再靠 text 正则去抠。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { buildTools, handleTool } from '../../src/mcp/tools.js';
import type { ToolCtx } from '../../src/mcp/tools.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;
let ctx: ToolCtx;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  ctx = { home, config: defaultConfig(), index };
  commitEntry(home, defaultConfig(), index, {
    content: '用户偏好把连接池上限设为二十，超出的请求排队等待',
    type: 'preference',
    topic: 'pool-tuning',
    source: 'agent',
    confidence: 0.55,
    session_id: 'sess-1',
    source_sessions: ['sess-1', 'sess-2'],
    evidence: ['连接池上限设为 20，超过就排队'],
    overCap: 'reject',
  });
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

function textOf(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

function searchSchema(): any {
  return buildTools({}).find((t) => t.name === 'search_memory')!.outputSchema;
}

describe('search_memory: structured evidence and timestamps', () => {
  it('returns evidence, source_sessions, created, last_confirmed, summary and path', async () => {
    const r = await handleTool('search_memory', { query: '连接池' }, ctx);
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.matched).toBe(1);
    const hit = sc.hits[0];
    expect(hit.topic).toBe('pool-tuning');
    expect(hit.evidence).toContain('连接池上限设为 20，超过就排队');
    expect(hit.source_sessions).toEqual(expect.arrayContaining(['sess-1', 'sess-2']));
    expect(hit.created).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(typeof hit.last_confirmed).toBe('string');
    expect(hit.summary.length).toBeGreaterThan(0);
    expect(hit.path.endsWith('.md')).toBe(true);
  });

  it('every structured hit key is declared in outputSchema', async () => {
    const r = await handleTool('search_memory', { query: '连接池' }, ctx);
    const props = searchSchema().properties.hits.items.properties as Record<string, unknown>;
    const declared = new Set(Object.keys(props));
    for (const hit of (r.structuredContent as any).hits) {
      for (const k of Object.keys(hit)) {
        if (hit[k] !== undefined) expect(declared.has(k)).toBe(true);
      }
    }
  });

  it('rank and confidence copy no longer claims bm25 or a truth probability', async () => {
    const props = searchSchema().properties.hits.items.properties as any;
    expect(props.rank.description).toContain('not bm25');
    expect(props.confidence.description).toContain('not a probability');
    const saveProps = buildTools({}).find((t) => t.name === 'save_memory')!.outputSchema as any;
    expect(saveProps.properties.confidence.description).toContain('not a probability');

    const r = await handleTool('search_memory', { query: '连接池', detail: true }, ctx);
    const text = textOf(r);
    expect(text).not.toContain('(bm25)');
    expect(text).toContain('negative matched-word count');
  });

  it('scope=sessions hits are unaffected by the conclusions-only fields', async () => {
    const r = await handleTool('search_memory', { query: '连接池', scope: 'sessions' }, ctx);
    const sc = r.structuredContent as Record<string, any>;
    expect(Array.isArray(sc.hits)).toBe(true);
    // 会话通道不读 Markdown frontmatter，不应凭空造出 evidence 字段。
    for (const hit of sc.hits) expect(hit.evidence).toBeUndefined();
  });
});
