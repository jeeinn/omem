// v0.5.0 S1：只读证据去噪 + 自动化会话打标 + 引文溯源。
// 核心不变量：打标不改任何 frontmatter / confidence / status，不写 skip 台账，不删会话文件。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { evidenceClaims, evidenceUserText } from '../../src/collect/session-store.js';
import { parseEntry } from '../../src/core/entry.js';
import { buildAutomationCorpus, classifySession } from '../../src/process/automation.js';
import { refreshProcessGuide } from '../../src/process/guide.js';
import { verifyQuoteCoverage } from '../../src/process/score.js';
import { quoteCoverageNotice } from '../../src/commands/verify.js';
import { newFrontmatter, serializeEntry } from '../../src/core/entry.js';
import { dirs, files } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

/** 局部 fixture：与 api-docs.test.ts 同格式，ended 决定 index.last_ts，messages 决定 msg_count。 */
function seedSession(id: string, userText: string, ended: string, msgCount = 1, project = 'proj-eval'): void {
  const dir = join(dirs.sessions(home), 'claude-code');
  mkdirSync(dir, { recursive: true });
  const body = `## user\n${userText}\n\n## assistant\n${'执行结果…'.repeat(60)}`;
  writeFileSync(join(dir, `${id}.md`), [
    '---', 'agent: claude-code', `session_id: ${id}`, `project: ${project}`,
    'started: 2026-11-20T09:00:00.000Z', `ended: ${ended}`,
    `messages: ${msgCount}`, `content_hash: hash-${id}`, '---', '', body, '',
  ].join('\n'), 'utf8');
}

function entry(topic: string, evidence: string[], sessionId: string): void {
  const fm = newFrontmatter({ topic, type: 'fact', domain: 'general' });
  fm.source = 'agent' as typeof fm.source;
  fm.session_id = sessionId;
  fm.evidence = [];
  fm.evidence_current = evidence;
  writeFileSync(
    join(dirs.knowledge(home), 'general', `${topic}.md`),
    serializeEntry({ fm, body: `body of ${topic}` }),
    'utf8',
  );
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  mkdirSync(join(dirs.knowledge(home), 'general'), { recursive: true });
});
afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('S1-a: evidenceClaims is read-only denoising, not adjudication', () => {
  it('lists ## user turns, strips metadata fences, marks low-signal shapes', () => {
    const body = [
      '## user', '连接池上限设为 20，超过就排队',
      '## assistant', '好的，已记录。',
      '## user', 'git push origin main',
      '## assistant', '完成。',
      '## user', '这样够吗？',
    ].join('\n');
    const claims = evidenceClaims(body);
    expect(claims.map((c) => c.text)).toEqual(['连接池上限设为 20，超过就排队', 'git push origin main', '这样够吗？']);
    expect(claims[1].lowSignal).toBe('command-block');
    expect(claims[2].lowSignal).toBe('rhetorical');
    expect(claims.every((c) => typeof c.turn === 'number')).toBe(true);
  });

  it('A1: metadata fence in the MIDDLE of a user turn is stripped, plain user JSON is kept', () => {
    const body = [
      '## user', 'System: [ts] 会话开始',
      'Conversation info (untrusted metadata):',
      '```json', '{"message_id":"m-1","timestamp":"2026-11-22T00:00:00Z"}', '```',
      '连接池上限设为 20，超过就排队',
      '```json', '{"pool":20,"note":"用户自己粘的配置"}', '```',
      '## assistant', '好的。',
    ].join('\n');
    const claims = evidenceClaims(body);
    const joined = claims.map((c) => c.text).join('\n');
    // 元数据围栏 + 标记行被剥；用户自己的 JSON 不是会话元数据，必须留在证据域。
    expect(joined).not.toContain('message_id');
    expect(joined).not.toContain('Conversation info');
    expect(joined).toContain('连接池上限设为 20，超过就排队');
    expect(joined).toContain('用户自己粘的配置');
    // 与证据域文本口径一致（同一把尺子）。
    expect(joined).toBe(evidenceUserText(body));
  });

  it('A1b: empty body / assistant-only / short sentence / repeated turns do not throw', () => {
    expect(evidenceClaims('')).toEqual([]);
    expect(evidenceClaims('## assistant\n只有助手在说话')).toEqual([]);
    const short = evidenceClaims('## user\n好的');
    expect(short[0].lowSignal).toBe('short');
    const repeated = evidenceClaims('## user\n同一句话\n## user\n同一句话');
    expect(repeated).toHaveLength(1);
  });

  it('assistant text never becomes a claim; repeated user turns keep only the first', () => {
    const body = [
      '## user', '同一句话重复两次', '## assistant', '助手自述不能算证据',
      '## user', '同一句话重复两次',
    ].join('\n');
    const claims = evidenceClaims(body);
    expect(claims).toHaveLength(1);
    expect(claims[0].text).toBe('同一句话重复两次');
    expect(JSON.stringify(claims)).not.toContain('助手自述');
  });
});

