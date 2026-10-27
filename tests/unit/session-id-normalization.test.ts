// session_id 的前缀容错（2026-10-27）：落盘文件名是裸 id，而调用方最自然的写法
// 是 PROCESS.md / scope=sessions 里看到的 `claude-code:probe-0001`。
// 只按原样拼路径时，带前缀的 id 必然落空 → evidence 静默掉到 0.35，连 project 推断一起失效。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readSessionsById, writeSessionFile } from '../../src/collect/session-store.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;

beforeEach(() => {
  home = makeHome();
  writeSessionFile(
    home,
    {
      session_id: 'probe-0001',
      agent: 'claude-code',
      project_fp: 'local:abcd1234',
      started_ts: '2026-10-27T00:00:00.000Z',
      ended_ts: '2026-10-27T00:10:00.000Z',
      cwd: 'X:/x',
      messages: [
        {
          session_id: 'probe-0001', agent: 'claude-code', ts: '2026-10-27T00:00:00.000Z',
          project_fp: 'local:abcd1234', role: 'user', content: '一句话',
        },
      ],
    },
    '## user\n一句话',
    'hash-probe-0001',
  );
});

afterEach(() => {
  cleanupHome(home);
});

describe('readSessionsById: 前缀容错', () => {
  it('裸 id 命中', () => {
    expect(readSessionsById(home, 'probe-0001')).toHaveLength(1);
  });

  it('collector 前缀（agent:id）剥掉后命中', () => {
    const hits = readSessionsById(home, 'claude-code:probe-0001');
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('probe-0001');
  });

  it('带项目 slug 前缀（slug/id）取末段后命中', () => {
    expect(readSessionsById(home, 'repo-a/probe-0001')).toHaveLength(1);
  });

  it('混合写法（agent:slug/id）也能命中', () => {
    expect(readSessionsById(home, 'claude-code:repo-a/probe-0001')).toHaveLength(1);
  });

  it('原样优先：不存在时才剥前缀，不误伤本身含冒号的 id', () => {
    expect(readSessionsById(home, 'probe-9999')).toHaveLength(0);
    expect(readSessionsById(home, '')).toHaveLength(0);
  });
});
