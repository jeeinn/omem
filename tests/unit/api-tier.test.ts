// 档 3 api.ts 测试（文档 §3.1–§3.4、§3.10）：配置优先级/回环护栏/模型探测/宽松解析。
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { defaultConfig } from '../../src/core/config.js';
import {
  isLoopbackBase,
  isLoopbackHost,
  resolveApiConfig,
  estimateTokens,
  truncateBody,
  parseLooseJson,
  probeModels,
  resolveModel,
  extractWithApi,
  ApiTransportError,
  ApiParseError,
  type ApiRuntimeConfig,
} from '../../src/process/api.js';
import { UsageError } from '../../src/core/util.js';

function cfg(over: Partial<ReturnType<typeof defaultConfig>['api']> = {}) {
  const c = defaultConfig();
  Object.assign(c.api, over);
  return c;
}

describe('api: loopback detection (§3.2 literal set)', () => {
  it('recognizes localhost / 127.0.0.0/8 / ::1 / mapped 127.x', () => {
    expect(isLoopbackBase('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackBase('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLoopbackBase('http://127.5.5.5:1/v1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    // URL 规范化会把 ::ffff:127.0.0.1 写成 ::ffff:7f00:1
    expect(isLoopbackHost('[::ffff:127.0.0.1]')).toBe(true);
    expect(isLoopbackHost('[::ffff:7f00:1]')).toBe(true);
  });

  it('fail closed: 0.0.0.0 / hosts alias / LAN / mapped non-127', () => {
    expect(isLoopbackBase('http://0.0.0.0:11434/v1')).toBe(false);
    expect(isLoopbackBase('http://mybox:11434/v1')).toBe(false);
    expect(isLoopbackBase('http://192.168.1.5:11434/v1')).toBe(false);
    expect(isLoopbackBase('http://10.0.0.3:11434/v1')).toBe(false);
    expect(isLoopbackHost('[::ffff:192.168.0.1]')).toBe(false);
    expect(isLoopbackHost('[::ffff:c0a8:1]')).toBe(false);
  });
});

describe('api: resolveApiConfig policy (§3.1/§3.2/§3.6)', () => {
  it('V8: env beats config beats default', () => {
    const c = cfg({ base: 'http://127.0.0.1:1/v1', model: 'from-config' });
    const r = resolveApiConfig(c, { OMEM_API_MODEL: 'from-env' } as NodeJS.ProcessEnv);
    expect(r.model).toBe('from-env');
    expect(r.base).toBe('http://127.0.0.1:1/v1');
    const d = resolveApiConfig(defaultConfig(), {} as NodeJS.ProcessEnv);
    expect(d.base).toBe('http://localhost:11434/v1');
    expect(d.isLocal).toBe(true);
  });

  it('V1: loopback with empty key is allowed and sends no Authorization', () => {
    const r = resolveApiConfig(cfg(), {} as NodeJS.ProcessEnv);
    expect(r.isLocal).toBe(true);
    expect(r.key).toBe('');
    expect(r.keyWillSend).toBe(false);
  });

  it('V26: loopback with explicit key sends it', () => {
    const r = resolveApiConfig(cfg({ key: 'sk-llama' }), {} as NodeJS.ProcessEnv);
    expect(r.keyWillSend).toBe(true);
  });

  it('V2: non-local without key → UsageError', () => {
    expect(() => resolveApiConfig(cfg({ base: 'https://example.com/v1', key: '' }), {} as NodeJS.ProcessEnv))
      .toThrow(UsageError);
  });

  it('V3: plain http non-loopback → UsageError', () => {
    expect(() => resolveApiConfig(cfg({ base: 'http://example.com/v1', key: 'sk-x' }), {} as NodeJS.ProcessEnv))
      .toThrow(/https/);
  });

  it('V9: non-local limit from config is clamped to 50; CLI override passes through', () => {
    const c = cfg({ base: 'https://example.com/v1', key: 'sk-x', limit: 200 });
    const r = resolveApiConfig(c, {} as NodeJS.ProcessEnv);
    expect(r.limit).toBe(50);
    expect(r.warnings.join(' ')).toMatch(/clamped/);
    const forced = resolveApiConfig(c, {} as NodeJS.ProcessEnv, { limit: 200 });
    expect(forced.limit).toBe(200);
    // 本机不受硬上限
    const local = resolveApiConfig(cfg({ limit: 200 }), {} as NodeJS.ProcessEnv);
    expect(local.limit).toBe(200);
  });

  it('locality-dependent defaults: timeout / max chars', () => {
    const local = resolveApiConfig(cfg(), {} as NodeJS.ProcessEnv);
    expect(local.timeoutMs).toBe(300_000);
    expect(local.maxInputChars).toBe(6_000);
    const cloud = resolveApiConfig(cfg({ base: 'https://example.com/v1', key: 'k' }), {} as NodeJS.ProcessEnv);
    expect(cloud.timeoutMs).toBe(60_000);
    expect(cloud.maxInputChars).toBe(12_000);
    // 显式 config 值压过按端点分档
    const pinned = resolveApiConfig(cfg({ timeout_ms: 99_000, max_input_chars: 33 }), {} as NodeJS.ProcessEnv);
    expect(pinned.timeoutMs).toBe(99_000);
    expect(pinned.maxInputChars).toBe(33);
  });

  it('missing /v1 gets an actionable note, not a rewrite', () => {
    const r = resolveApiConfig(cfg({ base: 'http://localhost:11434' }), {} as NodeJS.ProcessEnv);
    expect(r.notes.join(' ')).toMatch(/\/v1/);
  });
});

describe('api: loose parse (§3.10)', () => {
  it('V13: pure JSON / fenced / sentence-wrapped all parse', () => {
    expect(parseLooseJson('[{"a":1}]')).toEqual({ ok: true, value: [{ a: 1 }] });
    const fenced = 'Sure! Here you go:\n```json\n[{"a":1}]\n```\nHope it helps.';
    expect(parseLooseJson(fenced)).toEqual({ ok: true, value: [{ a: 1 }] });
    const wrapped = 'The result is: [{"a":1}] as requested.';
    expect(parseLooseJson(wrapped)).toEqual({ ok: true, value: [{ a: 1 }] });
  });

  it('V13④: natural language only → parse_failed', () => {
    expect(parseLooseJson('I could not find anything worth storing.')).toEqual({ ok: false, level: 3 });
  });

  it('V13⑤: brackets inside string values are not counted', () => {
    const tricky = 'noise [{"s":"clos]ing brace { inside"}] tail';
    expect(parseLooseJson(tricky)).toEqual({ ok: true, value: [{ s: 'clos]ing brace { inside' }] });
  });

  it('V14: two concatenated JSONs take the first; broken JSON is not repaired', () => {
    expect(parseLooseJson('[{"a":1}] [{"b":2}]')).toEqual({ ok: true, value: [{ a: 1 }] });
    expect(parseLooseJson('[{"a":1,,}]').ok).toBe(false);
  });

  it('escape handling: backslash skips any next char (\\X including \\\\)', () => {
    const v = parseLooseJson('x [{"s":"a\\\\\\"b"}] y');
    expect(v).toEqual({ ok: true, value: [{ s: 'a\\"b' }] });
  });
});

// ── stub server 集成（V1/V4/V6/V7/V26 传输层） ──

interface Stub {
  server: Server;
  base: string;
  requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function startStub(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return { server, base: `http://127.0.0.1:${addr.port}`, requests };
}

function localCfg(base: string, over: Partial<ApiRuntimeConfig> = {}): ApiRuntimeConfig {
  return {
    base,
    key: '',
    model: 'test-model',
    timeoutMs: 5_000,
    maxInputChars: 6_000,
    limit: 20,
    isLocal: true,
    keyWillSend: false,
    warnings: [],
    notes: [],
    ...over,
  };
}

describe('api: HTTP layer against stub server', () => {
  it('V1: loopback without key sends NO Authorization header', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[{"type":"fact","content":"c","confidence":0.6}]' } }] }));
    });
    const cfg = localCfg(stub.base);
    await extractWithApi({ body: 'hello', projectFp: 'p', sessionId: 's1' }, cfg, 'm');
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].headers.authorization).toBeUndefined();
  });

  it('V26: explicit key is sent even to loopback', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
    });
    const cfg = localCfg(stub.base, { key: 'sk-llama', keyWillSend: true });
    await extractWithApi({ body: 'hello', projectFp: 'p', sessionId: 's1' }, cfg, 'm');
    expect(stub.requests[0].headers.authorization).toBe('Bearer sk-llama');
  });

  it('V6: request body is the stored body (secrets already redacted upstream)', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
    });
    const stored = '## user\nplease deploy with this key\n\n## assistant\ndone';
    await extractWithApi({ body: stored, projectFp: 'proj-x', sessionId: 's1' }, localCfg(stub.base), 'm');
    const sent = JSON.parse(stub.requests[0].body);
    expect(sent.messages[1].content).toContain('## user\nplease deploy with this key');
    expect(sent.messages[1].content).toContain('Session (project proj-x)');
    expect(sent.model).toBe('m');
  });

  it('V7: HTTP 500 → ApiTransportError with status (pipeline decides to continue)', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    await expect(extractWithApi({ body: 'x', projectFp: 'p', sessionId: 's' }, localCfg(stub.base), 'm'))
      .rejects.toMatchObject({ name: 'ApiTransportError', status: 500 });
  });

  it('natural-language reply → ApiParseError carrying raw', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'sorry, nothing to extract' } }] }));
    });
    const err = await extractWithApi({ body: 'x', projectFp: 'p', sessionId: 's' }, localCfg(stub.base), 'm')
      .then(() => null, (e) => e as ApiParseError);
    expect(err).toBeInstanceOf(ApiParseError);
    expect(err?.raw).toContain('sorry, nothing');
  });

  it('V4: model probe lists ids; empty list → UsageError', async () => {
    const stub = await startStub((req, res) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const cfg = localCfg(`${stub.base}/v1`);
    expect(await probeModels(cfg)).toEqual(['alpha', 'beta']);
    const { model, notes } = await resolveModel(localCfg(`${stub.base}/v1`, { model: '' }));
    expect(model).toBe('alpha');
    expect(notes.join(' ')).toMatch(/alpha, beta/);

    const empty = await startStub((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    await expect(probeModels(localCfg(`${empty.base}/v1`))).rejects.toThrow(UsageError);
  });

  it('probe against a dead endpoint → UsageError requiring --model', async () => {
    const dead = localCfg('http://127.0.0.1:1/v1');
    await expect(probeModels(dead)).rejects.toThrow(/Set \[api\]\.model or --model/);
  });

  it('truncateBody keeps the most recent chars and flags truncation', () => {
    expect(truncateBody('short', 10)).toBe('short');
    const t = truncateBody('0123456789abcdef', 10);
    expect(t).toBe('(truncated)\n6789abcdef');
  });

  it('estimateTokens is chars/1.5', () => {
    expect(estimateTokens(1500)).toBe(1000);
    expect(estimateTokens(26_000)).toBe(17_333);
  });
});
