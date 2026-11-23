// 中文查询规范化：整句必须能拆，显式空格必须保持严格 AND。
//
// 这套断言同时守住两件事：整句问句能被检索到（体验），
// 以及 multi-hop 的「拼起来的查询不该命中」不被 OR 回退破坏（产品语义）。
import { describe, it, expect } from 'vitest';
import { queryTokens } from '../../src/core/query-tokens.js';

describe('query tokens: Chinese sentences are split, explicit spacing is not', () => {
  it('drops question words and particles from a full sentence', () => {
    const r = queryTokens('我最近的工作都有哪些项目？');
    expect(r.tokens).toEqual(['工作', '项目']);
    expect(r.autoSplit).toBe(true);
    expect(r.normalized).toBe('工作 项目');
  });

  it('keeps an explicitly spaced multi-word query as strict AND', () => {
    const r = queryTokens('康复教练 静蹲');
    expect(r.tokens).toEqual(['康复教练', '静蹲']);
    expect(r.autoSplit).toBe(false);
  });

  it('leaves English and identifiers untouched', () => {
    const r = queryTokens('omem-global-install and mcp');
    expect(r.tokens).toEqual(['omem-global-install', 'and', 'mcp']);
    expect(r.autoSplit).toBe(false);
  });

  it('does not strip single characters that live inside real words', () => {
    // 「有」「是」不在停用字表里：删掉会把「有效」变成「效」。
    const r = queryTokens('有效的方案');
    expect(r.tokens).toEqual(['有效', '方案']);
  });

  it('falls back to the raw token when everything is a stopword', () => {
    const r = queryTokens('我的');
    expect(r.tokens).toEqual(['我的']);
    expect(r.autoSplit).toBe(false);
  });

  it('strips sentence punctuation but keeps intra-word connectors', () => {
    expect(queryTokens('部署，流水线。').tokens).toEqual(['部署', '流水线']);
    expect(queryTokens('连接池').tokens).toEqual(['连接池']);
  });

  it('a plain keyword query is unchanged and never auto-split', () => {
    const r = queryTokens('连接池');
    expect(r.tokens).toEqual(['连接池']);
    expect(r.autoSplit).toBe(false);
  });

  it('an empty or whitespace query yields no tokens', () => {
    expect(queryTokens('').tokens).toEqual([]);
    expect(queryTokens('   ').tokens).toEqual([]);
  });
});