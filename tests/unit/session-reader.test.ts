// session 读取通道（beta.9 / T04 / P1-7）：按裸 id 取回可复制的 `## user` 段。
//
// 清单去掉绝对路径之后，这是唯一的正文读取通道，所以三条性质必须钉死：
//   ① 返回的是剥净后的 `## user` 原文（不含 metadata 围栏），可直接粘进 evidence；
//   ② 每段带字符范围（code point），调用方不必自己数；
//   ③ assistant 段只计数、不进正文——它不是证据，给出来只会被当原文引用。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { defaultConfig } from '../../src/core/config.js';
import { writeSessionFile } from '../../src/collect/session-store.js';
import { handleTool } from '../../src/mcp/tools.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

const Q1 = '2026年4月份有什么新车上市发布吗';
const Q2 = '那预算 20 万以内有什么选择';
const A1 = '好的，已记录：传祺M8 2.0T，落地16.8万。';
const BODY = [
  '## user',
  'Conversation info (untrusted metadata):',
  '```json',
  '{ "message_id": "openclaw-weixin:1775663373554-8ba9b44e", "timestamp": "Wed 2026-04-08 23:49 GMT+8" }',
  '```',
  '',
  Q1,
  '',
  '## assistant',
  A1,
  '',
  '## user',
  Q2,
].join('\n');

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  writeSessionFile(home, {
    session_id: '8225ff29-0000-4a1b-9c3d-000000000001',
    agent: 'workbuddy',
    project_fp: 'local:aaa',
    started_ts: '2026-10-28T00:00:00.000Z',
    ended_ts: '2026-10-28T00:10:00.000Z',
    cwd: 'X:/x',
    messages: [{ session_id: 's', agent: 'workbuddy', ts: '2026-10-28T00:00:00.000Z', project_fp: 'local:aaa', role: 'user', content: Q1 }],
  }, BODY, 'hash-1');
  index.catchUp();
});

afterEach(() => {
  try { index.close(); } catch { /* 个别用例已关闭 */ }
  cleanupHome(home);
});

const SID = '8225ff29-0000-4a1b-9c3d-000000000001';

function ctx() {
  return { home, config: defaultConfig(), index };
}

async function read(args: Record<string, any>) {
  const r = await handleTool('search_memory', args, ctx());
  return { text: r.content.map((c) => c.text).join('\n'), sc: r.structuredContent as Record<string, any>, isError: r.isError };
}

describe('search_memory(session_id=…)：可复制的 ## user 段', () => {
  it('返回剥净的 ## user 段（不含 Conversation info）+ 字符范围 + assistant 计数', async () => {
    const { text, sc } = await read({ session_id: SID });
    expect(sc.scope).toBe('sessions');
    expect(sc.session_id).toBe(SID);
    expect(sc.segments.length).toBe(2);
    expect(sc.segments[0].role).toBe('user');
    expect(sc.segments[0].text).toBe(Q1);
    expect(sc.segments[1].text).toBe(Q2);
    // assistant 段只计数，不进正文
    expect(sc.assistant_segments).toBe(1);
    expect(text).not.toContain(A1);
    expect(text).not.toContain('Conversation info');
    expect(text).toContain('Only ## user text is returned; assistant text is never evidence.');
    // 路径仍然给（读取失败时用户能自己打开），但清单里不再有它
    expect(sc.path).toContain(SID);
  });

  it('字符范围能对回会话文件的原文（code point 偏移，可直接用于 evidence）', async () => {
    const { sc } = await read({ session_id: SID });
    const chars = [...BODY];
    for (const seg of sc.segments) {
      const [start, end] = seg.chars as [number, number];
      expect(chars.slice(start, end).join('')).toBe(seg.text);
    }
  });

  it('带 query 时在该会话内做子串过滤（不走 FTS）', async () => {
    const { sc } = await read({ session_id: SID, query: '预算' });
    expect(sc.matched).toBe(1);
    expect(sc.segments).toHaveLength(1);
    expect(sc.segments[0].text).toBe(Q2);
  });

  it('offset / limit 分页', async () => {
    const first = await read({ session_id: SID, limit: 1 });
    expect(first.sc.segments).toHaveLength(1);
    expect(first.sc.segments[0].text).toBe(Q1);
    const second = await read({ session_id: SID, offset: 1, limit: 1 });
    expect(second.sc.segments[0].text).toBe(Q2);
    // 越界只是空页，不报错（Agent 会自己停）
    const past = await read({ session_id: SID, offset: 9 });
    expect(past.sc.showing).toBe(0);
    expect(past.isError).toBeFalsy();
  });

  it('session_id 隐含 scope=sessions；显式 scope=conclusions 会被拒绝并提示', async () => {
    const bad = await read({ session_id: SID, scope: 'conclusions' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('session_id implies scope=sessions');
  });

  it('不存在的 session 给明确出处，而不是空结果', async () => {
    const { text, sc } = await read({ session_id: 'no-such-session' });
    expect(sc.matched).toBe(0);
    expect(text).toContain('No transcript found for session "no-such-session"');
    expect(sc.note).toContain('omem sync');
  });
});
