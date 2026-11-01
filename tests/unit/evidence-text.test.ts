// grounding 证据域（beta.9 / T03 / P0-2）：元数据围栏不得充当证据，且 user_hash 不受影响。
//
// 本文件钉三件事，缺一件都会静默回归：
//   ① `evidenceUserText` 剥段首元数据围栏 → N1 用例从 0.55 翻成 0.35；
//   ② `userSectionText` **逐字未变**（它是 `sessionUserHash` 的输入，改它 = 全体 user_hash 漂移，
//      且 `process/guide.ts` 优先用落盘旧值 → 新旧两套指纹并行且无任何报错）；
//   ③ 真人原话（含围栏之后的正文、含全角标点）不因剥离而掉分（0355873 钉的用例不许回退）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { defaultConfig } from '../../src/core/config.js';
import { findByTopic } from '../../src/core/store.js';
import { evidenceUserText, sessionUserHash, userSectionText, writeSessionFile } from '../../src/collect/session-store.js';
import { searchSessions } from '../../src/core/search.js';
import { handleTool } from '../../src/mcp/tools.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  try { index.close(); } catch { /* 个别用例已关闭 */ }
  cleanupHome(home);
});

const QUOTE = '2026年4月份有什么新车上市发布吗';
const METADATA_JSON = '{ "message_id": "openclaw-weixin:1775663373554-8ba9b44e", "timestamp": "Wed 2026-04-08 23:49 GMT+8" }';

/** 真实 workbuddy / claude 会话的 ## user 段形状（QA E2 的夹具同构）。 */
const FENCED_BODY = [
  '## user',
  'Conversation info (untrusted metadata):',
  '```json',
  METADATA_JSON,
  '```',
  '',
  QUOTE,
  '',
  '## assistant',
  '好的，已记录：传祺M8 2.0T，落地16.8万，三年免息。',
].join('\n');

function addSession(sessionId: string, body: string): void {
  writeSessionFile(home, {
    session_id: sessionId,
    agent: 'workbuddy',
    project_fp: 'local:aaa',
    started_ts: '2026-10-28T00:00:00.000Z',
    ended_ts: '2026-10-28T00:10:00.000Z',
    cwd: 'X:/x',
    messages: [{
      session_id: sessionId, agent: 'workbuddy', ts: '2026-10-28T00:00:00.000Z',
      project_fp: 'local:aaa', role: 'user', content: QUOTE,
    }],
  }, body, `hash-${sessionId}`);
  index.catchUp();
}

async function save(content: string, sessionId: string, evidence: string) {
  const r = await handleTool('save_memory', { content, session_id: sessionId, evidence }, {
    home, config: defaultConfig(), index,
  });
  return { text: r.content.map((c) => c.text).join('\n'), sc: r.structuredContent as Record<string, any> };
}

describe('evidenceUserText: 只剥段首元数据围栏', () => {
  it('剥掉围栏后只剩用户原话', () => {
    expect(evidenceUserText(FENCED_BODY)).toBe(QUOTE);
    expect(evidenceUserText(FENCED_BODY)).not.toContain('Conversation info');
    expect(evidenceUserText(FENCED_BODY)).not.toContain('message_id');
  });

  it('与 userSectionText 在同一份带围栏样本上**必须不同**（否则等于没剥）', () => {
    expect(userSectionText(FENCED_BODY)).not.toBe(evidenceUserText(FENCED_BODY));
    expect(userSectionText(FENCED_BODY)).toContain('Conversation info (untrusted metadata):');
  });

  it('userSectionText 的输出逐字未变（钉住改动前的值，防 user_hash 静默漂移）', () => {
    expect(userSectionText(FENCED_BODY)).toBe(
      'Conversation info (untrusted metadata):\n```json\n'
      + '{ "message_id": "openclaw-weixin:1775663373554-8ba9b44e", "timestamp": "Wed 2026-04-08 23:49 GMT+8" }\n'
      + '```\n\n2026年4月份有什么新车上市发布吗',
    );
  });

  it('sessionUserHash 的指纹值逐字未变（T03 只剥证据域，不重算 hash）', () => {
    expect(sessionUserHash(FENCED_BODY)).toBe('b1d2e9ede968b3b9');
  });

  it('围栏后面**有真人话**时不能连带剥掉（剥离规则写宽的护栏）', () => {
    const withTail = [
      '## user',
      'Sender (untrusted metadata):',
      '```json',
      '{ "name": "wei" }',
      '```',
      '',
      QUOTE,
      '顺便问一下保养周期',
    ].join('\n');
    expect(evidenceUserText(withTail)).toBe(`${QUOTE}\n顺便问一下保养周期`);
  });

  it('段首不是围栏时原样保留（用户自己粘贴的 JSON 是用户的话）', () => {
    const userJson = ['## user', '这段日志里 message_id 是 openclaw-weixin:1775663373554，帮我看看'].join('\n');
    expect(evidenceUserText(userJson)).toBe('这段日志里 message_id 是 openclaw-weixin:1775663373554，帮我看看');
  });

  it('围栏未闭合（文件被截断）→ 该段视为纯元数据，不产出证据', () => {
    const unclosed = ['## user', 'Conversation info (untrusted metadata):', '```json', METADATA_JSON].join('\n');
    expect(evidenceUserText(unclosed)).toBe('');
  });
});

