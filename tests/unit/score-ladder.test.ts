// 置信度阶梯的契约（2026-10-27 核查后新增）：
// 「举证有回报」必须能测出来，否则评分口径一改，激励方向反了也没人发现。
//
// D2 / M1：`verified` 布尔位已删，置信度是唯一的信任数字。这个文件把五档
// （0.35 未锚定 / 0.55 已锚定 / +印证加成 / 0.80 自动上限 / 0.90 人工过目）
// 钉在同一个地方：口径变了这里会红，而口径是产品承诺的一部分。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { SCORE_AUTO_CAP, SCORE_CONFIRMED, SCORE_GROUNDED, SCORE_UNGROUNDED, scoreEvidence } from '../../src/process/score.js';
import { REVIEW_CAP } from '../../src/core/lifecycle.js';
import { writeSessionFile } from '../../src/collect/session-store.js';
import { makeHome, cleanupHome } from './helpers.js';

const QUOTE = '我们要把 MCP 的 save_memory 响应改成结构化输出';
const ASSISTANT_LINE = '好的，我来改。';

let home: string;
let index: OmemIndex;

function addSession(sessionId: string, quote: string, agent = 'claude-code', extra = ''): void {
  // extra 用来制造「不同的用户输入」：印证按用户输入去重（同一段输入的副本不算独立来源），
  // 所以要测印证加成，第二份会话的用户段必须不完全一样。
  const userText = `${extra}${quote}`;
  const body = `## user\n${userText}\n\n## assistant\n${ASSISTANT_LINE}`;
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
          project_fp: 'local:abcd1234', role: 'user', content: userText,
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
    // 用户输入不同 → 是两次独立的表达 → 算一份印证
    addSession('probe-0002', QUOTE, 'qwenwork', '顺便，');
    index.catchUp();
    const r = score({ content: 'x', evidence: [QUOTE] });
    expect(r.confidence).toBe(0.65);
    expect(r.tags).toEqual([]);
  });

  it('同一段用户输入的副本不算独立印证（还是 0.55）', () => {
    // 同一句话被复制到第二个会话文件（同步两次 / 两个采集器收了同一次对话）：
    // 用户只说过一次，就只有一个来源，不该加分。
    addSession('probe-0002', QUOTE, 'qwenwork');
    index.catchUp();
    const r = score({ content: 'x', evidence: [QUOTE] });
    expect(r.confidence).toBe(0.55);
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

  it('user 段内嵌 ## 小节标题后，深处原文仍可锚定（workbuddy 富文本场景）', () => {
    const deepQuote = '老板要求每小时填时报这件事像一面镜子';
    const body = [
      '## user',
      'Write a dream diary entry from these memory fragments:',
      '',
      '## 核心洞察',
      'AI 提效像一阵风，只覆盖编码那 20%。',
      '',
      '## 八、结语',
      deepQuote,
      '',
      '## assistant',
      ASSISTANT_LINE,
    ].join('\n');
    writeSessionFile(
      home,
      {
        session_id: 'embed-0001', agent: 'workbuddy', project_fp: 'local:abcd1234',
        started_ts: '2026-10-27T00:00:00.000Z', ended_ts: '2026-10-27T00:10:00.000Z',
        cwd: 'X:/x',
        messages: [{
          session_id: 'embed-0001', agent: 'workbuddy', ts: '2026-10-27T00:00:00.000Z',
          project_fp: 'local:abcd1234', role: 'user', content: deepQuote,
        }],
      },
      body,
      'hash-embed-0001',
    );
    index.catchUp();
    const r = score({ content: 'x', sessionId: 'embed-0001', evidence: [deepQuote] });
    expect(r.confidence).toBe(0.55);
    expect(r.tags).toEqual([]);
    expect(r.anchors?.matched).toHaveLength(1);
  });
});

describe('score ladder: M1 五档固化', () => {
  it('档位常量与文档一致（0.35 / 0.55 / 0.80 / 0.90）', () => {
    expect(SCORE_UNGROUNDED).toBe(0.35);
    expect(SCORE_GROUNDED).toBe(0.55);
    expect(SCORE_AUTO_CAP).toBe(0.8);
    expect(SCORE_CONFIRMED).toBe(0.9);
    // core 与 process 各有一份同值常量（避免循环依赖），必须一致。
    expect(REVIEW_CAP).toBe(SCORE_CONFIRMED);
  });

  it('第 1 档 未锚定 = 0.35', () => {
    const r = score({ content: 'x', sessionId: 'probe-0001', evidence: [ASSISTANT_LINE] });
    expect(r.confidence).toBe(SCORE_UNGROUNDED);
  });

  it('第 2 档 已锚定 = 0.55', () => {
    const r = score({ content: 'x', sessionId: 'probe-0001', evidence: [QUOTE] });
    expect(r.confidence).toBe(SCORE_GROUNDED);
  });

  it('第 3 档 印证加成：多一份独立会话就往上加', () => {
    addSession('probe-0002', QUOTE, 'qwenwork', '顺便，');
    index.catchUp();
    const r = score({ content: 'x', sessionId: 'probe-0001', evidence: [QUOTE] });
    expect(r.confidence).toBeGreaterThan(SCORE_GROUNDED);
    expect(r.confidence).toBeLessThanOrEqual(SCORE_AUTO_CAP);
  });

  it('第 4 档 自动上限 = 0.80（再多印证也不越过）', () => {
    for (const [i, agent] of ['qwenwork', 'cursor', 'deepseek', 'doubao'].entries()) {
      addSession(`probe-1${i}0`, QUOTE, agent, `第${i}次，`);
    }
    index.catchUp();
    const r = score({ content: 'x', sessionId: 'probe-0001', evidence: [QUOTE] });
    expect(r.confidence).toBeLessThanOrEqual(SCORE_AUTO_CAP);
    expect(r.confidence).toBeGreaterThan(0.75);
  });

  it('第 5 档 人工过目 = 0.90（只有 review 能到）', async () => {
    const { reconfirm } = await import('../../src/core/lifecycle.js');
    const { commitEntry } = await import('../../src/core/commit.js');
    const { defaultConfig } = await import('../../src/core/config.js');
    const r = commitEntry(home, defaultConfig(), index, {
      content: '人工过目的活文档',
      type: 'fact',
      topic: 'review-cap',
      source: 'agent',
      confidence: 0.55,
      overCap: 'reject',
    });
    expect(r.status).toBe('written');
    reconfirm(home, index, 'review-cap');
    const loc = index.getByTopic('review-cap')!;
    expect(loc.confidence).toBe(SCORE_CONFIRMED);
    expect(loc.confirmations).toBe(1);
  });
});
