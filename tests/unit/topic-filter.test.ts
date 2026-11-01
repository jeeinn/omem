// 检索的 topic / status 过滤（D1-B′：topic 即身份，一个主题一行）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter, serializeEntry } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { searchEntriesPage } from '../../src/core/search.js';
import { handleTool } from '../../src/mcp/tools.js';
import { defaultConfig } from '../../src/core/config.js';
import { makeHome, cleanupHome } from './helpers.js';

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

function add(topic: string, body: string, fm: Partial<Frontmatter> = {}): void {
  const e = { fm: newFrontmatter({ type: 'fact', domain: 'coding', topic, ...fm }), body };
  const { path, content } = writeEntry(home, e);
  index.upsert(e, path, serializeEntry(e));
}

function seed(): void {
  add('omem-mcp-surface', '正文 参数面：只给 topic 就能取到文档', { created: '2026-10-27T00:00:00.000Z' });
  add('deploy-pipeline', '流水线配置说明 正文', { created: '2026-10-26T00:00:00.000Z' });
  add('archived-topic', '已归档的文档', { status: 'archived', created: '2026-10-20T00:00:00.000Z' });
}

describe('searchEntriesPage: topic / status', () => {
  it('topic 精确过滤，默认排除归档', () => {
    seed();
    const page = searchEntriesPage(index, { topic: 'omem-mcp-surface' });
    expect(page.rows.map((r) => r.topic)).toEqual(['omem-mcp-surface']);
    expect(page.matched).toBe(1);
  });

  it('status 显式指定时可以读回已归档文档', () => {
    seed();
    expect(searchEntriesPage(index, { topic: 'archived-topic' }).rows).toHaveLength(0);
    const page = searchEntriesPage(index, { topic: 'archived-topic', status: ['archived'] });
    expect(page.rows.map((r) => r.topic)).toEqual(['archived-topic']);
  });

  it('topic + query 组合是在主题内搜索', () => {
    seed();
    const hit = searchEntriesPage(index, { topic: 'deploy-pipeline', query: '流水线' });
    expect(hit.rows.map((r) => r.topic)).toEqual(['deploy-pipeline']);

    // 同一个词换到别的主题里搜不到
    const miss = searchEntriesPage(index, { topic: 'omem-mcp-surface', query: '流水线' });
    expect(miss.rows).toHaveLength(0);
  });

  it('topic 不存在时返回空而不是报错', () => {
    seed();
    const page = searchEntriesPage(index, { topic: 'no-such-topic' });
    expect(page.rows).toEqual([]);
    expect(page.matched).toBe(0);
  });

  it('matched 报总数，showing 受 limit 限制', () => {
    seed();
    const page = searchEntriesPage(index, { query: '正文', limit: 1 });
    expect(page.matched).toBeGreaterThanOrEqual(2);
    expect(page.rows).toHaveLength(1);
  });
});

describe('search_memory 工具面：topic 与 status', () => {
  it('只给 topic 就能拿到那份文档（不再需要先查 id）', async () => {
    add('omem-mcp-surface', '参数面：topic 就是句柄');
    const r = await handleTool('search_memory', { topic: 'omem-mcp-surface' }, {
      home, config: defaultConfig(), index,
    });
    const text = r.content.map((c) => c.text).join('\n');
    expect(text).toContain('omem-mcp-surface');
    expect(text).toContain('参数面');
  });

  it('topic 不存在时给零结果文案，而不是抛错', async () => {
    const r = await handleTool('search_memory', { topic: 'ghost-topic' }, {
      home, config: defaultConfig(), index,
    });
    expect(r.isError).toBeFalsy();
    expect(r.content.map((c) => c.text).join('\n')).toContain('ghost-topic');
  });
});
