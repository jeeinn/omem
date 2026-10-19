// GitBackend 测试（规格 §5.3）：init / status / push（本地）/ 冲突策略（.conflict.md，本地版保留）。
// 使用本地 bare 仓库作远端，完整走通 pull→push→冲突→解决链路。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitBackend } from '../../src/sync/git.js';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import type { SyncReport } from '../../src/sync/backend.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omem-git-'));
  saveConfig(dir, defaultConfig());
  return dir;
}

function addEntry(home: string, id: string, body: string): void {
  writeEntry(home, { fm: newFrontmatter({ id, type: 'fact', domain: 'coding' }), body });
}

function report(): SyncReport {
  return { backend: 'git', pushed: false, conflicts: [], notes: [] };
}

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasGit)('sync: GitBackend', () => {
  let root: string;
  let bare: string;
  let home1: string;
  let home2: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omem-sync-'));
    bare = join(root, 'remote.git');
    git(['init', '--bare', '-b', 'main', bare], root);
    home1 = makeHome();
    home2 = join(root, 'home2-unused'); // 占位；clone 测试会重建为真实 clone 目录
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('init: creates data repo + repo-level git config + .gitignore excludes index/snapshots/logs', () => {
    new GitBackend(home1, { sync: { git: { remote: '' }, auto_snapshot: true } }).init();
    expect(existsSync(join(home1, '.git'))).toBe(true);
    expect(git(['config', '--get', 'user.name'], home1)).toBe('omem');
    const ignore = readFileSync(join(home1, '.gitignore'), 'utf8');
    expect(ignore).toContain('index/');
    expect(ignore).toContain('snapshots/');
    expect(ignore).toContain('logs/');
  });

  it('push to bare remote (auto_snapshot snapshots first)', () => {
    const b1 = new GitBackend(home1, { sync: { git: { remote: '' }, auto_snapshot: true } });
    b1.init();
    b1.setRemote(bare);
    addEntry(home1, '2026-10-15-e1', '第一条记忆');
    const r = report();
    b1.push(r);
    expect(r.pushed).toBe(true);
    expect(r.notes.some((n) => n.includes('snapshot'))).toBe(true);
    expect(git(['log', '--oneline'], bare)).toContain('omem: sync');
  });

  it('a second machine pulls the source of truth after clone', () => {
    const b1 = new GitBackend(home1, { sync: { git: { remote: '' }, auto_snapshot: false } });
    b1.init();
    b1.setRemote(bare);
    addEntry(home1, '2026-10-15-e1', '跨机器记忆');
    b1.push(report());

    // 新机器 = clone（clone 目标必须不存在或为空）
    home2 = join(root, 'home2');
    git(['clone', bare, home2], root);
    const b2 = new GitBackend(home2, { sync: { git: { remote: bare }, auto_snapshot: false } });
    const r = report();
    b2.pull(r);
    expect(existsSync(join(home2, 'knowledge', 'coding', '2026', '2026-10-15-e1.md'))).toBe(true);
  });

  it('status: gives a note when there is no upstream', () => {
    new GitBackend(home1, { sync: { git: { remote: '' }, auto_snapshot: false } }).init();
    const st = new GitBackend(home1, { sync: { git: { remote: '' }, auto_snapshot: false } }).status();
    expect(st.backend).toBe('git');
    expect(st.available).toBe(true);
    expect(st.remote).toBeNull();
    expect(st.note).toContain('upstream');
  });

  it('conflict: on pull the remote version is saved as .conflict.md, local version kept (spec §5.5)', () => {
    // home1 推送初始条目
    const b1 = new GitBackend(home1, { sync: { git: { remote: '' }, auto_snapshot: false } });
    b1.init();
    b1.setRemote(bare);
    addEntry(home1, '2026-10-15-e1', '初始内容');
    b1.push(report());

    // home2 clone（clone 目标必须不存在或为空）
    home2 = join(root, 'home2');
    git(['clone', bare, home2], root);
    const b2 = new GitBackend(home2, { sync: { git: { remote: bare }, auto_snapshot: false } });

    // home1 改条目并推送（远端版）
    addEntry(home1, '2026-10-15-e1', '远端修改的内容');
    b1.push(report());

    // home2 本地未提交修改（本地版）
    addEntry(home2, '2026-10-15-e1', '本地修改的内容');

    const r = report();
    b2.pull(r);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]).toContain('2026-10-15-e1.md');
    // 本地版保留
    const final = readFileSync(join(home2, 'knowledge', 'coding', '2026', '2026-10-15-e1.md'), 'utf8');
    expect(final).toContain('本地修改的内容');
    // 远端版另存
    const conflict = readFileSync(join(home2, 'knowledge', 'coding', '2026', '2026-10-15-e1.md.conflict.md'), 'utf8');
    expect(conflict).toContain('远端修改的内容');
  });

  it('push with no remote commits locally and notes it (offline scenario)', () => {
    const b = new GitBackend(home1, { sync: { git: { remote: '' }, auto_snapshot: false } });
    b.init();
    addEntry(home1, '2026-10-15-e1', '离线内容');
    const r = report();
    b.push(r);
    expect(r.pushed).toBe(false);
    expect(r.notes.some((n) => n.includes('No remote configured'))).toBe(true);
    const st = b.status();
    expect(st.dirty).toBe(0); // 已本地提交
  });

  it('GitBackend.available()', () => {
    expect(GitBackend.available()).toBe(true);
  });

  it('init on an existing repo does not write another chore: omem init commit (spec §5.3 history must stay readable)', () => {
    const b = new GitBackend(home1, { sync: { git: { remote: '' }, auto_snapshot: false } });
    b.init();
    const afterFirst = git(['rev-list', '--count', 'HEAD'], home1);
    // omem sync 每次都会先 init()；重复调用不得再生出同名提交，否则历史全是 chore: omem init。
    b.init();
    b.init();
    expect(git(['rev-list', '--count', 'HEAD'], home1)).toBe(afterFirst);

    addEntry(home1, '2026-10-15-e1', '第一条记忆');
    b.push(report());
    const msgs = git(['log', '--format=%s'], home1).split('\n');
    expect(msgs.filter((m) => m === 'chore: omem init')).toHaveLength(1);
    expect(msgs[0]).toContain('omem: sync');
  });
});