describe('N1 回归：元数据围栏不能当证据', () => {
  it('把 ## user 段里的 metadata JSON 当 evidence → 0.35 ungrounded（原文实测 0.55）', async () => {
    addSession('n1-alpha', FENCED_BODY);
    const { text, sc } = await save('新车上市信息汇总 n1-marker', 'n1-alpha', METADATA_JSON);
    expect(sc.confidence).toBe(0.35);
    expect(sc.tags).toContain('ungrounded');
    expect(text).toContain('Evidence did not match any ## user section');
    // 回执与落盘一致（0355873 的护栏）
    expect(findByTopic(home, sc.id)!.entry.fm.confidence).toBe(0.35);
  });

  it('只引 message_id 的单键片段也拿不到 grounding', async () => {
    addSession('n1-beta', FENCED_BODY);
    const { sc } = await save('单键片段证据 n1-beta-marker', 'n1-beta', '"message_id": "openclaw-weixin:1775663373554-8ba9b44e"');
    expect(sc.confidence).toBe(0.35);
    expect(sc.tags).toContain('ungrounded');
  });

  it('## assistant 段仍 0.35（8a7d54b 的行为不回退）', async () => {
    addSession('n1-gamma', FENCED_BODY);
    const { sc } = await save('助手原话不能当证据 n1-gamma-marker', 'n1-gamma', '好的，已记录：传祺M8 2.0T，落地16.8万，三年免息。');
    expect(sc.confidence).toBe(0.35);
    expect(sc.tags).toContain('ungrounded');
  });

  it('正常用户原话仍 0.55（剥离不能误伤真话）', async () => {
    addSession('n1-delta', FENCED_BODY);
    const { text, sc } = await save('用户原话仍可锚定 n1-delta-marker', 'n1-delta', QUOTE);
    expect(sc.confidence).toBe(0.55);
    expect(sc.tags).not.toContain('ungrounded');
    expect(text).toContain('Grounded 1/1');
    expect(findByTopic(home, sc.id)!.entry.fm.confidence).toBe(0.55);
  });
});

describe('sessions snippet 同源：摘录只从 ## user 取（QA A3）', () => {
  it('命中在 assistant 段时不给假引文', () => {
    addSession('snip-1', FENCED_BODY);
    const hits = searchSessions(index, '传祺M8', 3);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toBe('');
  });

  it('命中在 ## user 段时给的是剥净后的原话', () => {
    addSession('snip-2', FENCED_BODY);
    const hits = searchSessions(index, '新车上市', 3);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain(QUOTE);
    expect(hits[0].snippet).not.toContain('Conversation info');
  });
});


