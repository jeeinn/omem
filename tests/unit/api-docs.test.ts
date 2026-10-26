// 活文档语义测试（档 3 文档 §7）：证据锚定、自动 supersede、topic 同一性、增量合并。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import type { OmemConfig } from '../../src/core/config.js';
import { runPipelineAsync } from '../../src/process/pipeline.js';
import { extractWithApi, parseLooseJson, type ApiRuntimeConfig } from '../../src/process/api.js';
import { scoreApiDoc, scoreEvidence, evidenceIn, SCORE_API_CAP } from '../../src/process/score.js';
import { serializeEntry, parseEntry, newFrontmatter } from '../../src/core/entry.js';
import { listEntries } from '../../src/core/store.js';
import { searchEntries } from '../../src/core/search.js';
import { tailLog } from '../../src/core/log.js';
import { main } from '../../src/cli.js';
import { makeHome, cleanupHome } from './helpers.js';

const ABSENT = join(process.cwd(), 'tests', 'fixtures', 'claude-projects', 'nonexistent');

/**
 * 近似/撞车 topic 的记录通道是日志 + 总结提示（终端不逐条刷屏），
 * 这里读日志断言，而不是捕获 pipeline 的 console 输出。
 */
function dupTopicEvents(h: string): { status: string; session?: string; note?: string }[] {
  return tailLog(h, 500)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((j) => j?.status === 'possible-duplicate-topic') as { status: string; session?: string; note?: string }[];
}

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

function seedSession(id: string, body: string, lastTs: string, project = 'proj-x'): void {
  const dir = join(home, 'sessions', 'claude-code');
  mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    'agent: claude-code',
    `session_id: ${id}`,
    `project: ${project}`,
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
  const emptyRoot = join(home, 'empty-collect');
  mkdirSync(emptyRoot, { recursive: true });
  config.collect.claude_projects = emptyRoot;
  config.collect.workbuddy_projects = ABSENT;
  config.collect.cursor_projects = ABSENT;
  config.collect.qwenwork_projects = ABSENT;
  config.collect.doubao_projects = ABSENT;
  config.collect.deepseek_projects = ABSENT;
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
  requests: { body: string }[];
}

async function startStub(handler: (i: number, body: string) => { status: number; content: string }): Promise<Stub> {
  const requests: Stub['requests'] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ body });
      const out = handler(n++, body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.content);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  return { base: `http://127.0.0.1:${addr.port}`, requests };
}

const okReply = (content: string) => ({ status: 200, content: JSON.stringify({ choices: [{ message: { content } }] }) });
const docReply = (docs: unknown[]) => okReply(JSON.stringify(docs));

function activeEntry(topics?: string[]) {
  return listEntries(home).filter(
    (l) => l.entry.fm.status === 'active' && (!topics || topics.includes(l.entry.fm.topic ?? '')),
  );
}

describe('entry: evidence 原文落盘（V15）', () => {
  it('evidence with commas / quotes / newlines round-trips unchanged', () => {
    const e = {
      fm: newFrontmatter({ id: '2026-10-21-abc123', type: 'fact' as const, domain: 'coding' }),
      body: '正文',
    };
    const quote = 'please deploy the new release, "thanks"\nsecond line';
    e.fm.evidence = [quote, 'plain quote without specials'];
    const back = parseEntry(serializeEntry(e));
    expect(back).not.toBeNull();
    expect(back!.fm.evidence).toEqual([quote, 'plain quote without specials']);
    expect(back!.fm.evidence[0]).toBe(quote); // 原文逐字保留，不写归一化形式
  });
});

