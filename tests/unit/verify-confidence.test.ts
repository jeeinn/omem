// omem verify 的账本复算（重构方案 §4「可复算」+ §11 验收）。
//
// 它要回答的问题不是「文件还在不在」，而是「这条记忆的分数还对不对得上它的证据」：
// 落盘的 confidence 是写入那一刻算的，证据域却会变 —— 会话被删、原文被改、
// 同一段话又出现了新的独立来源。verify 重算一遍并报告差异，**不改写**。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { listEntries } from '../../src/core/store.js';
import { scoreEvidence, verifyConfidence } from '../../src/process/score.js';
import { reconfirm } from '../../src/core/lifecycle.js';
import { writeSessionFile } from '../../src/collect/session-store.js';
import { makeHome, cleanupHome } from './helpers.js';

const QUOTE = '以后都用手写 SQL，不要用 ORM 框架';

let home: string;
let index: OmemIndex;

function addSession(id: string, user: string, agent = 'cursor'): void {
  const body = `## user\n${user}\n\n## assistant\n好的`;
  writeSessionFile(
    home,
    {
      session_id: id,
      agent,
      project_fp: 'local:abcd1234',
      started_ts: '2026-11-01T00:00:00.000Z',
      ended_ts: '2026-11-01T00:10:00.000Z',
      cwd: 'X:/x',
      messages: [
        { session_id: id, agent, ts: '2026-11-01T00:00:00.000Z', project_fp: 'local:abcd1234', role: 'user', content: user },
        { session_id: id, agent, ts: '2026-11-01T00:01:00.000Z', project_fp: 'local:abcd1234', role: 'assistant', content: '好的' },
      ],
    },
    body,
    `hash-${id}`,
  );
}

/** 按当前证据算出来的分（写入时用的就是这个函数）。 */
function score(sessionId: string, evidence: string[], sessionIds: string[] = []): number {
  return scoreEvidence(home, { content: '结论正文', sessionId, sessionIds, evidence }, index).confidence;
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('verify: 账本复算只报告、不改写', () => {
  it('刚写入的条目与账本一致（无漂移）', () => {
    addSession('s1', QUOTE);
    index.catchUp();
    const c = score('s1', [QUOTE]);
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: '这个项目用手写 SQL', type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', evidence: [QUOTE], confidence: c,
    });
    const r = verifyConfidence(home, index);
    expect(r.checked).toBe(1);
    expect(r.drifts).toEqual([]);
  });

  it('会话原文被删后，条目分数高于账本允许的上界 → 报 overstated', () => {
    addSession('s1', QUOTE);
    index.catchUp();
    const c = score('s1', [QUOTE]);
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: '这个项目用手写 SQL', type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', evidence: [QUOTE], confidence: c,
    });
    // 证据失效：会话文件不在了
    rmSync(join(home, 'sessions', 'cursor', 's1.md'), { force: true });
    index.catchUp();
    const r = verifyConfidence(home, index);
    expect(r.drifts.length).toBe(1);
    expect(r.drifts[0].topic).toBe('sql-policy');
    expect(r.drifts[0].verdict).toBe('overstated');
    expect(r.drifts[0].max).toBeLessThan(r.drifts[0].stored);
  });

  it('人写的条目（manual）与人工过目的条目不参与比对', () => {
    addSession('s1', QUOTE);
    index.catchUp();
    commitEntry(home, defaultConfig(), index, {
      topic: 'manual-one', content: '用户亲口说的内容', type: 'fact', domain: 'coding',
      source: 'manual', confidence: 0.9,
    });
    commitEntry(home, defaultConfig(), index, {
      topic: 'reviewed-one', content: '被过目过的内容', type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', evidence: [QUOTE], confidence: 0.9,
    });
    // 真正过目的条目：confirmations > 0（落盘 0.9 是设计值，不是自动分）
    reconfirm(home, index, 'reviewed-one');
    const r = verifyConfidence(home, index);
    expect(r.checked).toBe(0);
    expect(r.skipped).toBe(2);
    expect(r.drifts).toEqual([]);
  });

  it('verify 只报告，不改写文件', () => {
    addSession('s1', QUOTE);
    index.catchUp();
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: '这个项目用手写 SQL', type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', evidence: [QUOTE], confidence: 0.9,
    });
    const before = listEntries(home).map((l) => `${l.path}:${l.entry.fm.confidence}`).join('|');
    rmSync(join(home, 'sessions', 'cursor', 's1.md'), { force: true });
    index.catchUp();
    verifyConfidence(home, index);
    const after = listEntries(home).map((l) => `${l.path}:${l.entry.fm.confidence}`).join('|');
    expect(after).toBe(before);
  });

  it('重复写入的活文档不会因为写入批次不同而误报', () => {
    addSession('s1', QUOTE);
    addSession('s2', '顺便说一句，' + QUOTE);
    index.catchUp();
    const c1 = score('s1', [QUOTE]);
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: '这个项目用手写 SQL', type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', evidence: [QUOTE], confidence: c1,
    });
    // 第二次写入：主来源换成 s2，并把 s1 也记进账本
    const c2 = score('s2', [QUOTE], ['s1']);
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: '这个项目用手写 SQL（更新）', type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's2', source_sessions: ['s1'], evidence: [QUOTE], confidence: c2,
    });
    const r = verifyConfidence(home, index);
    expect(r.drifts).toEqual([]);
  });
});
