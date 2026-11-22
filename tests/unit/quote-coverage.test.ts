// T1 引文覆盖率：严格逐字谓词、层选择、零引文单列、范围跳过、退出语义。
// 隔离 OMEM_HOME；不读真实 ~/.omem；只报告不改写。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { verifyQuoteCoverage } from '../../src/process/score.js';
import { quoteCoverageNotice } from '../../src/commands/verify.js';
import { newFrontmatter, serializeEntry } from '../../src/core/entry.js';
import { dirs } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function session(agent: string, id: string, userText: string): void {
  const dir = join(dirs.sessions(home), agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), [
    '---', `agent: ${agent}`, `session_id: ${id}`, 'project: eval',
    'started: 2026-11-22T00:00:00.000Z', 'ended: 2026-11-22T00:00:00.000Z',
    'messages: 1', `content_hash: ${id}`, '---', '',
    `## user\n${userText}\n## assistant\nThe answer must never count as evidence.\n`,
  ].join('\n'), 'utf8');
}

function entry(topic: string, opts: {
  evidence_current?: string[];
  evidence?: string[];
  session_id?: string;
  source?: string;
  status?: string;
  confirmations?: number;
} = {}): void {
  const fm = newFrontmatter({ topic, type: 'fact', domain: 'general' });
  fm.source = (opts.source ?? 'agent') as typeof fm.source;
  fm.status = (opts.status ?? 'active') as typeof fm.status;
  fm.confirmations = opts.confirmations ?? 0;
  fm.session_id = opts.session_id ?? '';
  if (opts.evidence) fm.evidence = opts.evidence;
  if (opts.evidence_current !== undefined) fm.evidence_current = opts.evidence_current;
  const text = serializeEntry({ fm, body: `body of ${topic}` });
  const dir = join(dirs.knowledge(home), 'general');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${topic}.md`), text, 'utf8');
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('T1: strict verbatim quote coverage', () => {
  it('A: exact substring matches; punctuation/case/fabricated differences do not', () => {
    session('claude-code', 's1', '连接池上限设为 20，超过就排队');
    session('cursor', 's2', 'The pool limit is twenty');
    entry('exact', { session_id: 's1', evidence_current: ['连接池上限设为 20，超过就排队'] });
    entry('punct', { session_id: 's1', evidence_current: ['连接池上限设为 20，超过就排队。'] });
    entry('case', { session_id: 's2', evidence_current: ['the pool limit is twenty'] });
    entry('fabricated', { session_id: 's1', evidence_current: ['从来没说过的一句话'] });
    index.rebuild();
    const r = verifyQuoteCoverage(home, index);
    expect(r.quotes).toBe(4);
    expect(r.matched).toBe(1);
    expect(r.misses.map((m) => m.topic).sort()).toEqual(['case', 'fabricated', 'punct']);
    expect(r.misses.every((m) => m.reason === 'not-in-user-text')).toBe(true);
  });

  it('A: assistant text is never evidence, even when it contains the quote', () => {
    session('claude-code', 's1', '用户说的是甲');
    entry('assistant-only', { session_id: 's1', evidence_current: ['The answer must never count as evidence.'] });
    index.rebuild();
    expect(verifyQuoteCoverage(home, index).matched).toBe(0);
  });

  it('A: a quote in another session still counts (full-library scan)', () => {
    session('claude-code', 's1', '无关内容');
    session('cursor', 's2', '跨会话的原文证据');
    entry('cross', { session_id: 's1', evidence_current: ['跨会话的原文证据'] });
    index.rebuild();
    expect(verifyQuoteCoverage(home, index).matched).toBe(1);
  });

  it('B: evidence_current wins when present; [] means zero-quote and history does not backfill', () => {
    session('claude-code', 's1', '历史引文在这里');
    entry('current-empty', { session_id: 's1', evidence_current: [], evidence: ['历史引文在这里'] });
    index.rebuild();
    const r = verifyQuoteCoverage(home, index);
    expect(r.noQuote).toBe(1);
    expect(r.quotes).toBe(0);
    expect(r.ratio).toBeNull();
    expect(r.misses).toEqual([]);
  });

  it('B: legacy file without evidence_current scores from evidence', () => {
    session('claude-code', 's1', '历史引文在这里');
    entry('legacy', { session_id: 's1', evidence: ['历史引文在这里'] });
    index.rebuild();
    const r = verifyQuoteCoverage(home, index);
    expect(r.quotes).toBe(1);
    expect(r.matched).toBe(1);
  });

  it('C: zero-quote entries never fabricate 100% and stay visible in the report', () => {
    session('claude-code', 's1', '有引文的原文');
    entry('with', { session_id: 's1', evidence_current: ['有引文的原文'] });
    entry('without', { session_id: 's1', evidence_current: [] });
    index.rebuild();
    const r = verifyQuoteCoverage(home, index);
    // 零引文条目不进分母：1 命中 / 1 条引文 = 100%，zero-quote 只是单列可观测。
    expect(r.ratio).toBe(1);
    expect(r.noQuote).toBe(1);
    const report = quoteCoverageNotice(r).join('\n');
    expect(report).toContain('zero-quote 1');
    expect(report).toContain('1/1');
  });

  it('C: all-zero-quote corpus reports ratio n/a instead of 100%', () => {
    session('claude-code', 's1', '原文');
    entry('only-empty', { session_id: 's1', evidence_current: [] });
    index.rebuild();
    const r = verifyQuoteCoverage(home, index);
    expect(r.ratio).toBeNull();
    expect(quoteCoverageNotice(r).join('\n')).toContain('no quotes to check');
  });

  it('D: stale / manual / reviewed entries are skipped, not failed', () => {
    session('claude-code', 's1', '原文');
    entry('stale', { status: 'stale', session_id: 's1', evidence_current: ['不存在的引文'] });
    entry('manual', { source: 'manual', session_id: 's1', evidence_current: ['不存在的引文'] });
    entry('reviewed', { confirmations: 1, session_id: 's1', evidence_current: ['不存在的引文'] });
    index.rebuild();
    const r = verifyQuoteCoverage(home, index);
    expect(r.skipped).toBe(3);
    expect(r.quotes).toBe(0);
    expect(r.misses).toEqual([]);
  });

  it('E: no sessions at all yields session-not-found, not a silent pass', () => {
    entry('orphan', { session_id: 'missing', evidence_current: ['某条引文'] });
    index.rebuild();
    const r = verifyQuoteCoverage(home, index);
    expect(r.misses).toHaveLength(1);
    expect(r.misses[0].reason).toBe('session-not-found');
  });

  it('F: audit never rewrites the entry or changes confidence', () => {
    session('claude-code', 's1', '原文');
    entry('drift', { session_id: 's1', evidence_current: ['不存在的引文'] });
    index.rebuild();
    const row = index.getByTopic('drift');
    const snapshot = row ? { ...row } : null;
    verifyQuoteCoverage(home, index);
    expect(index.getByTopic('drift')).toEqual(snapshot);
  });
});
