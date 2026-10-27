// 置信度阶梯的契约（2026-10-27 核查后新增）：
// 「举证有回报」必须能测出来，否则评分口径一改，激励方向反了也没人发现。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { scoreEvidence } from '../../src/process/score.js';
import { writeSessionFile } from '../../src/collect/session-store.js';
import { makeHome, cleanupHome } from './helpers.js';

const QUOTE = '我们要把 MCP 的 save_memory 响应改成结构化输出';
const ASSISTANT_LINE = '好的，我来改。';

let home: string;
let index: OmemIndex;

function addSession(sessionId: string, quote: string, agent = 'claude-code'): void {
  const body = `## user\n${quote}\n\n## assistant\n${ASSISTANT_LINE}`;
  writeSessionFile(
    home,
    {
      session_id: sessionId,
      agent,
      project_fp: 'local:abcd1234',
      started_ts: '2026-10-27T00:00:00.000Z',
      ended_ts: '2026-10-27T00:10:00.000Z',
      cwd: 'X:/x',
      messages: [
        {
          session_id: sessionId, agent, ts: '2026-10-27T00:00:00.000Z',
          project_fp: 'local:abcd1234', role: 'user', content: quote,
        },
        {
          session_id: sessionId, agent, ts: '2026-10-27T00:01:00.000Z',
          project_fp: 'local:abcd1234', role: 'assistant', content: ASSISTANT_LINE,
        },
      ],
    },
    body,
    `hash-${sessionId}`,
  );
}

const score = (input: Parameters<typeof scoreEvidence>[1]) => scoreEvidence(home, input, index);

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  addSession('probe-0001', QUOTE);
  index.catchUp();
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('score ladder: 证据与引用的组合', () => {
  it('不给证据也不给会话 → 0.55 + pending-session', () => {
    const r = score({ content: 'x' });
    expect(r.confidence).toBe(0.55);
    expect(r.tags).toContain('pending-session');
  });

  it('证据命中被引会话 → 0.55（锚定本身不额外加分）', () => {
    const r = score({ content: 'x', sessionId: 'probe-0001', evidence: [QUOTE] });
    expect(r.confidence).toBe(0.55);
    expect(r.tags).toEqual([]);
    expect(r.anchors?.matched).toHaveLength(1);
  });

  it('带 collector 前缀的 session_id 同样锚定成功（不应掉到 0.35）', () => {
    const r = score({ content: 'x', sessionId: 'claude-code:probe-0001', evidence: [QUOTE] });
    expect(r.confidence).toBe(0.55);
    expect(r.tags).toEqual([]);
    expect(r.sessionFound).toBe(true);
  });

  it('不指名会话时，首个命中不算独立印证 → 与指名同分（0.55，不倒挂）', () => {
    const withSession = score({ content: 'x', sessionId: 'probe-0001', evidence: [QUOTE] });
    const withoutSession = score({ content: 'x', evidence: [QUOTE] });
    expect(withoutSession.confidence).toBe(0.55);
    // 这是核查里发现的倒挂：修之前 withoutSession 是 0.65 > withSession 0.55。
    expect(withoutSession.confidence).toBeLessThanOrEqual(withSession.confidence);
  });

  it('第二份会话独立印证同一句话 → 才有加分（0.65）', () => {
    addSession('probe-0002', QUOTE, 'qwenwork');
    index.catchUp();
    const r = score({ content: 'x', evidence: [QUOTE] });
    expect(r.confidence).toBe(0.65);
    expect(r.tags).toEqual([]);
  });

  it('证据取自 assistant 段 → 0.35 + ungrounded', () => {
    const r = score({ content: 'x', sessionId: 'probe-0001', evidence: [ASSISTANT_LINE] });
    expect(r.confidence).toBe(0.35);
    expect(r.tags).toContain('ungrounded');
  });

  it('超短证据被过滤掉，等同于举证失败（0.35）', () => {
    const r = score({ content: 'x', sessionId: 'probe-0001', evidence: ['太短了'] });
    expect(r.confidence).toBe(0.35);
    expect(r.tags).toContain('ungrounded');
    expect(r.anchors?.total).toBe(0);
  });

  it('引用不存在的会话 → 明确标出 sessionFound=false，但仍按未锚定处理', () => {
    const r = score({ content: 'x', sessionId: 'probe-9999', evidence: [QUOTE] });
    expect(r.sessionFound).toBe(false);
    expect(r.confidence).toBe(0.35);
    expect(r.tags).toContain('ungrounded');
  });

  it('多证据逐条归属：一条真一条假只报 1/2', () => {
    const r = score({
      content: 'x',
      sessionId: 'probe-0001',
      evidence: [QUOTE, '这句在会话里根本不存在 evidence-fake'],
    });
    expect(r.anchors?.total).toBe(2);
    expect(r.anchors?.matched).toHaveLength(1);
  });
});
