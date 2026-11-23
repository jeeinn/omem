// 整句中文查询必须能命中；显式空格的多词查询必须保持严格 AND。
//
// 这是第 3 点的验收口径：(a) 用户/agent 用整句提问不该 0 命中；
// (b) multi-hop 的产品语义（两个子问题拼成一个查询时不命中）不能被放宽改掉。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { searchEntriesPage } from '../../src/core/search.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  index.close();
  cleanupHome(home, { keep: false });
});

function write(topic: string, content: string): void {
  const r = commitEntry(home, defaultConfig(), index, {
    content,
    type: 'fact',
    topic,
    source: 'agent',
    confidence: 0.55,
  });
  expect(r.status).toBe('written');
  index.upsert(r.entry as never, r.path, readFileSync(r.path, 'utf8'));
}

describe('chinese sentence query', () => {
  it('a full-sentence question finds the document instead of returning nothing', () => {
    write('matea-overview', 'Matea 是一个 Gitea 工作流桥接项目，把 Agent 中枢接到 Gitea 上。');
    write('knee-rehab', '膝盖康复：静蹲隔天，加单腿硬拉。');

    const page = searchEntriesPage(index, { query: '我最近的工作都有哪些项目？', limit: 10 });
    expect(page.tokens).toEqual(['工作', '项目']);
    expect(page.rows.map((r) => r.topic)).toContain('matea-overview');
    expect(page.matched).toBeGreaterThan(0);
  });

  it('an explicitly spaced query stays strict AND (multi-hop semantics preserved)', () => {
    write('rehab-coach', '康复教练建议每周三次训练。');
    write('knee-rehab', '膝盖康复：静蹲隔天，加单腿硬拉。');

    // 两个词各自命中不同文档，但拼起来必须 0 命中——这是有意的产品语义。
    const page = searchEntriesPage(index, { query: '康复教练 静蹲', limit: 10 });
    expect(page.tokens).toEqual(['康复教练', '静蹲']);
    expect(page.relaxed).toBeUndefined();
    expect(page.matched).toBe(0);
  });

  it('relaxation only applies to auto-split queries and is reported', () => {
    // 两个文档各只含一个关键词：严格 AND 必然 0 命中，退回 OR 才有结果。
    write('work-log', '本周工作：把 matea 的桥接包接进中枢。');
    write('project-list', '在做的项目清单：omem、matea、终端浏览器。');

    const page = searchEntriesPage(index, { query: '我最近的工作都有哪些项目？', limit: 10 });
    expect(page.tokens).toEqual(['工作', '项目']);
    expect(page.relaxed).toBe(true);
    expect(page.matched).toBe(2);
  });

  it('an unmatched sentence reports the tokens it actually searched for', () => {
    const page = searchEntriesPage(index, { query: '我最近的工作都有哪些项目？', limit: 10 });
    expect(page.matched).toBe(0);
    expect(page.tokens).toEqual(['工作', '项目']);
    expect(page.relaxed).toBeUndefined();
  });
});