// source_sessions 上限：长期活文档会累积几百个会话 id，frontmatter 跟着膨胀。
//
// 上限取 200，一个刻意的取舍：absorbedSessionIds() 靠遍历 frontmatter 判断「会话是否
// 已被吸收」，所以截断理论上会让被截掉的 id 重新出现在待办里。200 次更新才触发的场景
// 现实中不存在，真触发时重跑 sync 会重新处理，内容不丢。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { findById } from '../../src/core/store.js';
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

function write(input: {
  content: string;
  topic: string;
  sessionId?: string;
  sourceSessions?: string[];
  supersedes?: string[];
}): string {
  const r = commitEntry(home, defaultConfig(), index, {
    content: input.content,
    type: 'fact',
    source: 'agent',
    confidence: 0.55,
    verified: false,
    topic: input.topic,
    session_id: input.sessionId,
    source_sessions: input.sourceSessions,
    supersedes: input.supersedes,
  }, { refreshIndex: false, refreshGuide: false });
  expect(r.status).toBe('written');
  return r.id!;
}

describe('source_sessions 上限', () => {
  it('超过 200 个时截断，最新写入的排在前面', () => {
    const bulk = Array.from({ length: 260 }, (_, i) => `s${String(i).padStart(3, '0')}`);

    const id = write({ content: '带大量会话的文档', topic: 'big-topic', sessionId: 'newest', sourceSessions: bulk });

    const sessions = findById(home, id)!.entry.fm.source_sessions;
    expect(sessions).toHaveLength(200);
    expect(sessions[0]).toBe('newest');
    expect(sessions).not.toContain('s259');
  });

  it('未超上限时全部保留，顺序是新会话在前', () => {
    const id = write({ content: '小文档', topic: 'small-topic', sessionId: 'new', sourceSessions: ['a', 'b'] });

    expect(findById(home, id)!.entry.fm.source_sessions).toEqual(['new', 'a', 'b']);
  });

  it('刚好卡在上限时不截断', () => {
    const bulk = Array.from({ length: 199 }, (_, i) => `s${i}`);

    const id = write({ content: '边界文档', topic: 'edge-topic', sessionId: 'newest', sourceSessions: bulk });

    const sessions = findById(home, id)!.entry.fm.source_sessions;
    expect(sessions).toHaveLength(200);
    expect(sessions[sessions.length - 1]).toBe('s198');
  });

  it('更新活文档时继承旧会话，仍受同一上限约束', () => {
    const bulk = Array.from({ length: 260 }, (_, i) => `old${i}`);
    const v1 = write({ content: '第一版', topic: 'pool', sessionId: 's-v1', sourceSessions: bulk });

    const v2 = write({ content: '第二版', topic: 'pool', sessionId: 's-v2', supersedes: [v1] });

    const sessions = findById(home, v2)!.entry.fm.source_sessions;
    expect(sessions).toHaveLength(200);
    expect(sessions[0]).toBe('s-v2');
    expect(sessions[1]).toBe('s-v1');
  });
});
