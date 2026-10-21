// API 档工作队列测试（档 3 文档 §3.5 状态机）：判定/重排/隔离/过滤/排序。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import {
  parseApiState,
  formatApiState,
  classifySession,
  materializeQueue,
  API_PROMPT_VERSION,
} from '../../src/process/queue.js';
import { makeHome, cleanupHome } from './helpers.js';

function recOf(over: Partial<{ session_id: string; content_hash: string; api_state: string | null; last_ts: string }> = {}) {
  return {
    session_id: over.session_id ?? 'claude-code:s1',
    agent: 'claude-code',
    path: 'p.md',
    content_hash: over.content_hash ?? 'h1',
    api_state: over.api_state ?? null,
    project_fp: 'proj-x',
    msg_count: 2,
    last_ts: over.last_ts ?? '2026-10-20T10:00:00.000Z',
    processed_at: 'now',
  };
}

describe('queue: api_state parse/format', () => {
  it('round-trips ok / fail / skip', () => {
    expect(parseApiState('ok:v1:abc123')).toEqual({ status: 'ok', prompt: 'v1', hash: 'abc123', count: 0 });
    expect(parseApiState('fail:v1:abc123:1')).toEqual({ status: 'fail', prompt: 'v1', hash: 'abc123', count: 1 });
    expect(parseApiState('skip:v1:abc123')).toEqual({ status: 'skip', prompt: 'v1', hash: 'abc123', count: 0 });
    expect(formatApiState({ status: 'fail', prompt: 'v1', hash: 'abc123', count: 2 })).toBe('fail:v1:abc123:2');
    expect(formatApiState({ status: 'ok', prompt: 'v1', hash: 'abc123', count: 0 })).toBe('ok:v1:abc123');
  });

  it('rejects garbage and missing/empty', () => {
    expect(parseApiState(null)).toBeNull();
    expect(parseApiState('')).toBeNull();
    expect(parseApiState('ok')).toBeNull();
    expect(parseApiState('ok:v1')).toBeNull();
    expect(parseApiState('bogus:v1:h1')).toBeNull();
    expect(parseApiState('ok::h1')).toBeNull();
  });
});

describe('queue: classifySession state machine', () => {
  it('missing state → pending', () => {
    expect(classifySession(recOf()).verdict).toBe('pending');
  });

  it('ok with matching hash+prompt → done', () => {
    expect(classifySession(recOf({ api_state: `ok:${API_PROMPT_VERSION}:h1` })).verdict).toBe('done');
  });

  it('content hash change → requeue (old state ignored)', () => {
    const r = classifySession(recOf({ api_state: 'ok:v1:old-h', content_hash: 'new-h' }));
    expect(r.verdict).toBe('pending');
    expect(r.requeuedByPrompt).toBe(false);
  });

  it('prompt version change → requeue flagged requeuedByPrompt', () => {
    const r = classifySession(recOf({ api_state: 'ok:v2:h1' }), 'v3');
    expect(r.verdict).toBe('pending');
    expect(r.requeuedByPrompt).toBe(true);
  });

  it('fail keeps count for retry; skip quarantines', () => {
    const f = classifySession(recOf({ api_state: `fail:${API_PROMPT_VERSION}:h1:1` }));
    expect(f.verdict).toBe('pending');
    expect(f.failCount).toBe(1);
    expect(classifySession(recOf({ api_state: `skip:${API_PROMPT_VERSION}:h1` })).verdict).toBe('quarantined');
  });
});

describe('queue: materializeQueue', () => {
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

  function seed(id: string, apiState: string | null, lastTs: string, hash = 'h1') {
    index.putSession(recOf({ session_id: id, api_state: apiState, last_ts: lastTs, content_hash: hash }) as any);
  }

  it('orders last_ts DESC; limit takes the newest; overflow stays queued (V21)', () => {
    seed('claude-code:old', null, '2026-10-18T10:00:00.000Z');
    seed('claude-code:mid', null, '2026-10-19T10:00:00.000Z');
    seed('claude-code:new', null, '2026-10-20T10:00:00.000Z');
    const q = materializeQueue(index, { limit: 2 });
    expect(q.pending).toBe(3);
    expect(q.overflow).toBe(1);
    expect(q.items.map((i) => i.sessionId)).toEqual(['new', 'mid']);
  });

  it('V20: stock sessions with no api_state are all pending', () => {
    for (let i = 0; i < 5; i++) seed(`claude-code:s${i}`, null, `2026-10-1${i}T10:00:00.000Z`);
    const q = materializeQueue(index, {});
    expect(q.pending).toBe(5);
    expect(q.items).toHaveLength(5);
  });

  it('V22: skip is counted as quarantined and excluded; --session overrides', () => {
    seed('claude-code:q1', `skip:${API_PROMPT_VERSION}:h1`, '2026-10-20T10:00:00.000Z');
    seed('claude-code:fine', null, '2026-10-19T10:00:00.000Z');
    const q = materializeQueue(index, {});
    expect(q.quarantined).toBe(1);
    expect(q.items.map((i) => i.sessionId)).toEqual(['fine']);
    const explicit = materializeQueue(index, { sessionId: 'q1' });
    expect(explicit.items.map((i) => i.sessionId)).toEqual(['q1']);
  });

  it('prompt version requeue shows up in requeuedByPrompt', () => {
    seed('claude-code:a', `ok:v0:${'h1'}`, '2026-10-20T10:00:00.000Z');
    seed('claude-code:b', null, '2026-10-19T10:00:00.000Z');
    const q = materializeQueue(index, { promptVersion: 'v1' });
    expect(q.pending).toBe(2);
    expect(q.requeuedByPrompt).toBe(1);
  });

  it('ok sessions are not queued; content change re-queues (V27)', () => {
    seed('claude-code:done', `ok:${API_PROMPT_VERSION}:h1`, '2026-10-20T10:00:00.000Z');
    expect(materializeQueue(index, {}).pending).toBe(0);
    seed('claude-code:done', `ok:${API_PROMPT_VERSION}:h1`, '2026-10-20T10:00:00.000Z', 'h2');
    const q = materializeQueue(index, {});
    expect(q.pending).toBe(1);
    expect(q.items[0].requeuedByPrompt).toBe(false);
  });

  it('--since filters by last_ts; explicit session ignores since and limit', () => {
    seed('claude-code:old', null, '2026-10-01T10:00:00.000Z');
    seed('claude-code:new', null, '2026-10-20T10:00:00.000Z');
    const q = materializeQueue(index, { since: '2026-10-15', limit: 1 });
    expect(q.items.map((i) => i.sessionId)).toEqual(['new']);
    const explicit = materializeQueue(index, { sessionId: 'old', since: '2026-10-15', limit: 1 });
    expect(explicit.items.map((i) => i.sessionId)).toEqual(['old']);
    expect(explicit.overflow).toBe(0);
  });

  it('explicit --session targets a done session too (single-session rework)', () => {
    seed('claude-code:done', `ok:${API_PROMPT_VERSION}:h1`, '2026-10-20T10:00:00.000Z');
    const q = materializeQueue(index, { sessionId: 'done' });
    expect(q.items.map((i) => i.sessionId)).toEqual(['done']);
  });
});
