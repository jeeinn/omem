// 档 3 pipeline 集成测试（文档 §3.5/§3.8/§3.9）：队列接入、dry-run 零网络、失败隔离与中止。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import type { OmemConfig } from '../../src/core/config.js';
import { runPipelineAsync } from '../../src/process/pipeline.js';
import { materializeQueue, API_PROMPT_VERSION } from '../../src/process/queue.js';
import { readStoredSession } from '../../src/collect/session-store.js';
import { BackendUnavailableError } from '../../src/core/util.js';
import { makeHome, cleanupHome } from './helpers.js';

const ABSENT = join(process.cwd(), 'tests', 'fixtures', 'claude-projects', 'nonexistent');

let home: string;
let index: OmemIndex;
let servers: Server[] = [];
const envKeys = ['OMEM_API_KEY', 'OMEM_API_BASE', 'OMEM_API_MODEL', 'OMEM_API_LIMIT', 'OMEM_API_TIMEOUT_MS', 'OMEM_API_MAX_CHARS'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  servers = [];
  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(async () => {
  index.close();
  cleanupHome(home);
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function seedSession(id: string, body: string, lastTs: string): void {
  const dir = join(home, 'sessions', 'claude-code');
  mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    'agent: claude-code',
    `session_id: ${id}`,
    'project: proj-x',
    'started: 2026-10-20T10:00:00.000Z',
    `ended: ${lastTs}`,
    'messages: 1',
    `content_hash: hash-${id}`,
    '---',
    '',
    body,
    '',
  ];
  writeFileSync(join(dir, `${id}.md`), lines.join('\n'));
}

function cfgFor(base: string, over: Partial<OmemConfig['api']> = {}): OmemConfig {
  const config = defaultConfig();
  // 采集根必须存在（noteMissingRoots 全缺会提前返回）但为空：本组测试直接造 sessions/ 存量
  const emptyRoot = join(home, 'empty-collect');
  mkdirSync(emptyRoot, { recursive: true });
  config.collect.claude_projects = emptyRoot;
  config.collect.workbuddy_projects = ABSENT;
  config.collect.cursor_projects = ABSENT;
  config.api.base = base;
  config.api.model = 'test-model';
  config.api.timeout_ms = 5_000;
  config.api.limit = 20;
  Object.assign(config.api, over);
  saveConfig(home, config);
  return config;
}

interface Stub {
  base: string;
  requests: string[];
  server: Server;
}

async function startStub(handler: (i: number, body: string) => { status: number; content: string } | null): Promise<Stub> {
  const requests: string[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push(req.url ?? '');
      const out = handler(n++, body);
      if (!out) return;
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.content);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  return { base: `http://127.0.0.1:${addr.port}`, requests, server };
}

const okReply = (content: string) => ({ status: 200, content: JSON.stringify({ choices: [{ message: { content } }] }) });
const oneCandidate = okReply('[{"type":"fact","content":"a stored conclusion","confidence":0.6}]');

describe('pipeline: api tier (doc §3.5/§3.8/§3.9)', () => {
  it('V5: dry-run makes zero network calls and writes no api_state', async () => {
    seedSession('s1', '## user\nhello', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub(() => oneCandidate);
    const config = cfgFor(stub.base);
    const report = await runPipelineAsync(home, config, index, { dryRun: true });
    expect(stub.requests).toHaveLength(0);
    expect(readStoredSession(join(home, 'sessions', 'claude-code', 's1.md'))?.apiState).toBeUndefined();
    expect(index.getSession('claude-code:s1')?.api_state ?? null).toBeNull();
    expect(report.notes.join(' ')).toMatch(/dry-run/);
  });

  it('processes queue oldest-bounded by limit and writes ok state (V20/V21)', async () => {
    seedSession('s1', '## user\nhello one', '2026-10-18T10:05:00.000Z');
    seedSession('s2', '## user\nhello two', '2026-10-19T10:05:00.000Z');
    seedSession('s3', '## user\nhello three', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub(() => oneCandidate);
    const config = cfgFor(stub.base, { limit: 2 });
    const report = await runPipelineAsync(home, config, index, {});
    expect(stub.requests).toHaveLength(2); // 溢出 1 条留下次
    expect(report.written.length + report.deduped).toBeGreaterThanOrEqual(2);
    // 最新的两条被加工，s1 溢出仍在队列
    expect(readStoredSession(join(home, 'sessions', 'claude-code', 's3.md'))?.apiState).toMatch(/^ok:/);
    expect(readStoredSession(join(home, 'sessions', 'claude-code', 's1.md'))?.apiState).toBeUndefined();
    const next = materializeQueue(index, { limit: 20 });
    expect(next.pending).toBe(1);
    expect(next.overflow).toBe(0);
  });

  it('V7: single transport failure does not abort; state not written (V24)', async () => {
    seedSession('s1', '## user\none', '2026-10-18T10:05:00.000Z');
    seedSession('s2', '## user\ntwo', '2026-10-19T10:05:00.000Z');
    seedSession('s3', '## user\nthree', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub((i) => (i === 1 ? { status: 500, content: 'boom' } : oneCandidate));
    const config = cfgFor(stub.base);
    const report = await runPipelineAsync(home, config, index, {});
    expect(report.failed).toBe(1);
    expect(stub.requests).toHaveLength(3);
    // 失败的那条（s2）不写状态 → 下次重试
    expect(readStoredSession(join(home, 'sessions', 'claude-code', 's2.md'))?.apiState).toBeUndefined();
    const next = materializeQueue(index, {});
    expect(next.pending).toBe(1);
    expect(next.items[0].sessionId).toBe('s2');
  });

  it('V25: 3 consecutive transport failures abort with BackendUnavailableError (exit 2)', async () => {
    for (const id of ['a', 'b', 'c', 'd']) seedSession(id, `## user\n${id}`, `2026-10-1${id.charCodeAt(0) % 10}T10:05:00.000Z`);
    index.catchUp();
    const stub = await startStub(() => ({ status: 503, content: 'down' }));
    const config = cfgFor(stub.base);
    await expect(runPipelineAsync(home, config, index, {})).rejects.toThrow(BackendUnavailableError);
    expect(stub.requests).toHaveLength(3); // 第 3 次连续失败即中止
  });

  it('V22: parse_failed twice quarantines; success resets nothing (state machine)', async () => {
    seedSession('s1', '## user\nchatty', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub(() => okReply('I cannot extract anything useful from this.'));
    const config = cfgFor(stub.base);
    const r1 = await runPipelineAsync(home, config, index, {});
    expect(r1.parseFailed).toBe(1);
    expect(readStoredSession(join(home, 'sessions', 'claude-code', 's1.md'))?.apiState).toBe(`fail:${API_PROMPT_VERSION}:hash-s1:1`);
    const r2 = await runPipelineAsync(home, config, index, {});
    expect(r2.parseFailed).toBe(1);
    expect(readStoredSession(join(home, 'sessions', 'claude-code', 's1.md'))?.apiState).toBe(`skip:${API_PROMPT_VERSION}:hash-s1`);
    // 隔离后不再排队
    const q = materializeQueue(index, {});
    expect(q.pending).toBe(0);
    expect(q.quarantined).toBe(1);
  });

  it('V10: summary line reports the columned counts', async () => {
    seedSession('s1', '## user\none', '2026-10-19T10:05:00.000Z');
    seedSession('s2', '## user\ntwo', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub((i) => (i === 0 ? okReply('nope not json') : oneCandidate));
    const config = cfgFor(stub.base);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => { lines.push(String(s)); };
    try {
      await runPipelineAsync(home, config, index, {});
    } finally {
      console.log = orig;
    }
    const done = lines.find((l) => l.startsWith('[api] done:'));
    expect(done).toBeDefined();
    expect(done).toMatch(/written \d+ · deduped \d+ · failed \d+ · parse_failed \d+ · quarantined \d+ · elapsed \S+ · pending \d+/);
  });

  it('ok state is skipped on rerun (no double processing)', async () => {
    seedSession('s1', '## user\none', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub(() => oneCandidate);
    const config = cfgFor(stub.base);
    await runPipelineAsync(home, config, index, {});
    expect(stub.requests).toHaveLength(1);
    const second = await runPipelineAsync(home, config, index, {});
    expect(stub.requests).toHaveLength(1); // 不再请求
    expect(second.candidates).toBe(0);
    expect(readStoredSession(join(home, 'sessions', 'claude-code', 's1.md'))?.apiState).toMatch(/^ok:/);
  });
});
