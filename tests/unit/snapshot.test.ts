// 快照测试（规格 §2.1：snapshots/ 滚动保留 7 份）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSnapshot, pruneSnapshots, runSnapshot } from '../../src/core/snapshot.js';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { dirs } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;

beforeEach(() => {
  home = makeHome();
});
afterEach(() => {
  cleanupHome(home);
});

describe('snapshot: daily snapshot', () => {
  it("creates today's snapshot (knowledge + config)", () => {
    writeEntry(home, { fm: newFrontmatter({ id: '2026-10-15-e1', type: 'fact', domain: 'coding' }), body: '内容' });
    const dest = createSnapshot(home);
    expect(dest).toContain(new Date().toISOString().slice(0, 10));
    expect(existsSync(join(dest, 'knowledge'))).toBe(true);
    expect(existsSync(join(dest, 'config.toml'))).toBe(true);
    expect(existsSync(join(dest, 'knowledge', 'coding', '2026', '2026-10-15-e1.md'))).toBe(true);
  });

  it('rolling retention of 7; extras pruned', () => {
    const root = dirs.snapshots(home);
    for (let i = 1; i <= 9; i++) {
      mkdirSync(join(root, `2026-01-${String(i).padStart(2, '0')}`), { recursive: true });
      writeFileSync(join(root, `2026-01-${String(i).padStart(2, '0')}`, 'marker'), 'x');
    }
    const pruned = pruneSnapshots(home, 7);
    expect(pruned).toHaveLength(2);
    expect(readdirSync(root)).toHaveLength(7);
    // 保留的是最新 7 份
    expect(readdirSync(root)).not.toContain('2026-01-01');
    expect(readdirSync(root)).toContain('2026-01-09');
  });

  it('runSnapshot = create + prune', () => {
    writeEntry(home, { fm: newFrontmatter({ id: '2026-10-15-e1', type: 'fact', domain: 'coding' }), body: '内容' });
    const { path, pruned } = runSnapshot(home);
    expect(existsSync(path)).toBe(true);
    expect(pruned).toEqual([]);
  });

  it("re-creating today's snapshot overwrites instead of piling up", () => {
    createSnapshot(home);
    createSnapshot(home);
    const today = new Date().toISOString().slice(0, 10);
    expect(readdirSync(dirs.snapshots(home))).toEqual([today]);
  });
});
