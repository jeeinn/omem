// omem sync 的 CLI 层回归：坏味道只存在于 commands/sync.ts 这一层（调两次 init 抢先提交），
// 直接搓 GitBackend 的测试覆盖不到，所以这里必须走 dispatching（omen sync 无子命令 = pull→push）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { makeHome, cleanupHome } from './helpers.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function capture(): string[] {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return out;
}

function addEntry(home: string, id: string, body: string): void {
  writeEntry(home, { fm: newFrontmatter({ id, type: 'fact', domain: 'coding' }), body });
}

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasGit)('cli: omem sync', () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    vi.stubEnv('OMEM_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    cleanupHome(home);
  });

  it('first sync initializes the repo once; the later sync records changes under "omem: sync"', async () => {
    capture();
    await main(['sync']);
    const afterFirst = git(['rev-list', '--count', 'HEAD'], home);
    expect(git(['log', '-1', '--format=%s'], home)).toBe('chore: omem init');

    addEntry(home, '2026-10-15-a1b2c3', 'sync 之后才落盘的记忆');
    const out = capture();
    await main(['sync']);

    // 用户可见谎话：init 抢先提交会让 push() 永远看到干净树，从而打印这一句。
    expect(out.join('\n')).not.toContain('nothing to commit');
    expect(git(['rev-list', '--count', 'HEAD'], home)).toBe(String(Number(afterFirst) + 1));
    const msgs = git(['log', '--format=%s'], home).split('\n');
    expect(msgs[0]).toContain('omem: sync');
    expect(msgs.filter((m) => m === 'chore: omem init')).toHaveLength(1);
  });

  it('omem sync status does not rewrite history', async () => {
    capture();
    await main(['sync']);
    const before = git(['rev-list', '--count', 'HEAD'], home);
    capture();
    expect(await main(['sync', 'status'])).toBe(0);
    expect(git(['rev-list', '--count', 'HEAD'], home)).toBe(before);
  });
});

describe.runIf(hasGit)('cli: omem sync key guard (doc §6.3 D9 / V12)', () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    vi.stubEnv('OMEM_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    cleanupHome(home);
  });

  it('V12: warns about a non-empty [api].key before any git action; exit 0; file untouched', async () => {
    capture();
    await main(['sync']); // 首次建仓

    // 手写 key 进 config.toml（模拟 D5 场景）
    const p = join(home, 'config.toml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('[search]', '[api]\nkey = "sk-will-be-committed"\n\n[search]'));

    const out2 = capture();
    const code = await main(['sync']);
    const text = out2.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('config.toml contains a non-empty [api].key');
    expect(text).toContain('OMEM_API_KEY');
    // 警告先于任何 git 提交输出（capture 顺序即输出顺序；提交的文件里已含 key 是既定行为）
    const keyLine = text.indexOf('non-empty [api].key');
    const syncDone = text.indexOf('sync complete');
    expect(keyLine).toBeGreaterThan(-1);
    expect(keyLine).toBeLessThan(syncDone);
    // 只读不写：config.toml 未被命令改动
    expect(readFileSync(p, 'utf8')).toContain('sk-will-be-committed');
    // 无 key 时不警告
    writeFileSync(p, readFileSync(p, 'utf8').replace('key = "sk-will-be-committed"', 'key = ""'));
    const out3 = capture();
    await main(['sync']);
    expect(out3.join('\n')).not.toContain('non-empty [api].key');
  });
});
