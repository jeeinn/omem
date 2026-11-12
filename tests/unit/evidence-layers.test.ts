// D1：历史链 evidence 与本次引文 evidence_current 分开计分。
// 缺席字段仍按旧契约复算；字段在场（含空数组）时历史引文不再抬分。verify 只报告。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry, rescoreNotice } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { findByTopic, moveToArchive, updateTopic, writeEntry } from '../../src/core/store.js';
import { newFrontmatter, parseEntry } from '../../src/core/entry.js';
import { reconfirm } from '../../src/core/lifecycle.js';
import { scoreEvidence, verifyConfidence } from '../../src/process/score.js';
import { writeSessionFile } from '../../src/collect/session-store.js';
import { buildReviewDetail } from '../../src/web/review-data.js';
import { renderReviewPage } from '../../src/web/review-page.js';
import { handleTool } from '../../src/mcp/tools.js';
import type { ToolCtx } from '../../src/mcp/tools.js';
import { makeHome, cleanupHome } from './helpers.js';

const QUOTE_A = '以后都用手写 SQL，不要用 ORM 框架';
const QUOTE_B = '连接池上限设为二十，超出的请求排队等待';
const BODY = '这个项目用手写 SQL';

let home: string;
let index: OmemIndex;

function addSession(id: string, user: string): void {
  const body = `## user\n${user}\n\n## assistant\n好的`;
  writeSessionFile(
    home,
    {
      session_id: id,
      agent: 'cursor',
      project_fp: 'local:abcd1234',
      started_ts: '2026-11-01T00:00:00.000Z',
      ended_ts: '2026-11-01T00:10:00.000Z',
      cwd: 'X:/x',
      messages: [
        { session_id: id, agent: 'cursor', ts: '2026-11-01T00:00:00.000Z', project_fp: 'local:abcd1234', role: 'user', content: user },
        { session_id: id, agent: 'cursor', ts: '2026-11-01T00:01:00.000Z', project_fp: 'local:abcd1234', role: 'assistant', content: '好的' },
      ],
    },
    body,
    `hash-${id}`,
  );
}

