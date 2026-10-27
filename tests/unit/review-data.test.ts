// review --ui 的数据装配：版本链、flag 汇总、会话标题解析。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { findById, writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { dirs } from '../../src/core/paths.js';
import { atomicWrite } from '../../src/core/util.js';
import {
  buildReviewDetail,
  buildReviewItem,
  clearSessionTitleCache,
  resolveSessionTitles,
} from '../../src/web/review-data.js';
import type { SessionPathIndex } from '../../src/web/review-data.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function add(id: string, body: string, fm: Partial<Frontmatter> = {}): void {
  const e = { fm: newFrontmatter({ id, type: 'fact', domain: 'coding', ...fm }), body };
  const { path, content } = writeEntry(home, e);
  index.upsert(e, path, content);
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  clearSessionTitleCache();
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('buildReviewItem', () => {
  it('摘要取正文前两句，计数与 flags 正确', () => {
    add('2026-10-27-a1', '连接池上限设为 20。超过就排队，不要盲目调大。第三句不该出现。', {
      confidence: 0.55,
      tags: ['ungrounded'],
      evidence: ['连接池上限设为 20'],
      source_sessions: ['s1', 's2'],
      topic: 'pool-tuning',
    });

    const item = buildReviewItem(home, findById(home, '2026-10-27-a1')!);

    expect(item.topic).toBe('pool-tuning');
    expect(item.evidenceCount).toBe(1);
    expect(item.sessionCount).toBe(2);
    expect(item.flags).toContain('ungrounded');
    expect(item.summary).toContain('连接池上限设为 20');
    expect(item.summary).not.toContain('第三句');
    expect(item.versionChain).toEqual([]);
  });

  it('versionChain 沿 supersedes 向上追溯（新版 → 旧版 → 更旧版）', () => {
    add('2026-10-01-v1', '第一版');
    add('2026-10-15-v2', '第二版', { supersedes: ['2026-10-01-v1'] });
    add('2026-10-27-v3', '第三版', { supersedes: ['2026-10-15-v2'] });

    const item = buildReviewItem(home, findById(home, '2026-10-27-v3')!);

    expect(item.versionChain).toEqual(['2026-10-15-v2', '2026-10-01-v1']);
  });

  it('supersedes 自环不死循环（脏数据防护）', () => {
    add('2026-10-27-loop', '自环', { supersedes: ['2026-10-27-loop'] });
    const item = buildReviewItem(home, findById(home, '2026-10-27-loop')!);
    expect(item.versionChain).toEqual([]);
  });

  it('指向不存在的旧版时截断，不抛错', () => {
    add('2026-10-27-orphan', '孤儿', { supersedes: ['2026-01-01-gone'] });
    const item = buildReviewItem(home, findById(home, '2026-10-27-orphan')!);
    expect(item.versionChain).toEqual([]);
  });
});

describe('resolveSessionTitles', () => {
  function writeSession(sessionId: string, agent: string, body: string): string {
    const dir = join(dirs.sessions(home), agent);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.md`);
    atomicWrite(
      path,
      `---
agent: ${agent}
session_id: ${sessionId}
project: fp1
started: 2026-10-19T10:00:00.000Z
ended: 2026-10-19T11:00:00.000Z
messages: 4
content_hash: deadbeef
---

${body}
`,
    );
    return path;
  }

  it('标题取首条 ## user 段的首个非空行', () => {
    const path = writeSession(
      's1',
      'claude-code',
      '## user\n\n  营业款扣款页筛选近三天就 502，怎么改？  \n\n## assistant\n\n走索引。',
    );
    const sessionIndex: SessionPathIndex = new Map([['s1', { agent: 'claude-code', path }]]);

    const { sessions, misses } = resolveSessionTitles(sessionIndex, ['s1']);

    expect(sessions[0].found).toBe(true);
    expect(sessions[0].agent).toBe('claude-code');
    expect(sessions[0].title).toBe('营业款扣款页筛选近三天就 502，怎么改？');
    expect(sessions[0].messages).toBe(4);
    expect(misses).toBe(1);
  });

  it('标题超过 60 字符时截断', () => {
    const long = '很长的标题'.repeat(30);
    const path = writeSession('s2', 'cursor', `## user\n${long}\n`);
    const sessionIndex: SessionPathIndex = new Map([['s2', { agent: 'cursor', path }]]);

    const { sessions } = resolveSessionTitles(sessionIndex, ['s2']);

    expect([...sessions[0].title].length).toBeLessThanOrEqual(60);
  });

  it('会话不在索引里 → 占位，不抛错', () => {
    const { sessions } = resolveSessionTitles(new Map(), ['ghost']);
    expect(sessions[0].found).toBe(false);
    expect(sessions[0].title).toContain('not found');
  });

  it('同一会话第二次解析命中缓存', () => {
    const path = writeSession('s3', 'codebuddy', '## user\n缓存测试\n');
    const sessionIndex: SessionPathIndex = new Map([['s3', { agent: 'codebuddy', path }]]);

    resolveSessionTitles(sessionIndex, ['s3']);
    const second = resolveSessionTitles(sessionIndex, ['s3']);

    expect(second.hits).toBe(1);
    expect(second.misses).toBe(0);
  });
});

describe('buildReviewDetail', () => {
  it('带上正文、evidence、supersedes 与会话标题', () => {
    add('2026-10-27-d1', '正文内容。', {
      evidence: ['原始证据'],
      source_sessions: ['ghost'],
      supersedes: ['2026-10-01-old'],
    });

    const detail = buildReviewDetail(home, findById(home, '2026-10-27-d1')!, new Map());

    expect(detail.body).toContain('正文内容');
    expect(detail.evidence).toEqual(['原始证据']);
    expect(detail.supersedes).toEqual(['2026-10-01-old']);
    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0].found).toBe(false);
    expect(detail.versionChain).toEqual([]);
  });
});