// ── P0-2（beta.9.1）：围栏不必在段首，整段任意位置的元数据块都要剥掉 ──
describe('P0-2：段中围栏也会被剥（真实仓 22 个非段首围栏）', () => {
  const SYSTEM_LINE = 'System: [2026-04-08 23:49 GMT+8] Exec completed (rapid-fox, code 0) :: build ok';
  /** 真实形状：段首是 System 行，元数据围栏在段中间，真人话在最后。 */
  const MID_FENCED = [
    '## user',
    SYSTEM_LINE,
    '',
    'Conversation info (untrusted metadata):',
    '```json',
    METADATA_JSON,
    '```',
    '',
    '这台车落地价大概多少钱呢',
  ].join('\n');

  it('段中围栏剥掉，两侧真人话都保留', () => {
    const text = evidenceUserText(MID_FENCED);
    expect(text).toContain(SYSTEM_LINE);
    expect(text).toContain('这台车落地价大概多少钱呢');
    expect(text).not.toContain('Conversation info');
    expect(text).not.toContain('message_id');
    expect(text).not.toContain('untrusted metadata');
  });

  it('段中围栏的 JSON 当 evidence → 0.35（上一版这里仍是 0.55）', async () => {
    addSession('p02-mid', MID_FENCED);
    const { text, sc } = await save('段中围栏不能当证据 p02-mid-marker', 'p02-mid', METADATA_JSON);
    expect(sc.confidence).toBe(0.35);
    expect(sc.tags).toContain('ungrounded');
    expect(text).toContain('Evidence did not match any ## user section');
  });

  it('段中围栏之后的真人话仍能锚定 0.55（不误伤）', async () => {
    addSession('p02-mid-ok', MID_FENCED);
    const { sc } = await save('段中围栏之后的真话仍可锚定 p02-ok-marker', 'p02-mid-ok', '这台车落地价大概多少钱呢');
    expect(sc.confidence).toBe(0.55);
    expect(sc.tags).not.toContain('ungrounded');
  });

  it('没有标记行、但围栏里是纯元数据 JSON → 也剥', () => {
    const noMarker = ['## user', '```json', METADATA_JSON, '```', '', '这条才是用户说的'].join('\n');
    const text = evidenceUserText(noMarker);
    expect(text).toBe('这条才是用户说的');
    expect(text).not.toContain('untrusted metadata');
  });

  it('用户自己粘的代码/JSON 一律保留（键不在元数据白名单，或有自由文本字段）', () => {
    const userCode = ['## user', '```json', '{ "topic": "车", "budget": 200000, "note": "想要七座" }', '```', '按上面这个存一下'].join('\n');
    const text = evidenceUserText(userCode);
    expect(text).toContain('"budget": 200000');
    expect(text).toContain('按上面这个存一下');

    const userCode2 = ['## user', '```bash', 'git log --oneline -5', '```'].join('\n');
    expect(evidenceUserText(userCode2)).toContain('git log --oneline -5');

    // 只有通用键（没有 message_id/timestamp/sender 这类强键）→ 保留
    const genericJson = ['## user', '```json', '{ "id": 1, "name": "wei" }', '```'].join('\n');
    expect(evidenceUserText(genericJson)).toContain('"name": "wei"');
  });
});

describe('P0-2：session_id 通道与 evidence 用同一实现，逐段不得留 metadata 字样', () => {
  const MID = [
    '## user',
    'System: [2026-04-08 23:49 GMT+8] Exec completed (rapid-fox, code 0) :: build ok',
    '',
    'Conversation info (untrusted metadata):',
    '```json',
    METADATA_JSON,
    '```',
    '',
    '那第二排座椅能放平吗',
  ].join('\n');

  it('19 段式的逐段断言：任何一段都不含 untrusted metadata / Conversation info', async () => {
    writeSessionFile(home, {
      session_id: 'p02-segments',
      agent: 'workbuddy', project_fp: 'local:aaa',
      started_ts: '2026-10-28T00:00:00.000Z', ended_ts: '2026-10-28T00:10:00.000Z', cwd: 'X:/x',
      messages: [{ session_id: 'p02-segments', agent: 'workbuddy', ts: '2026-10-28T00:00:00.000Z', project_fp: 'local:aaa', role: 'user', content: 'x' }],
    }, MID, 'hash-p02');
    index.catchUp();

    const r = await handleTool('search_memory', { session_id: 'p02-segments' }, { home, config: defaultConfig(), index });
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.segments.length).toBeGreaterThan(0);
    for (const seg of sc.segments) {
      expect(seg.text).not.toContain('untrusted metadata');
      expect(seg.text).not.toContain('Conversation info');
      expect(seg.text).not.toContain('message_id');
    }
  });

  it('段中围栏会把一段裂成两个区间，且每段 chars 仍能切回原文', async () => {
    writeSessionFile(home, {
      session_id: 'p02-split',
      agent: 'workbuddy', project_fp: 'local:aaa',
      started_ts: '2026-10-28T00:00:00.000Z', ended_ts: '2026-10-28T00:10:00.000Z', cwd: 'X:/x',
      messages: [{ session_id: 'p02-split', agent: 'workbuddy', ts: '2026-10-28T00:00:00.000Z', project_fp: 'local:aaa', role: 'user', content: 'x' }],
    }, MID, 'hash-p02b');
    index.catchUp();

    const r = await handleTool('search_memory', { session_id: 'p02-split' }, { home, config: defaultConfig(), index });
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.segments).toHaveLength(2);
    const chars = [...MID];
    for (const seg of sc.segments) {
      const [start, end] = seg.chars as [number, number];
      expect(chars.slice(start, end).join('')).toBe(seg.text);
    }
  });

  it('剥离前后的输出里不含 untrusted metadata（逐段硬断言，替代「成功率下降 ≤5%」）', () => {
    const samples = [MID, FENCED_BODY];
    for (const sample of samples) {
      const out = evidenceUserText(sample);
      expect(out).not.toContain('untrusted metadata');
      expect(out).not.toContain('Conversation info');
      expect(out).not.toContain('message_id');
    }
  });
});
