// omem topic list：让「库里有哪些主题」「旧主题去哪了」变成可查的输出。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;

function add(id: string, topic: string | undefined, fm: Partial<Frontmatter> = {}, body = `正文 ${id}`): void {
  writeEntry(home, { fm: newFrontmatter({ id, type: 'fact', domain: 'coding', topic, ...fm }), body });
}

function capture(): string[] {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  return out;
}

beforeEach(() => {
  home = makeHome();
  vi.stubEnv('OMEM_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupHome(home);
});

describe('cli: omem topic list', () => {
  it('lists topics with doc count, date and confidence', async () => {
    add('2026-10-19-aaaaaa', 'pool-tuning', { confidence: 0.9, created: '2026-10-19T00:00:00.000Z' }, '连接池上限 20');
    add('2026-10-20-bbbbbb', 'deploy-pipeline', { confidence: 0.55, created: '2026-10-20T00:00:00.000Z' }, '部署走国内源');

    const out = capture();
    expect(await main(['topic', 'list'])).toBe(0);
    const text = out.join('\n');

    expect(text).toContain('2 topic(s)');
    expect(text).toContain('pool-tuning');
    expect(text).toContain('deploy-pipeline');
    expect(text).toContain('0.90');
    expect(text).toContain('连接池上限 20');
    // 最近的排在前面
    expect(text.indexOf('deploy-pipeline')).toBeLessThan(text.indexOf('pool-tuning'));
  });

  it('reports documents that have no topic, with ids so they can be fixed', async () => {
    add('2026-10-19-aaaaaa', 'pool-tuning');
    add('2026-10-21-cccccc', undefined);

    const out = capture();
    await main(['topic', 'list']);
    const text = out.join('\n');

    expect(text).toContain('1 active document(s) without a topic');
    expect(text).toContain('Without a topic (1)');
    expect(text).toContain('2026-10-21-cccccc');
  });

  it('holds the same topic once even if several active documents claim it', async () => {
    add('2026-10-19-aaaaaa', 'pool-tuning', { created: '2026-10-19T00:00:00.000Z' });
    add('2026-10-25-bbbbbb', 'pool-tuning', { created: '2026-10-25T00:00:00.000Z' });

    const out = capture();
    await main(['topic', 'list']);
    const text = out.join('\n');

    expect(text).toContain('1 topic(s) · 2 topic document(s)');
    expect((text.match(/pool-tuning/g) ?? []).length).toBe(1);
  });

  it('--all maps a retired topic to the document that absorbed it', async () => {
    add('2026-10-19-old000', 'matea-setup-wizard', {
      status: 'superseded',
      superseded_by: '2026-10-26-new000',
    });
    add('2026-10-26-new000', 'e2e-gitea-pitfalls');

    const out = capture();
    await main(['topic', 'list', '--all']);
    const text = out.join('\n');

    expect(text).toContain('Retired topics');
    expect(text).toContain('matea-setup-wizard');
    expect(text).toContain('e2e-gitea-pitfalls');
    expect(text).toContain('2026-10-26-new000');
  });

  it('--all marks a retired topic whose successor chain is broken', async () => {
    add('2026-10-19-old111', 'orphan-topic', {
      status: 'superseded',
      superseded_by: '2026-10-26-gone00',
    });

    const out = capture();
    await main(['topic', 'list', '--all']);

    expect(out.join('\n')).toContain('(no active successor)');
  });

  it('without --all the retired section stays hidden', async () => {
    add('2026-10-19-old222', 'gone-topic', { status: 'superseded', superseded_by: '2026-10-26-new222' });
    add('2026-10-26-new222', 'current-topic');

    const out = capture();
    await main(['topic', 'list']);

    const text = out.join('\n');
    expect(text).not.toContain('Retired topics');
    expect(text).not.toContain('gone-topic');
  });

  it('empty store prints a hint instead of an empty table', async () => {
    const out = capture();
    await main(['topic', 'list']);

    expect(out.join('\n')).toContain('No living-document topics yet');
  });

  it('rejects an unknown subcommand with a usage error', async () => {
    const out = capture();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await main(['topic', 'merge']);

    expect(code).toBe(1);
    expect(err.mock.calls.join('\n')).toContain('omem topic list');
    expect(out.join('\n')).toBe('');
  });
});
