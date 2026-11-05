// Golden 检索基线（B 阶段等价性护栏）。
//
// 为什么先写它：B 阶段要把 SQLite/FTS5 换成内存索引 + 确定性排序，
// 「结果是否等价」不能靠抽样目测。这里固定一份语料与一组查询，
// 换实现后必须逐条相同；排序若有变化，第一个断言的 diff 会直接指出是哪一条。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { moveToArchive, updateTopic } from '../../src/core/store.js';
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
  cleanupHome(home);
});

function write(content: string, topic: string, opts: Partial<Parameters<typeof commitEntry>[3]> = {}): void {
  const r = commitEntry(home, defaultConfig(), index, {
    content,
    type: 'fact',
    topic,
    source: 'agent',
    confidence: 0.55,
    ...opts,
  });
  expect(r.status).toBe('written');
}

function seedCorpus(): void {
  write('连接池上限设为 20，超过就排队', 'pool-tuning', { confidence: 0.8 });
  write('部署流水线走 GitHub Actions，产物存 S3', 'deploy-pipeline', { confidence: 0.55 });
  write('车贷利率 3.6%，2026 年重签', 'car-loan', { confidence: 0.55 });
  write('膝盖康复：静蹲隔天，加单腿硬拉', 'knee-rehab', { confidence: 0.55 });
  write('omem 的索引是可删除的派生物', 'omem-index-shape', { confidence: 0.55 });
  // 冷却条目：排序上必须排在 active 之后（×0.5 权重）。
  // commitEntry 的 newFrontmatter 恒置 status=active，传 opts.status 无效；要造真 stale 得走 updateTopic。
  write('连接池参数调优笔记（已冷却）', 'pool-tuning-old', { confidence: 0.8 } as never);
  const cooled = updateTopic(home, 'pool-tuning-old', (fm) => { fm.status = 'stale'; })!;
  index.upsert(cooled.entry, cooled.path, readFileSync(cooled.path, 'utf8'));
  // 归档条目：默认查询不可见
  write('旧车贷合同条款（已归档）', 'car-loan-old');
  const moved = moveToArchive(home, 'car-loan-old')!;
  index.upsert(moved.entry, moved.path, '');
}

describe('golden: 查询 → 期望 topic 集合', () => {
  it('中文子串命中（≥3 字符，trigram 主路）', () => {
    seedCorpus();
    const page = searchEntriesPage(index, { query: '连接池', limit: 10 });
    expect(page.rows.map((r) => r.topic).sort()).toEqual(['pool-tuning', 'pool-tuning-old']);
    expect(page.matched).toBe(2);
  });

  it('多词 AND：两个词必须同时出现', () => {
    seedCorpus();
    const page = searchEntriesPage(index, { query: '部署 流水线', limit: 10 });
    expect(page.rows.map((r) => r.topic)).toEqual(['deploy-pipeline']);
  });

  it('短词（<3 字符）走子串兜底', () => {
    seedCorpus();
    // 「车贷」是 2 个字符：trigram 无效，必须靠兜底路径命中
    const page = searchEntriesPage(index, { query: '车贷', limit: 10 });
    expect(page.rows.map((r) => r.topic)).toEqual(['car-loan']);
  });

  it('归档默认不可见，--all 才回来', () => {
    seedCorpus();
    expect(searchEntriesPage(index, { query: '车贷', limit: 10 }).rows.map((r) => r.topic)).toEqual(['car-loan']);
    expect(searchEntriesPage(index, { query: '车贷', limit: 10, all: true }).rows.map((r) => r.topic).sort())
      .toEqual(['car-loan', 'car-loan-old']);
  });

  it('stale 与 active 同置信度时两者都能命中', () => {
    seedCorpus();
    const rows = searchEntriesPage(index, { query: '连接池', limit: 10, staleWeight: 0.5 }).rows;
    expect(rows.map((r) => r.topic).sort()).toEqual(['pool-tuning', 'pool-tuning-old']);
    expect(rows.map((r) => r.status).sort()).toEqual(['active', 'stale']);
  });

  it('stale 降权：同命中数同置信度时 active 必须排在 stale 之前', () => {
    // B 阶段遗留的自述「应新增一条明确的排序断言」在这里补上（S3）。
    seedCorpus();
    const rows = searchEntriesPage(index, { query: '连接池', limit: 10, staleWeight: 0.5 }).rows;
    expect(rows.map((r) => r.topic)).toEqual(['pool-tuning', 'pool-tuning-old']);
    expect(rows[0].status).toBe('active');
    expect(rows[1].status).toBe('stale');
  });

  it('无命中返回空，不抛错', () => {
    seedCorpus();
    const page = searchEntriesPage(index, { query: 'zzzz-不存在-xyz', limit: 10 });
    expect(page.rows).toEqual([]);
    expect(page.matched).toBe(0);
  });

  it('topic 精确过滤不受关键词影响', () => {
    seedCorpus();
    expect(searchEntriesPage(index, { topic: 'knee-rehab' }).rows.map((r) => r.topic)).toEqual(['knee-rehab']);
    expect(searchEntriesPage(index, { topic: 'nope' }).rows).toEqual([]);
  });

  it('matched 是过滤后的总数，showing 受 limit 限制', () => {
    seedCorpus();
    const page = searchEntriesPage(index, { query: '接', limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.matched).toBeGreaterThanOrEqual(page.rows.length);
  });
});
