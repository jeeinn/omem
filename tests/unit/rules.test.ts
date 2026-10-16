// 规则抽取测试（规格 §9.4 档 0：默认零配置，verified:false 候选）。
import { describe, it, expect } from 'vitest';
import { extractCandidates, extractFromDigest, inferDomain } from '../../src/process/rules.js';
import type { UnifiedMessage } from '../../src/collect/types.js';

function userMsg(content: string, overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    session_id: 's1',
    agent: 'claude-code',
    ts: '2026-10-10T09:00:00.000Z',
    project_fp: 'fp1',
    role: 'user',
    content,
    msg_uuid: 'u' + Math.random(),
    ...overrides,
  };
}

describe('rules: tier-0 rule extraction', () => {
  it('preference-positive does not slice 别 out of a longer word', () => {
    const pos = extractCandidates(userMsg('以后都用手写 SQL，不要用 ORM'));
    expect(pos.some((c) => c.type === 'preference' && c.content.includes('用手写 SQL'))).toBe(true);
    const cut = extractCandidates(userMsg('请分别提交即可，别把密钥写进仓库'));
    expect(cut.some((c) => c.content.startsWith('别'))).toBe(false);
  });

  it('decision / correction / lesson / warning', () => {
    expect(extractCandidates(userMsg('我决定把连接池改成 20'))[0].type).toBe('decision');
    expect(extractCandidates(userMsg('把构建工具换成 pnpm'))[0].type).toBe('decision');
    expect(extractCandidates(userMsg('踩坑记录：镜像拉取超时，改用国内源'))[0].type).toBe('experience');
    expect(extractCandidates(userMsg('注意这个端口别暴露到公网'))[0].type).toBe('fact');
  });

  it('English rules', () => {
    const c = extractCandidates(userMsg('I decided to use bun instead of npm'));
    expect(c.some((x) => x.type === 'decision')).toBe(true);
    const p = extractCandidates(userMsg("We'll always use TypeScript for MCP servers"));
    expect(p.some((x) => x.type === 'preference')).toBe(true);
  });

  it('imperative tone halves confidence + low-weight tag (first line of anti-poisoning defense)', () => {
    const c = extractCandidates(userMsg('以后必须在提交前运行全部测试'));
    expect(c).toHaveLength(1);
    expect(c[0].confidence).toBeCloseTo(0.2); // 0.4 * 0.5
    expect(c[0].tags).toContain('low-weight');
  });

  it('too-short matches discarded (<6 chars is not a memory)', () => {
    expect(extractCandidates(userMsg('我决定了'))).toHaveLength(0);
  });

  it('multi-rule hits in one message deduped by content, keeping the highest confidence', () => {
    const c = extractCandidates(userMsg('我决定把数据库连接池改成 20，因为默认 10 会超时，所以调大'));
    const keys = c.map((x) => x.content);
    expect(new Set(keys).size).toBe(keys.length);
    expect(c.some((x) => x.type === 'decision')).toBe(true);
    expect(c.some((x) => x.type === 'experience')).toBe(true);
  });

  it('extracts from user messages only; assistant messages skipped', () => {
    const digest = {
      session_id: 's1',
      project_fp: 'fp1',
      messages: [
        userMsg('我决定用手写 SQL'),
        { ...userMsg('我建议以后都用 ORM'), role: 'assistant' as const },
      ],
    };
    const c = extractFromDigest(digest);
    expect(c).toHaveLength(1);
    expect(c[0].content).toContain('手写 SQL');
  });

  it('same-session corroboration +0.1 (capped at 0.6)', () => {
    const digest = {
      session_id: 's1',
      project_fp: 'fp1',
      messages: [userMsg('我决定统一用 pnpm 管理依赖'), userMsg('另外我决定统一用 pnpm 管理依赖')],
    };
    const c = extractFromDigest(digest);
    const matched = c.filter((x) => x.content.includes('pnpm'));
    expect(matched.length).toBeGreaterThan(0);
    // 印证后置信度应高于单条 base 0.45
    expect(Math.max(...matched.map((x) => x.confidence))).toBeCloseTo(0.55);
  });

  it('domain inference', () => {
    expect(inferDomain('部署 docker 容器时端口映射')).toBe('coding');
    expect(inferDomain('周末想去公园跑步')).toBe('general');
  });

  it('candidates carry session_id and project_fp', () => {
    const c = extractCandidates(userMsg('我决定用手写 SQL', { session_id: 'sess-x', project_fp: 'fp-z' }));
    expect(c[0].session_id).toBe('sess-x');
    expect(c[0].project_fp).toBe('fp-z');
    expect(c[0].source).toBe('rules');
  });
});
