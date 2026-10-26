// init 不扫描；omem sync --collectors 只处理点名的采集器。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { makeHome, cleanupHome, withConfig, isolateAllCollectors } from './helpers.js';

const homes: string[] = [];
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of homes.splice(0)) cleanupHome(d);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sessionMd(home: string): string[] {
  const root = join(home, 'sessions');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.md')) out.push(path);
    }
  };
  walk(root);
  return out;
}

function fixtureRoot(): { root: string; absent: string } {
  const root = join(tmpdir(), `omem-init-col-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  dirs.push(root);
  const claude = join(root, 'claude', 'proj');
  const cursor = join(root, 'cursor', 'p1', 'agent-transcripts', 'cur-1');
  mkdirSync(claude, { recursive: true });
  mkdirSync(cursor, { recursive: true });
  writeFileSync(join(claude, 's1.jsonl'), '{"type":"user","message":{"role":"user","content":"claude 以后都用手写 SQL"},"uuid":"u","timestamp":"2026-10-10T09:00:00Z","sessionId":"s1"}\n');
  writeFileSync(join(cursor, 'cur-1.jsonl'), '{"role":"user","message":{"content":[{"type":"text","text":"cursor 以后都用手写 SQL"}]}}\n');
  return { root, absent: join(root, 'absent') };
}

function pointAt(home: string, root: string, absent: string): void {
  withConfig(home, (c) => {
    // 先把所有采集根隔离掉（注册表驱动），再点名要用的两个。
    // 此前这里只设了 4 个采集器，doubao/deepseek/qoder/catpaw 全部指向
    // 开发者本机的真实目录——这个测试会扫到真实会话。
    isolateAllCollectors(c, absent);
    c.collect.claude_projects = join(root, 'claude');
    c.collect.cursor_projects = join(root, 'cursor');
  });
}

describe('init does not scan sessions', () => {
  it('leaves sessions/ empty when a parsable transcript is configured', async () => {
    const home = makeHome();
    homes.push(home);
    vi.stubEnv('OMEM_HOME', home);
    const { root, absent } = fixtureRoot();
    pointAt(home, root, absent);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    expect(await main(['init'])).toBe(0);
    expect(await main(['init', '--no-scan'])).toBe(0);
    expect(sessionMd(home)).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('omem sync');
    expect(text).toContain('omem sync --collectors cursor,qwenwork');
    expect(text).not.toContain('Initial scan');
    expect(text).not.toContain('Skipping initial session scan');
  });
});

describe('sync --collectors', () => {
  it('ingests only the named collector', async () => {
    const home = makeHome();
    homes.push(home);
    vi.stubEnv('OMEM_HOME', home);
    const { root, absent } = fixtureRoot();
    pointAt(home, root, absent);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    expect(await main(['sync', '--collectors', 'cursor'])).toBe(0);
    const files = sessionMd(home).map((p) => p.replace(/\\/g, '/'));
    expect(files.some((p) => p.includes('/sessions/cursor/'))).toBe(true);
    expect(files.some((p) => p.includes('/sessions/claude-code/'))).toBe(false);
    expect(out.some((l) => l === 'Collectors: cursor')).toBe(true);
  });

  it('unknown id exits 1', async () => {
    const home = makeHome();
    homes.push(home);
    vi.stubEnv('OMEM_HOME', home);
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      err.push(a.join(' '));
    });
    expect(await main(['sync', '--collectors', 'codex'])).toBe(1);
    expect(err.join('\n')).toMatch(/Unknown collector: codex/);
    expect(sessionMd(home)).toEqual([]);
  });
});

describe('init --force guard', () => {
  it('warns on second init without --force', async () => {
    const home = makeHome();
    homes.push(home);
    vi.stubEnv('OMEM_HOME', home);
    // 首次 init：建仓成功
    expect(await main(['init'])).toBe(0);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    // 再次 init 不带 --force：提示已初始化
    expect(await main(['init'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('already initialized');
    expect(text).toContain('--force');
    expect(existsSync(join(home, '.git'))).toBe(true);
  });

  it('re-inits with --force when already initialized', async () => {
    const home = makeHome();
    homes.push(home);
    vi.stubEnv('OMEM_HOME', home);
    expect(await main(['init'])).toBe(0);
    expect(existsSync(join(home, '.git'))).toBe(true);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    expect(await main(['init', '--force'])).toBe(0);
    expect(out.join('\n')).toContain('Removed existing .git');
    expect(existsSync(join(home, '.git'))).toBe(true);
  });

  it('init --force on fresh home behaves as normal init', async () => {
    const home = makeHome();
    homes.push(home);
    vi.stubEnv('OMEM_HOME', home);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    expect(await main(['init', '--force'])).toBe(0);
    expect(out.join('\n')).toContain('git data repo initialized');
    expect(existsSync(join(home, '.git'))).toBe(true);
  });
});

describe('init --clone', () => {
  it('clones from a local file:// URL instead of git init', async () => {
    const src = join(tmpdir(), `omem-clone-src-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(src);
    mkdirSync(src, { recursive: true });
    execFileSync('git', ['init'], { cwd: src });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: src });
    execFileSync('git', ['config', 'user.email', 'test@localhost'], { cwd: src });
    writeFileSync(join(src, 'README.md'), '# test\n');
    execFileSync('git', ['add', '-A'], { cwd: src });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: src });

    const home = join(tmpdir(), `omem-clone-dst-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    homes.push(home);
    vi.stubEnv('OMEM_HOME', home);

    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    expect(await main(['init', '--clone', `file://${src.replace(/\\/g, '/')}`])).toBe(0);
    expect(out.join('\n')).toContain('Cloned from');
    expect(existsSync(join(home, '.git'))).toBe(true);
    expect(existsSync(join(home, 'README.md'))).toBe(true);
  });

  it('refuses to clone into existing directory without --force', async () => {
    const src = join(tmpdir(), `omem-clone-src2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(src);
    mkdirSync(src, { recursive: true });
    execFileSync('git', ['init'], { cwd: src });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: src });
    execFileSync('git', ['config', 'user.email', 'test@localhost'], { cwd: src });
    writeFileSync(join(src, 'x.md'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: src });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: src });

    const home = join(tmpdir(), `omem-clone-dst2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(home);
    mkdirSync(home, { recursive: true });
    vi.stubEnv('OMEM_HOME', home);

    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    expect(await main(['init', '--clone', `file://${src.replace(/\\/g, '/')}`])).toBe(1);
    expect(out.join('\n')).toContain('already exists');
  });
});
