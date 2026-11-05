// [collect].exclude_paths 接线验证：配置存在的唯一价值就是真的挡住采集。
// 历史缺陷：config.ts 有定义/解析/序列化，但 scanSessions 从来不读它。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isExcludedPath, scanSessions } from '../../src/collect/collector.js';
import { defaultConfig } from '../../src/core/config.js';
import type { OmemConfig } from '../../src/core/config.js';
import { OmemIndex } from '../../src/core/index.js';
import { makeHome, cleanupHome, isolateAllCollectors } from './helpers.js';

let home: string;
let index: OmemIndex;
let root: string;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  root = mkdtempSync(join(tmpdir(), 'omem-exclude-paths-'));
});

afterEach(() => {
  index.close();
  cleanupHome(home);
  rmSync(root, { recursive: true, force: true });
});

function configWith(excludes: string[]): OmemConfig {
  const config = defaultConfig();
  isolateAllCollectors(config);
  config.collect.claude_projects = root;
  config.collect.exclude_paths = excludes;
  return config;
}

function session(group: string, id: string): void {
  const dir = join(root, group);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `message from ${id}` },
    uuid: `u-${id}`,
    timestamp: '2026-10-10T09:00:00Z',
    sessionId: id,
  });
  writeFileSync(join(dir, `${id}.jsonl`), `${line}\n`);
}

describe('isExcludedPath', () => {
  it('matches the exact file and anything under the excluded directory', () => {
    expect(isExcludedPath('/data/proj/s1.jsonl', ['/data/proj/s1.jsonl'])).toBe(true);
    expect(isExcludedPath('/data/proj/sub/s2.jsonl', ['/data/proj'])).toBe(true);
  });

  it('does not match a sibling whose name merely contains the excluded text', () => {
    expect(isExcludedPath('/data/proj-other/s1.jsonl', ['/data/proj'])).toBe(false);
    expect(isExcludedPath('/data/proj-backup/s1.jsonl', ['/data/proj'])).toBe(false);
  });

  it('expands ~ and normalizes separators', () => {
    const file = join(homedir(), '.claude', 'projects', 'secret', 's1.jsonl');
    expect(isExcludedPath(file, ['~/.claude/projects/secret'])).toBe(true);
    expect(isExcludedPath(file.replace(/\//g, '\\'), ['~/.claude/projects/secret'])).toBe(true);
  });

  it('empty or blank excludes never block anything', () => {
    expect(isExcludedPath('/data/proj/s1.jsonl', [])).toBe(false);
    expect(isExcludedPath('/data/proj/s1.jsonl', ['', '   '])).toBe(false);
  });
});

describe('scanSessions honours exclude_paths', () => {
  it('skips files under an excluded directory and reports the count', () => {
    session('keep', 's1');
    session('secret', 's2');
    const scan = scanSessions(index, configWith([join(root, 'secret')]));
    expect(scan.digests.map((d) => d.session_id)).toEqual(['s1']);
    expect(scan.excludedPaths).toBe(1);
    expect(scan.skipped).toBe(0);
  });

  it('no excludes configured: every file is collected', () => {
    session('keep', 's1');
    session('secret', 's2');
    const scan = scanSessions(index, configWith([]));
    expect(scan.digests.map((d) => d.session_id).sort()).toEqual(['s1', 's2']);
    expect(scan.excludedPaths).toBe(0);
  });

  it('excluding the collector root blocks all of its files', () => {
    session('keep', 's1');
    session('secret', 's2');
    const scan = scanSessions(index, configWith([root]));
    expect(scan.digests).toHaveLength(0);
    expect(scan.excludedPaths).toBe(2);
  });

  it('a single exact file can be excluded without touching its siblings', () => {
    session('keep', 's1');
    session('keep', 's2');
    const scan = scanSessions(index, configWith([join(root, 'keep', 's2.jsonl')]));
    expect(scan.digests.map((d) => d.session_id)).toEqual(['s1']);
    expect(scan.excludedPaths).toBe(1);
  });
});
