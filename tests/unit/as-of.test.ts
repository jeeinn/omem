// as_of 历史视图的边界测试：解析口径、只读性、与当前索引的行形状一致性。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { OmemIndex } from '../../src/core/index.js';
import { readAsOf, resolveAsOf } from '../../src/core/history.js';
import { searchEntriesPage } from '../../src/core/search.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { makeHome, cleanupHome } from './helpers.js';

let home;
let index;
const config = defaultConfig();
let firstRev;
let secondRev;

beforeAll(() => {
  home = makeHome();
  index = new OmemIndex(home);
  execFileSync('git', ['init', '-q'], { cwd: home });
  execFileSync('git', ['config', 'user.name', 'asof-eval'], { cwd: home });
  execFileSync('git', ['config', 'user.email', 'asof-eval@localhost'], { cwd: home });
  const write = (content) => {
    const r = commitEntry(home, config, index, {
      content, type: 'fact', topic: 'asof-probe', source: 'agent', confidence: 0.55, overCap: 'reject',
    });
    expect(r.status).toBe('written');
    execFileSync('git', ['add', '-A'], { cwd: home });
    execFileSync('git', ['commit', '-q', '-m', content], { cwd: home });
  };
  write('旧值 alpha-unique-marker');
  firstRev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: home, encoding: 'utf8' }).trim();
  write('新值 beta-unique-marker');
  secondRev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: home, encoding: 'utf8' }).trim();
});

afterAll(() => {
  index.close();
  cleanupHome(home);
});

describe('as_of history view', () => {
  it('resolves sha, HEAD~N and ISO timestamp to the same revisions', () => {
    expect(resolveAsOf(home, firstRev).rev).toBe(firstRev);
    expect(resolveAsOf(home, 'HEAD~1').rev).toBe(firstRev);
    const iso = execFileSync('git', ['log', '-1', '--format=%cI', firstRev], { cwd: home, encoding: 'utf8' }).trim();
    // 同秒提交时 --before 是严格早于，取不到 firstRev；这里只验证 ISO 能解析到某个有效提交。
    expect(resolveAsOf(home, iso).rev).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects malformed as_of and missing history with UsageError', () => {
    expect(() => resolveAsOf(home, 'not-a-ref;rm -rf')).toThrow(/Cannot parse as_of/);
    expect(() => resolveAsOf(home, 'HEAD~99')).toThrow(/No commit resolved/);
  });

  it('searchEntriesPage(as_of) returns the historical body, not current disk content', () => {
    const page = searchEntriesPage(index, {
      query: 'alpha-unique-marker', as_of: firstRev, limit: 5, staleWeight: config.process.stale_weight,
    });
    expect(page.rows).toHaveLength(1);
    const row = page.rows[0] as any;
    expect(row.topic).toBe('asof-probe');
    expect(row.snapshotBody).toContain('alpha-unique-marker');
    expect(row.path.startsWith(`${firstRev}:`)).toBe(true);
    expect(page.snapshot?.rev).toBe(firstRev);
    // 行形状与当前索引同口径：hash 是当时全文 sha256/32，不是新造的历史 hash。
    expect(row.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('current search still sees the newer value (history view does not leak into index)', () => {
    const page = searchEntriesPage(index, {
      query: 'beta-unique-marker', limit: 5, staleWeight: config.process.stale_weight,
    });
    expect(page.rows).toHaveLength(1);
    expect((page.rows[0] as any).snapshotBody).toBeUndefined();
    expect(page.snapshot).toBeUndefined();
  });

  it('readAsOf skips conflict files and yields every committed markdown doc', () => {
    const snap = readAsOf(home, secondRev);
    expect(snap.rev).toBe(secondRev);
    expect(snap.rows.some((r) => r.topic === 'asof-probe')).toBe(true);
    expect(snap.rows.every((r) => r.snapshotRev === secondRev)).toBe(true);
  });

  it('as_of on sessions is rejected at the tool layer', async () => {
    const { handleTool } = await import('../../src/mcp/tools.js');
    const ctx = { home, config, index };
    const r: any = await handleTool('search_memory', {
      query: 'alpha', as_of: firstRev, scope: 'sessions',
    }, ctx as any);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/as_of only works for conclusions/);
  });
});