describe('S1-b: classifySession needs >=2 signals with a strong one', () => {
  const AUTOMATION_BODY = '## user\n每日定时任务：抓取热点新闻并发送邮件\n## assistant\n' + '执行结果…'.repeat(200);
  const HUMAN_BODY = '## user\n我决定把 Redis 连接池上限设为 20，超过就排队，这是生产事故的结论\n## assistant\n' + '分析过程…'.repeat(200);

  it('a single weak signal never marks (low user ratio is normal)', () => {
    const corpus = buildAutomationCorpus([{ body: HUMAN_BODY }]);
    const v = classifySession(40, HUMAN_BODY, corpus);
    expect(v.signals.length).toBeGreaterThan(0);
    expect(v.likelyAutomation).toBe(false);
  });

  it('two weak signals (ratio + routine phrase) still never mark', () => {
    const body = '## user\n写日记：记录今天的事\n## assistant\n' + '…'.repeat(400);
    const corpus = buildAutomationCorpus([{ body }]);
    const v = classifySession(3, body, corpus);
    expect(v.signals.length).toBeGreaterThanOrEqual(2);
    expect(v.signals.every((s) => !s.startsWith('recurring-key=') && !s.startsWith('flat-user-text='))).toBe(true);
    expect(v.likelyAutomation).toBe(false);
  });

  it('fixed fixture, two-way: automation prompt is marked, human substantive statement is not', () => {
    const times = [
      '2026-11-20T09:00:00.000Z', '2026-11-21T09:00:00.000Z', '2026-11-22T09:00:00.000Z',
    ];
    const autoItems = times.map((started) => ({ body: AUTOMATION_BODY, started }));
    const corpus = buildAutomationCorpus([...autoItems, { body: HUMAN_BODY, started: times[0] }]);
    expect(classifySession(20, AUTOMATION_BODY, corpus).likelyAutomation).toBe(true);
    expect(classifySession(40, HUMAN_BODY, corpus).likelyAutomation).toBe(false);
  });
});

describe('S1-b: PROCESS.md marking is strictly read-only', () => {
  it('renders (likely-automation) with signals but changes no file fields or skip ledger', () => {
    const body = '## user\n每日定时任务：抓取热点新闻并发送邮件\n## assistant\n' + '执行…'.repeat(300);
    const times = [
      '2026-11-20T09:00:00.000Z', '2026-11-21T09:00:00.000Z', '2026-11-22T09:00:00.000Z',
    ];
    times.forEach((ts, i) => seedSession(`auto-${i}`, '每日定时任务：抓取热点新闻并发送邮件', ts, 20));
    index.catchUp();
    const docPath = join(dirs.knowledge(home), 'general', 'human-fact.md');
    writeFileSync(docPath, serializeEntry({
      fm: { ...newFrontmatter({ topic: 'human-fact', type: 'fact', domain: 'general' }), source: 'agent' as never },
      body: 'unchanged body',
    }), 'utf8');
    const docBefore = readFileSync(docPath, 'utf8');
    const skipLedger = files.skipLedger(home);
    const skipBefore = existsSync(skipLedger) ? readFileSync(skipLedger, 'utf8') : null;

    const guide = refreshProcessGuide(home, index);
    const text = readFileSync(guide, 'utf8');
    expect(text).toContain('likely-automation');
    // 逐字段不变：文档未被重写、skip 台账未被创建/改写。
    expect(readFileSync(docPath, 'utf8')).toBe(docBefore);
    expect(existsSync(skipLedger) ? readFileSync(skipLedger, 'utf8') : null).toBe(skipBefore);
    // 判定依据只写 logs（只读可观测）。
    const log = existsSync(files.usageLog(home)) ? readFileSync(files.usageLog(home), 'utf8') : '';
    expect(log).toContain('automation-mark');
    // A2：判定依据不落用户原文全文，只含 count / session id / signals。
    expect(log).not.toContain('每日定时任务：抓取热点新闻并发送邮件');

    // A2：字段级逐项比对（比整篇字节相等更能说明「没有改 frontmatter」）。
    const fmBefore = parseEntry(docBefore)?.fm;
    const fmAfter = parseEntry(readFileSync(docPath, 'utf8'))?.fm;
    expect(fmAfter).toEqual(fmBefore);
    for (const k of ['evidence', 'evidence_current', 'confidence', 'status', 'session_id', 'source_sessions'] as const) {
      expect((fmAfter as Record<string, unknown>)[k]).toEqual((fmBefore as Record<string, unknown>)[k]);
    }
    // 会话文件数与 knowledge/ 都没变，人工 skip 前不移出待办。
    expect(existsSync(files.skipLedger(home))).toBe(false);
    expect(text).toContain('auto-0');
  });
});

describe('S1-c: verify --quotes traces every hit back to its source session', () => {
  it('reports session id + userKey for each matched quote', () => {
    seedSession('src-1', '连接池上限设为 20，超过就排队', '2026-11-22T09:00:00.000Z');
    entry('pool', ['连接池上限设为 20，超过就排队'], 'src-1');
    index.catchUp();
    const r = verifyQuoteCoverage(home, index);
    expect(r.matched).toBe(1);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].sessionId).toBe('src-1');
    expect(r.hits[0].userKey).toMatch(/^[0-9a-f]{16}$/);
    expect(quoteCoverageNotice(r).join('\n')).toContain('session src-1');
  });

  it('A3: zero-quote corpus has hits=[], ratio=null and n/a (never a fake 100%)', () => {
    seedSession('src-z', '原文', '2026-11-22T09:00:00.000Z');
    entry('empty-current', [], 'src-z');
    index.catchUp();
    const r = verifyQuoteCoverage(home, index);
    expect(r.hits).toEqual([]);
    expect(r.quotes).toBe(0);
    expect(r.ratio).toBeNull();
    expect(r.noQuote).toBe(1);
    expect(r.misses).toEqual([]);
    expect(quoteCoverageNotice(r).join('\n')).toContain('no quotes to check');
  });

  it('A3b: all-quote corpus never reports 100% when a quote is missing', () => {
    seedSession('src-m', '真实原文', '2026-11-22T09:00:00.000Z');
    entry('miss', ['不存在的引文'], 'src-m');
    index.catchUp();
    const r = verifyQuoteCoverage(home, index);
    expect(r.hits).toEqual([]);
    expect(r.ratio).toBe(0);
    expect(r.misses).toHaveLength(1);
  });
});
