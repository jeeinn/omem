// init 不扫描；omem sync --collectors 只处理点名的采集器。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { makeHome, cleanupHome, withConfig } from './helpers.js';

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
    c.collect.claude_projects = join(root, 'claude');
    c.collect.cursor_projects = join(root, 'cursor');
    c.collect.workbuddy_projects = absent;
    c.collect.qwenwork_projects = absent;
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