describe('score: 证据锚定与归一化（V15/V16/V17/V32）', () => {
  it('V15: normalization forgives whitespace and punctuation differences', () => {
    const haystack = 'please deploy the new release, thanks!\nthen monitor the logs';
    expect(evidenceIn(haystack, 'please deploy the new release thanks')).toBe(true);
    expect(evidenceIn(haystack, 'Deploy  The  New Release，thanks')).toBe(true); // 大小写/空白/中英标点
    expect(evidenceIn(haystack, 'unrelated text here')).toBe(false);
  });

  it('V16: grounded 0.55 / corroborated 0.75 / ungrounded 0.35 + tag', () => {
    // e1 含两条引文；e2 只含第一条 → 第一条两会话印证（0.75），第二条单会话锚定（0.55）
    seedSession('e1', '## user\nplease deploy the new release thanks and monitor the logs carefully now\n\n## assistant\nok', '2026-10-20T10:05:00.000Z');
    seedSession('e2', '## user\nplease deploy the new release thanks\n\n## assistant\nnoted', '2026-10-19T10:05:00.000Z');
    index.catchUp();
    const corroborated = scoreApiDoc(home, { sessionId: 'e1', evidence: ['please deploy the new release thanks'], content: '结论' }, index);
    expect(corroborated.confidence).toBe(0.75);
    const single = scoreApiDoc(home, { sessionId: 'e1', evidence: ['monitor the logs carefully now'], content: '结论' }, index);
    expect(single.confidence).toBe(0.55);
    const miss = scoreApiDoc(home, { sessionId: 'e1', evidence: ['this quote appears nowhere at all'], content: '结论' });
    expect(miss.confidence).toBe(0.35);
    expect(miss.tags).toContain('ungrounded');
  });

  it('V17: API-doc confidence never exceeds the cap and stays unverified', () => {
    seedSession('e3', '## user\nplease deploy the new release thanks\n\n## assistant\nok', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const r = scoreApiDoc(home, { sessionId: 'e3', evidence: ['please deploy the new release thanks'], content: 'x' }, index);
    expect(r.confidence).toBeLessThanOrEqual(SCORE_API_CAP);
  });

  it('V32: save_memory path and API path score the same evidence identically', () => {
    seedSession('e4', '## user\nplease deploy the new release thanks\n\n## assistant\nok', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const evidence = 'please deploy the new release thanks';
    const viaSave = scoreEvidence(home, { content: 'c', sessionId: 'e4', evidence }, index);
    const viaApi = scoreApiDoc(home, { sessionId: 'e4', evidence: [evidence], content: 'c' }, index);
    expect(viaApi.confidence).toBe(viaSave.confidence);
  });
});

describe('extractWithApi: 响应校验（V31）', () => {
  function cfg(): ApiRuntimeConfig {
    return {
      base: 'http://127.0.0.1:1', key: '', model: 'm', timeoutMs: 5000,
      maxInputChars: 6000, limit: 20, isLocal: true, keyWillSend: false,
      warnings: [], notes: [],
    };
  }
  it('array >5 takes first 5 and logs it', async () => {
    const docs = [1, 2, 3, 4, 5, 6].map((n) => ({ topic: `t${n}`, content: `c${n}`, type: 'fact', domain: 'general', evidence: [], tags: [] }));
    const stub = await startStub(() => docReply(docs));
    const c = { ...cfg(), base: stub.base };
    const { docs: out, notes } = await extractWithApi({ body: 'x', projectFp: 'p', sessionId: 's', existingDocs: [] }, c, 'm');
    expect(out.map((d) => d.topic)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(notes.join('\n')).toMatch(/keeping first 5/);
  });

  it('duplicate topic keeps the first occurrence and logs it', async () => {
    const docs = [
      { topic: 't1', content: 'c1', type: 'fact', domain: 'general', evidence: [], tags: [] },
      { topic: 't1', content: 'c2', type: 'fact', domain: 'general', evidence: [], tags: [] },
      { topic: 't2', content: 'c3', type: 'fact', domain: 'general', evidence: [], tags: [] },
    ];
    const stub = await startStub(() => docReply(docs));
    const c = { ...cfg(), base: stub.base };
    const { docs: out, notes } = await extractWithApi({ body: 'x', projectFp: 'p', sessionId: 's', existingDocs: [] }, c, 'm');
    expect(out.map((d) => d.topic)).toEqual(['t1', 't2']);
    expect(out[0].content).toBe('c1');
    expect(notes.join('\n')).toMatch(/duplicate topic t1/);
  });

  it('evidence shorter than 12 raw chars is dropped with a note', async () => {
    const stub = await startStub(() => docReply([{ topic: 't', content: 'c', type: 'fact', domain: 'general', evidence: ['short', 'this one is long enough'], tags: [] }]));
    const c = { ...cfg(), base: stub.base };
    const { docs, notes } = await extractWithApi({ body: 'x', projectFp: 'p', sessionId: 's', existingDocs: [] }, c, 'm');
    expect(docs[0].evidence).toEqual(['this one is long enough']);
    expect(notes.join('\n')).toMatch(/below 12 chars dropped/);
  });

  it('existingDocs land in the request body (V30 injection)', async () => {
    const stub = await startStub(() => docReply([]));
    const c = { ...cfg(), base: stub.base };
    await extractWithApi({
      body: 'session body',
      projectFp: 'proj-x',
      sessionId: 's',
      existingDocs: [{ topic: 'old-topic', content: 'the full old living document' }],
    }, c, 'm');
    const sent = JSON.parse(stub.requests[0].body);
    expect(sent.messages[1].content).toContain('topic: old-topic');
    expect(sent.messages[1].content).toContain('the full old living document');
  });

  it('no project → no existing docs section in request (O1 boundary)', async () => {
    const stub = await startStub(() => docReply([]));
    const c = { ...cfg(), base: stub.base };
    await extractWithApi({ body: 'session body', projectFp: 'unknown', sessionId: 's', existingDocs: [] }, c, 'm');
    const sent = JSON.parse(stub.requests[0].body);
    expect(sent.messages[1].content).not.toContain('Existing living documents');
  });
});

describe('pipeline: 活文档提交（§7.3/§7.4 + O1）', () => {
  it('V17: entry lands with confidence ≤0.75 and verified false', async () => {
    seedSession('s1', '## user\nplease deploy the new release thanks\n\n## assistant\nok', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub(() => docReply([{ topic: 'release-doc', content: 'conclusion text', type: 'fact', domain: 'coding', evidence: ['please deploy the new release thanks'], tags: [] }]));
    await runPipelineAsync(home, cfgFor(stub.base), index, {});
    const docs = activeEntry(['release-doc']);
    expect(docs).toHaveLength(1);
    expect(docs[0].entry.fm.confidence).toBeLessThanOrEqual(0.75);
    expect(docs[0].entry.fm.verified).toBe(false);
    expect(docs[0].entry.fm.source).toBe('llm');
    expect(docs[0].entry.fm.evidence).toEqual(['please deploy the new release thanks']);
  });

  it('V18/V30: second run on same topic auto-supersedes; old stays on disk, exits retrieval', async () => {
    seedSession('s1', '## user\nfirst session about the release\n\n## assistant\nok', '2026-10-19T10:05:00.000Z');
    seedSession('s2', '## user\nsecond session about the release\n\n## assistant\nok', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub((i) => docReply([
      { topic: 'release-doc', content: `conclusion version ${i + 1}`, type: 'fact', domain: 'coding', evidence: ['session about the release here'], tags: [] },
    ]));
    await runPipelineAsync(home, cfgFor(stub.base), index, { limit: 1, sessionId: 's1' });
    const first = activeEntry(['release-doc'])[0];
    expect(first.entry.body).toContain('version 1');

    await runPipelineAsync(home, cfgFor(stub.base), index, { sessionId: 's2' });
    // 第二次请求的 body 里必须含既有活文档全文（增量合并的前提）
    const secondReq = JSON.parse(stub.requests[1].body);
    expect(secondReq.messages[1].content).toContain('conclusion version 1');

    const actives = activeEntry(['release-doc']);
    expect(actives).toHaveLength(1);
    expect(actives[0].entry.body).toContain('version 2');
    expect(actives[0].entry.fm.supersedes).toEqual([first.entry.fm.id]);
    // 旧版仍在磁盘
    expect(first.entry.fm.id).toBeTruthy();
    // 退出检索
    const hits = searchEntries(index, { query: 'conclusion version 1', limit: 10, staleWeight: 0.5 });
    expect(hits.filter((h) => h.id === first.entry.fm.id)).toHaveLength(0);
  });

  it('V28: slug variant (case/space) reuses the existing topic, no new doc', async () => {
    seedSession('s1', '## user\nfirst session about the release\n\n## assistant\nok', '2026-10-19T10:05:00.000Z');
    seedSession('s2', '## user\nsecond session about the release\n\n## assistant\nok', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub((i) => docReply([
      i === 0
        ? { topic: 'git-sync-trust', content: 'conclusion v1', type: 'fact', domain: 'coding', evidence: ['session about the release here'], tags: [] }
        : { topic: 'Git  Sync_Trust'.replace('_', '-'), content: 'conclusion v2', type: 'fact', domain: 'coding', evidence: ['session about the release here'], tags: [] },
    ]));
    await runPipelineAsync(home, cfgFor(stub.base), index, { sessionId: 's1' });
    await runPipelineAsync(home, cfgFor(stub.base), index, { sessionId: 's2' });
    expect(activeEntry(['git-sync-trust'])).toHaveLength(1);
    expect(activeEntry(['git-sync-trust'])[0].entry.body).toContain('conclusion v2');
  });

  it('V29: near-duplicate topic is reported but both docs land', async () => {
    seedSession('s1', '## user\nfirst session about the release\n\n## assistant\nok', '2026-10-19T10:05:00.000Z');
    seedSession('s2', '## user\nsecond session about the release\n\n## assistant\nok', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub((i) => docReply([
      i === 0
        ? { topic: 'git-sync-trust', content: 'conclusion v1', type: 'fact', domain: 'coding', evidence: ['session about the release here'], tags: [] }
        : { topic: 'git-sync-trust-model', content: 'conclusion v2', type: 'fact', domain: 'coding', evidence: ['session about the release here'], tags: [] },
    ]));
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => { lines.push(String(s)); };
    let second: Awaited<ReturnType<typeof runPipelineAsync>>;
    try {
      await runPipelineAsync(home, cfgFor(stub.base), index, { sessionId: 's1' });
      second = await runPipelineAsync(home, cfgFor(stub.base), index, { sessionId: 's2' });
    } finally {
      console.log = orig;
    }
    // 不合并：两份都落盘
    expect(activeEntry(['git-sync-trust'])).toHaveLength(1);
    expect(activeEntry(['git-sync-trust-model'])).toHaveLength(1);
    // 计数 + 日志记录（明细进 logs/usage，终端只在总结里给一行提示）
    expect(second.duplicateTopics).toBe(1);
    const dup = dupTopicEvents(home);
    expect(dup).toHaveLength(1);
    expect(String(dup[0].note)).toContain('suspiciously close');
    // 明细不进终端（fa62211 起终端只有进度/总结/下一步）
    expect(lines.join('\n')).not.toMatch(/possible-duplicate-topic/);
  });

  it('O1: unassigned session creates new topics only; colliding topic is skipped with warning', async () => {
    seedSession('s1', '## user\nfirst session about the release\n\n## assistant\nok', '2026-10-19T10:05:00.000Z', 'proj-x');
    seedSession('u1', '## user\nunassigned session content here\n\n## assistant\nok', '2026-10-20T10:05:00.000Z', 'unknown');
    index.catchUp();
    const stub = await startStub((i) => docReply([
      i === 0
        ? { topic: 'existing-topic', content: 'project doc', type: 'fact', domain: 'coding', evidence: ['session about the release here'], tags: [] }
        : { topic: 'existing-topic', content: 'blind replacement', type: 'fact', domain: 'coding', evidence: ['unassigned session content'], tags: [] },
    ]));
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => { lines.push(String(s)); };
    let second: Awaited<ReturnType<typeof runPipelineAsync>>;
    try {
      await runPipelineAsync(home, cfgFor(stub.base), index, { sessionId: 's1' });
      second = await runPipelineAsync(home, cfgFor(stub.base), index, { sessionId: 'u1' });
    } finally {
      console.log = orig;
    }
    // 未分配会话的请求里没有既有文档（不做增量合并）
    const unassignedReq = JSON.parse(stub.requests[1].body);
    expect(unassignedReq.messages[1].content).not.toContain('Existing living documents');
    // 撞上既有 topic → 跳过且告警，原文档不被覆盖
    const docs = activeEntry(['existing-topic']);
    expect(docs).toHaveLength(1);
    expect(docs[0].entry.body).toContain('project doc');
    expect(second.duplicateTopics).toBe(1);
    const dup = dupTopicEvents(home);
    expect(dup).toHaveLength(1);
    expect(String(dup[0].note)).toContain('already active');
    expect(String(dup[0].note)).toContain('skipped');
  });

  it('omem review --confirm raises an API doc to 0.9 + verified (V19)', async () => {
    seedSession('s1', '## user\nplease deploy the new release thanks\n\n## assistant\nok', '2026-10-20T10:05:00.000Z');
    index.catchUp();
    const stub = await startStub(() => docReply([{ topic: 'release-doc', content: 'conclusion text', type: 'fact', domain: 'coding', evidence: ['please deploy the new release thanks'], tags: [] }]));
    await runPipelineAsync(home, cfgFor(stub.base), index, {});
    const id = activeEntry(['release-doc'])[0].entry.fm.id;
    vi.stubEnv('OMEM_HOME', home);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['review', '--confirm', id]);
      expect(code).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
    const after = listEntries(home).find((l) => l.entry.fm.id === id)!;
    expect(after.entry.fm.confidence).toBe(0.9);
    expect(after.entry.fm.verified).toBe(true);
  });
});
