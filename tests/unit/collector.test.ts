// 采集器测试：Claude Code JSONL 解析、过滤规则、项目指纹，以及三采集器扫描（评估 4.5 采集器）。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionFile, listSessionFiles, resolveProjectFp } from '../../src/collect/claude-code.js';
import { COLLECTOR_IDS, getCollector, scanSessions } from '../../src/collect/collector.js';
import { Encoder } from '@toondepauw/node-zstd';
import { defaultConfig } from '../../src/core/config.js';
import { OmemIndex } from '../../src/core/index.js';
import { makeHome, cleanupHome } from './helpers.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'claude-projects', '-x-demo-project', 'sess-fixture-1.jsonl');

describe('collector: Claude Code JSONL', () => {
  it('parses the synthetic fixture: message count, roles, filtering', () => {
    const d = parseSessionFile(FIXTURE)!;
    expect(d).not.toBeNull();
    expect(d.session_id).toBe('sess-fixture-1');
    expect(d.agent).toBe('claude-code');
    // 8 行中：1 条 summary + 1 条 sidechain 被过滤 → 6 条消息
    expect(d.messages).toHaveLength(6);
    // sidechain 与 summary 内容不得出现
    const all = d.messages.map((m) => m.content).join('\n');
    expect(all).not.toContain('sidechain-marker-xyz');
    expect(all).not.toContain('会话摘要');
  });

  it('assistant tool_use blocks stripped, text only', () => {
    const d = parseSessionFile(FIXTURE)!;
    const assistant = d.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe('好的，以后手写 SQL。');
    expect(assistant[0].content).not.toContain('tool_use');
  });

  it('msg_uuid / ts / project_fp complete', () => {
    const d = parseSessionFile(FIXTURE)!;
    const first = d.messages[0];
    expect(first.msg_uuid).toBe('u1');
    expect(first.ts).toBe('2026-10-10T09:00:00.000Z');
    expect(first.project_fp).toMatch(/^(?:local:[0-9a-f]{8}|[0-9a-f]{12}|unknown)$/);
  });

  it('listSessionFiles filters by --since', () => {
    const dir = join(tmpdir(), 'omem-collect-test-' + Date.now());
    try {
      mkdirSync(join(dir, 'proj'), { recursive: true });
      writeFileSync(join(dir, 'proj', 's1.jsonl'), '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u","timestamp":"2026-10-10T09:00:00Z","sessionId":"s1"}\n');
      expect(listSessionFiles(dir)).toHaveLength(1);
      expect(listSessionFiles(dir, { since: new Date('2030-01-01') })).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('corrupted lines tolerated (skipped, no throw)', () => {
    const dir = join(tmpdir(), 'omem-collect-bad-' + Date.now());
    try {
      mkdirSync(join(dir, 'proj'), { recursive: true });
      writeFileSync(
        join(dir, 'proj', 'bad.jsonl'),
        ['这不是 JSON', '{"type":"user","message":{"role":"user","content":"有效消息"},"uuid":"u1","timestamp":"2026-10-10T09:00:00Z","sessionId":"bad"}', '{"broken'].join('\n'),
      );
      const d = parseSessionFile(join(dir, 'proj', 'bad.jsonl'))!;
      expect(d.messages).toHaveLength(1);
      expect(d.messages[0].content).toBe('有效消息');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveProjectFp: no cwd → unknown; no git → local: prefix', () => {
    expect(resolveProjectFp(undefined)).toBe('unknown');
    const fp = resolveProjectFp(tmpdir());
    expect(fp.startsWith('local:')).toBe(true);
  });
});

describe('collector: registry', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('registers every collector in the registry; unknown id errors', () => {
    // 断言写成「注册表里有几个就注册了几个」，而不是手写一份列表——
    // 手写的那份每加一个采集器就会漏（已经漏过三次）。
    expect([...COLLECTOR_IDS]).toEqual([
      'claude-code', 'workbuddy', 'cursor', 'qwenwork',
      'doubao', 'deepseek', 'qoder', 'catpaw', 'codebuddy',
    ]);
    const config = defaultConfig();
    for (const id of COLLECTOR_IDS) {
      expect(getCollector(id, config).id, `${id} must be constructible`).toBe(id);
    }
    expect(() => getCollector('codex', config)).toThrow(/Unknown collector/);
  });

  it('scanSessions scans all four at once; a missing directory does not block the rest', () => {
    const home = makeHome();
    dirs.push(home);
    const index = new OmemIndex(home);
    try {
    const root = join(tmpdir(), 'omem-scan-' + Date.now());
    dirs.push(root);
    const claude = join(root, 'claude', 'proj');
    const workbuddy = join(root, 'wb', 'proj');
    const cursor = join(root, 'cursor', 'p1', 'agent-transcripts', 'cur-1');
    const qwenwork = join(root, 'qw', 'proj');
    const doubao = join(root, 'doubao', 'sess-1', 'agents', 'm_a', 'system');
    const deepseek = join(root, 'deepseek', 'proj', 'ds-sess-1');
    const qoder = join(root, 'qoder', 'cache', 'projects', 'qp', 'conversation-history', 'qid-1');
    const catpaw = join(root, 'catpaw', 'idex--cp', 'sess-cp-1', 'agent-transcripts');
    const codebuddy = join(root, 'codebuddy', 'projects', 'e-projects-demo');
    mkdirSync(claude, { recursive: true });
    mkdirSync(workbuddy, { recursive: true });
    mkdirSync(cursor, { recursive: true });
    mkdirSync(qwenwork, { recursive: true });
    mkdirSync(doubao, { recursive: true });
    mkdirSync(deepseek, { recursive: true });
    mkdirSync(qoder, { recursive: true });
    mkdirSync(catpaw, { recursive: true });
    mkdirSync(codebuddy, { recursive: true });
    writeFileSync(join(claude, 's1.jsonl'), '{"type":"user","message":{"role":"user","content":"claude 以后都用手写 SQL"},"uuid":"u","timestamp":"2026-10-10T09:00:00Z","sessionId":"s1"}\n');
    writeFileSync(join(workbuddy, 'wb-1.jsonl'), '{"type":"message","id":"u1","sessionId":"wb-1","timestamp":"2026-10-15T01:00:01.000Z","role":"user","content":[{"type":"input_text","text":"workbuddy 以后都用手写 SQL"}]}\n');
    writeFileSync(join(cursor, 'cur-1.jsonl'), '{"role":"user","message":{"content":[{"type":"text","text":"cursor 以后都用手写 SQL"}]}}\n');
    writeFileSync(join(qwenwork, 'qw-1.jsonl'), '{"type":"user","uuid":"u1","sessionId":"qw-1","timestamp":"2026-10-20T08:00:01.000Z","cwd":"X:/demo/qw","message":{"role":"user","content":[{"type":"text","text":"qwenwork 以后都用手写 SQL"}]}}\n');
    writeFileSync(join(doubao, 'trajectory.jsonl'), '{"role":"user","content":"doubao 以后都用手写 SQL"}\n');
    const deepseekLines = [
      JSON.stringify({ type: 'session', version: 4, id: 'ds-sess-1', createdAt: 1_700_000_000_000, cwd: 'X:/demo/ds' }),
      JSON.stringify({ type: 'user/message', data: { content: 'deepseek 以后都用手写 SQL' } }),
    ].join('\n');
    writeFileSync(join(deepseek, 'session.v4.jsonl.zstd'), new Encoder(3).encodeSync(Buffer.from(deepseekLines, 'utf8')));
    writeFileSync(join(qoder, 'qid-1.jsonl'), JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>qoder 以后都用手写 SQL</user_query>' }] } }));
    writeFileSync(join(catpaw, 'transcript.txt'), 'user:\n<user_query>catpaw 以后都用手写 SQL</user_query>\n\nassistant:\n好的。\n');
    writeFileSync(
      join(codebuddy, 'sess-cb-1.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'codebuddy 以后都用手写 SQL' }],
          id: 'cb-u1',
          timestamp: 1763955079125,
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '好的。' }],
          id: 'cb-a1',
          timestamp: 1763955080000,
        }),
      ].join('\n') + '\n',
    );
    const config = defaultConfig();
    config.collect.claude_projects = join(root, 'claude');
    config.collect.workbuddy_projects = join(root, 'wb');
    config.collect.cursor_projects = join(root, 'absent-cursor');
    config.collect.qwenwork_projects = join(root, 'absent-qw');
    config.collect.doubao_projects = join(root, 'absent-doubao');
    config.collect.deepseek_projects = join(root, 'absent-ds');
    config.collect.qoder_projects = join(root, 'absent-qoder');
    config.collect.qoder_cn_projects = join(root, 'absent-qoder-cn');
    config.collect.catpaw_projects = join(root, 'absent-catpaw');
    config.collect.codebuddy_projects = join(root, 'absent-codebuddy');
    config.collect.codebuddy_cn_projects = join(root, 'absent-codebuddy-cn');
    let scan = scanSessions(index, config, {});
    expect(scan.digests.map((d) => d.agent).sort()).toEqual(['claude-code', 'workbuddy']);
    expect(scan.roots.find((r) => r.id === 'cursor')?.exists).toBe(false);
    expect(scan.roots.find((r) => r.id === 'qwenwork')?.exists).toBe(false);
    expect(scan.roots.find((r) => r.id === 'doubao')?.exists).toBe(false);
    expect(scan.roots.find((r) => r.id === 'deepseek')?.exists).toBe(false);
    expect(scan.roots.find((r) => r.id === 'qoder')?.exists).toBe(false);
    expect(scan.roots.find((r) => r.id === 'catpaw')?.exists).toBe(false);
    expect(scan.roots.find((r) => r.id === 'codebuddy')?.exists).toBe(false);

    config.collect.cursor_projects = join(root, 'cursor');
    config.collect.qwenwork_projects = join(root, 'qw');
    config.collect.doubao_projects = join(root, 'doubao');
    config.collect.deepseek_projects = join(root, 'deepseek');
    config.collect.qoder_projects = join(root, 'qoder');
    config.collect.qoder_cn_projects = join(root, 'absent-qoder-cn');
    config.collect.catpaw_projects = join(root, 'catpaw');
    config.collect.codebuddy_projects = join(root, 'codebuddy');
    config.collect.codebuddy_cn_projects = join(root, 'absent-codebuddy-cn');
    scan = scanSessions(index, config, {});
    expect(scan.digests.map((d) => d.agent).sort()).toEqual([
      'catpaw', 'claude-code', 'codebuddy', 'cursor', 'deepseek', 'doubao', 'qoder', 'qwenwork', 'workbuddy',
    ]);
    } finally {
      index.close();
    }
  });
});