function score(sessionId: string, evidence: string[]): number {
  return scoreEvidence(home, { content: BODY, sessionId, evidence }, index).confidence;
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('evidence layers', () => {
  it('缺席与空数组往返后仍可区分', () => {
    const absent = parseEntry(['---', 'type: fact', `evidence: ["${QUOTE_A}"]`, '---', '', '正文'].join('\n'));
    expect(absent!.fm.evidence_current).toBeUndefined();
    const empty = parseEntry(['---', 'type: fact', 'evidence_current: []', '---', '', '正文'].join('\n'));
    expect(empty!.fm.evidence_current).toEqual([]);
  });

  it('旧文件缺字段时仍按 evidence 复算', () => {
    addSession('s1', QUOTE_A);
    index.catchUp();
    const confidence = score('s1', [QUOTE_A]);
    const entry = {
      fm: newFrontmatter({
        topic: 'legacy-sql', type: 'fact', domain: 'coding', source: 'agent',
        session_id: 's1', evidence: [QUOTE_A], confidence,
      }),
      body: BODY,
    };
    writeEntry(home, entry);
    index.catchUp();
    expect(findByTopic(home, 'legacy-sql')!.entry.fm.evidence_current).toBeUndefined();
    expect(verifyConfidence(home, index).drifts).toEqual([]);
  });

  it('覆写后只认本次引文，历史链还在但不抬分', () => {
    addSession('s1', QUOTE_A);
    addSession('s2', `我同意：${QUOTE_A}`);
    index.catchUp();
    const first = score('s1', [QUOTE_A]);
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: BODY, type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', evidence: [QUOTE_A], confidence: first,
    });
    addSession('s3', QUOTE_B);
    index.catchUp();
    const second = score('s3', [QUOTE_B]);
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: '连接池超出就排队', type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's3', evidence: [QUOTE_B], confidence: second,
    });
    const fm = findByTopic(home, 'sql-policy')!.entry.fm;
    expect(fm.evidence_current).toEqual([QUOTE_B]);
    expect(fm.evidence).toEqual(expect.arrayContaining([QUOTE_A, QUOTE_B]));
    expect(first).toBeGreaterThan(second);
    expect(verifyConfidence(home, index).drifts).toEqual([]);
  });

  it('没带引文的覆写写成空数组，账本不再用历史引文', () => {
    addSession('s1', QUOTE_A);
    index.catchUp();
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: BODY, type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', evidence: [QUOTE_A], confidence: score('s1', [QUOTE_A]),
    });
    const bare = score('s1', []);
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: '改成另一句结论', type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', confidence: bare,
    });
    const fm = findByTopic(home, 'sql-policy')!.entry.fm;
    expect(fm.evidence_current).toEqual([]);
    expect(fm.evidence).toContain(QUOTE_A);
    expect(bare).toBeLessThan(score('s1', [QUOTE_A]));
    expect(verifyConfidence(home, index).drifts).toEqual([]);
  });

  it('补分后当前层换成这次的引文', () => {
    commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: BODY, type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', evidence: [QUOTE_A], confidence: 0.35,
    });
    addSession('s1', QUOTE_B);
    index.catchUp();
    const again = commitEntry(home, defaultConfig(), index, {
      topic: 'sql-policy', content: BODY, type: 'fact', domain: 'coding',
      source: 'agent', session_id: 's1', evidence: [QUOTE_B], confidence: 0.55,
    });
    expect(again.status).toBe('deduped');
    expect(again.rescored).toMatchObject({ from: 0.35, to: 0.55 });
    const fm = findByTopic(home, 'sql-policy')!.entry.fm;
    expect(fm.evidence_current).toEqual([QUOTE_B]);
    expect(fm.evidence).toEqual(expect.arrayContaining([QUOTE_A, QUOTE_B]));
    expect(verifyConfidence(home, index).drifts).toEqual([]);
    const detail = buildReviewDetail(home, findByTopic(home, 'sql-policy')!, new Map());
    expect(detail.evidence_current).toEqual([QUOTE_B]);
    // 补分把当前层换成这次的引文，回执必须点名这个字段，而不是只列 confidence/evidence。
    expect(rescoreNotice(again.rescored!)).toContain('evidence_current');
    const page = renderReviewPage({ token: 't', items: [], timeoutMs: 1 });
    expect(page).toContain('Current evidence');
    expect(page).toContain('None on this version');
    expect(page).toContain('Historical evidence');
  });

  // 兼容边界：只有 commitEntry 的内容写入会切换契约。审阅、冷却、归档这类
  // 「读 → 改元数据 → 写回」路径必须让旧文件保持字段缺席，否则账本口径会静默改变。
  it('元数据重写旧文件不会把字段缺席升级成空数组', () => {
    writeEntry(home, {
      fm: newFrontmatter({
        topic: 'legacy-review', type: 'fact', domain: 'coding', source: 'agent',
        session_id: 's1', evidence: [QUOTE_A], confidence: 0.55,
      }),
      body: BODY,
    });
    index.catchUp();

    reconfirm(home, index, 'legacy-review');
    updateTopic(home, 'legacy-review', (fm) => { fm.status = 'stale'; });
    moveToArchive(home, 'legacy-review');

    const fm = findByTopic(home, 'legacy-review', { includeArchived: true })!.entry.fm;
    expect(fm.evidence_current).toBeUndefined();
    expect(fm.evidence).toContain(QUOTE_A);
  });

  it('审阅 detail 区分字段缺席与空数组，历史链始终单独给出', () => {
    writeEntry(home, {
      fm: newFrontmatter({
        topic: 'legacy-detail', type: 'fact', domain: 'coding', source: 'agent',
        session_id: 's1', evidence: [QUOTE_A], confidence: 0.55,
      }),
      body: BODY,
    });
    commitEntry(home, defaultConfig(), index, {
      topic: 'current-empty', content: '另一份没有引文的结论', type: 'fact', domain: 'coding',
      source: 'agent', confidence: 0.35,
    });
    index.catchUp();

    const oldDetail = buildReviewDetail(home, findByTopic(home, 'legacy-detail')!, new Map());
    expect(oldDetail.evidence_current).toBeUndefined();
    expect(oldDetail.evidence).toContain(QUOTE_A);

    const newDetail = buildReviewDetail(home, findByTopic(home, 'current-empty')!, new Map());
    expect(newDetail.evidence_current).toEqual([]);
    expect(newDetail.evidence).toEqual([]);
  });

  it('search_memory 只在字段在场时回传 evidence_current', async () => {
    writeEntry(home, {
      fm: newFrontmatter({
        topic: 'legacy-search', type: 'fact', domain: 'coding', source: 'agent',
        session_id: 's1', evidence: [QUOTE_A], confidence: 0.55,
      }),
      body: BODY,
    });
    commitEntry(home, defaultConfig(), index, {
      topic: 'current-search', content: '另一份手写 SQL 的结论', type: 'fact', domain: 'coding',
      source: 'agent', confidence: 0.35,
    });
    index.catchUp();

    const ctx: ToolCtx = { home, config: defaultConfig(), index };
    const r = await handleTool('search_memory', { query: 'SQL' }, ctx);
    const hits = (r.structuredContent as any).hits as Record<string, any>[];
    const oldHit = hits.find((h) => h.topic === 'legacy-search');
    const newHit = hits.find((h) => h.topic === 'current-search');
    expect(oldHit).toBeTruthy();
    expect(newHit).toBeTruthy();
    expect('evidence_current' in oldHit!).toBe(false);
    expect(newHit!.evidence_current).toEqual([]);
  });
});
