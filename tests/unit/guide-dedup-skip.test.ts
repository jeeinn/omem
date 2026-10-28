// PROCESS.md 待办清单：片段级去重、skip 台账、大组优先、可配 batch（2026-10-28 实操反馈）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { files } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';
import { pendingTopics, renderGuide, loadSkipLedger } from '../../src/process/guide.js';
import { writeSessionFile } from '../../src/collect/session-store.js';
import { cmdSkip } from '../../src/commands/skip.js';

let home: string;
let index: ReturnType<typeof OmemIndex>;

const QUOTE_A = '用户原话片段甲：把待办清单按价值排序。';
const QUOTE_B = '用户原话片段乙：另一组讨论的内容。';
const QUOTE_C = '用户原话片段丙：第三组只有一句话。';

function addSession(sessionId: string, projectFp: string, quote: string): void {
  const body = `## user\n${quote}\n\n## assistant\n助手的回答。`;
  writeSessionFile(home, {
    session_id: sessionId,
    agent: 'workbuddy',
    project_fp: projectFp,
    started_ts: '2026-10-28T00:00:00.000Z',
    ended_ts: '2026-10-28T00:10:00.000Z',
    cwd: 'X:/x',
    messages: [{
      session_id: sessionId, agent: 'workbuddy', ts: '2026-10-28T00:00:00.000Z',
      project_fp: projectFp, role: 'user', content: quote,
    }],
  }, body, `hash-${sessionId}`);
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  try { index.close(); } catch { /* 个别用例已关闭 */ }
  cleanupHome(home);
});

describe('片段级去重（user_hash）', () => {
  it('同一段内容不同 metadata 的两个会话 → 合并一行 copies:2，counts.sessions 仍为 2', () => {
    addSession('dup-a', 'local:aaa', QUOTE_A);
    addSession('dup-b', 'local:aaa', QUOTE_A); // 同 user 段，仅 session_id 不同
    addSession('solo-c', 'local:aaa', QUOTE_B);
    index.catchUp();
    const [topics, , , counts] = pendingTopics(home, index);
    const group = topics.find((t) => t.topic === 'local:aaa');
    expect(group?.sessions).toHaveLength(2); // dup 对 + solo
    const dup = group?.sessions.find((s) => s.sessionId === 'dup-a');
    expect(dup?.copies).toBe(2);
    expect(counts.sessions).toBe(3);
    const text = renderGuide(topics, 0, [], [], { sessions: counts.sessions, shownSessions: counts.shownSessions });
    expect(text).toContain('(copies: 2)');
  });

  it('吸收同片段的一个会话后，另一个同指纹会话也退出待办', () => {
    addSession('dup-a', 'local:aaa', QUOTE_A);
    addSession('dup-b', 'local:aaa', QUOTE_A);
    index.catchUp();
    commitEntry(home, defaultConfig(), index, {
      content: '吸收了片段甲的结论 absorption-by-fingerprint',
      type: 'fact',
      source: 'agent',
      session_id: 'dup-a',
      project: 'local:aaa',
      confidence: 0.55,
      verified: false,
    });
    index.catchUp();
    const [topics, , , counts] = pendingTopics(home, index);
    const group = topics.find((t) => t.topic === 'local:aaa');
    expect(group?.sessions.find((s) => s.sessionId === 'dup-b')).toBeUndefined();
    expect(counts.sessions).toBe(0);
  });
});

describe('skip 台账', () => {
  it('skipped 会话退出待办；台账文件可 list/remove 往返', async () => {
    addSession('skip-me', 'local:bbb', QUOTE_B);
    addSession('keep-me', 'local:bbb', QUOTE_C);
    index.catchUp();
    const prev = process.env.OMEM_HOME;
    process.env.OMEM_HOME = home;
    try {
      expect(await cmdSkip({ _: ['skip-me'], flags: { reason: 'duplicate' } })).toBe(0);
      expect(loadSkipLedger(home)).toHaveLength(1);
      const [topics] = pendingTopics(home, index);
      const group = topics.find((t) => t.topic === 'local:bbb');
      expect(group?.sessions.map((s) => s.sessionId)).toEqual(['keep-me']);
      expect(await cmdSkip({ _: ['list'], flags: {} })).toBe(0);
      expect(await cmdSkip({ _: ['remove', 'skip-me'], flags: {} })).toBe(0);
      expect(loadSkipLedger(home)).toHaveLength(0);
      const [restored] = pendingTopics(home, index);
      expect(restored.find((t) => t.topic === 'local:bbb')?.sessions).toHaveLength(2);
    } finally {
      if (prev === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prev;
    }
  });

  it('skip.json 损坏 → 降级为空清单，不崩溃', () => {
    addSession('solo-x', 'local:ccc', QUOTE_C);
    mkdirSync(join(home, 'index'), { recursive: true });
    writeFileSync(files.skipLedger(home), '{not json', 'utf8');
    index.catchUp();
    const [topics] = pendingTopics(home, index);
    expect(topics.find((t) => t.topic === 'local:ccc')?.sessions).toHaveLength(1);
  });
});

describe('排序与可配 batch', () => {
  beforeEach(() => {
    for (const sid of ['big-1', 'big-2', 'big-3']) addSession(sid, 'local:big', `大组会话 ${sid} 的独有内容。`);
    addSession('small-1', 'local:small', '小组唯一的会话内容。');
    addSession('mid-1', 'local:mid', '中间组的会话内容之一。');
    addSession('mid-2', 'local:mid', '中间组的会话内容之二。');
    index.catchUp();
  });

  it('组按未吸收会话数降序进窗口：big(3) > mid(2) > small(1)', () => {
    const [topics] = pendingTopics(home, index);
    expect(topics.map((t) => t.topic)).toEqual(['local:big', 'local:mid', 'local:small']);
  });

  it('guide_batch=1 只渲染一组，remaining 正确', () => {
    const config = { ...defaultConfig(), process: { ...defaultConfig().process, guide_batch: 1 } };
    const [topics, remaining, , counts] = pendingTopics(home, index, config);
    expect(topics).toHaveLength(1);
    expect(topics[0].topic).toBe('local:big');
    expect(remaining).toBe(2);
    expect(counts.sessions).toBe(6);
  });

  it('批头文案同时给出组数/会话数与未吸收口径，不再暗示 sync 会提炼', () => {
    const config = { ...defaultConfig(), process: { ...defaultConfig().process, guide_batch: 1 } };
    const [topics, remaining, , counts] = pendingTopics(home, index, config);
    const text = renderGuide(topics, remaining, [], [], { sessions: counts.sessions, shownSessions: counts.shownSessions });
    expect(text).toContain('1 group(s) / 3 session(s) shown');
    expect(text).toContain('2 group(s) and 3 session(s) still unabsorbed');
    expect(text).toContain('the agent distills via save_memory');
    expect(text).not.toContain('left for the next');
  });
});
