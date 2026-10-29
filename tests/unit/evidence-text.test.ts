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
import { findById } from '../../src/core/store.js';
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
    expect(findById(home, sc.id)!.entry.fm.confidence).toBe(0.35);
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
    expect(findById(home, sc.id)!.entry.fm.confidence).toBe(0.55);
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
