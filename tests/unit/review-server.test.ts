// review --ui 的 HTTP 契约：token 门禁、已阅集合、一次性提交、超时。
//
// 不测 DOM。页面退化成字符串模板，真正需要守住的是端点行为：
// detail 不校验 token 就等于本机任意进程可读全部记忆；readIds 由前端控制
// 就等于「展开才 verified」形同虚设。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { OmemIndex } from '../../src/core/index.js';
import { findById, writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { applyReviewDecisions } from '../../src/core/lifecycle.js';
import type { ReviewDecision } from '../../src/core/lifecycle.js';
import { buildReviewItem } from '../../src/web/review-data.js';
import { startReviewServer } from '../../src/web/review-server.js';
import type { ReviewServerHandle } from '../../src/web/review-server.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;
let handle: ReviewServerHandle | null = null;

function add(id: string, body: string, fm: Partial<Frontmatter> = {}): void {
  const e = { fm: newFrontmatter({ id, type: 'fact', domain: 'coding', ...fm }), body };
  const { path, content } = writeEntry(home, e);
  index.upsert(e, path, content);
}

interface Harness {
  server: ReviewServerHandle;
  applied: () => ReviewDecision[];
}

async function start(ids: string[], timeoutMs = 5000): Promise<Harness> {
  const items = ids.map((id) => buildReviewItem(home, findById(home, id)!));
  let applied: ReviewDecision[] = [];
  handle = await startReviewServer({
    home,
    items,
    sessionIndex: new Map(),
    onApply: (decisions) => {
      applied = decisions;
      return applyReviewDecisions(home, index, decisions);
    },
    timeoutMs,
  });
  return { server: handle, applied: () => applied };
}

function base(server: ReviewServerHandle): string {
  return `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  index.close();
  cleanupHome(home);
});

describe('review server: token 门禁', () => {
  it('GET / 无 token → 403', async () => {
    add('2026-10-27-a1', '结论');
    const { server } = await start(['2026-10-27-a1']);

    const res = await fetch(`${base(server)}/`);

    expect(res.status).toBe(403);
  });

  it('GET / 正确 token → 200 且页面含队列标题', async () => {
    add('2026-10-27-a2', '页面里的结论');
    const { server } = await start(['2026-10-27-a2']);

    const res = await fetch(server.url);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('2026-10-27-a2');
    expect(html).toContain('omem review');
  });

  it('GET /api/detail/:id 无 token → 403（正文不能裸奔）', async () => {
    add('2026-10-27-a3', '正文');
    const { server } = await start(['2026-10-27-a3']);

    const res = await fetch(`${base(server)}/api/detail/2026-10-27-a3`);

    expect(res.status).toBe(403);
  });

  it('POST /api/apply 无 token → 403', async () => {
    add('2026-10-27-a4', '正文');
    const { server } = await start(['2026-10-27-a4']);

    const res = await fetch(`${base(server)}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisions: [{ id: '2026-10-27-a4', action: 'confirm' }] }),
    });

    expect(res.status).toBe(403);
  });

  it('Host 头不是本机 → 403（DNS rebinding 防护）', async () => {
    add('2026-10-27-a5', '正文');
    const { server } = await start(['2026-10-27-a5']);

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: server.port, path: `/?token=${server.token}`, method: 'GET', headers: { host: 'evil.example.com' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(403);
  });
});

describe('review server: 详情与已阅集合', () => {
  it('GET detail → 200，正文与版本信息齐全', async () => {
    add('2026-10-27-b1', '这是正文内容。', { evidence: ['证据原文'], supersedes: ['2026-10-01-old'] });
    const { server } = await start(['2026-10-27-b1']);

    const res = await fetch(`${base(server)}/api/detail/2026-10-27-b1?token=${server.token}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.body).toContain('这是正文内容');
    expect(body.evidence).toEqual(['证据原文']);
    expect(body.supersedes).toEqual(['2026-10-01-old']);
  });

  it('含路径分隔符的 id → 400（path 注入防护）', async () => {
    const { server } = await start([]);

    const res = await fetch(`${base(server)}/api/detail/..%2F..%2Fetc?token=${server.token}`);

    expect(res.status).toBe(400);
  });

  it('不存在的 id → 404', async () => {
    const { server } = await start([]);

    const res = await fetch(`${base(server)}/api/detail/2026-10-27-nope?token=${server.token}`);

    expect(res.status).toBe(404);
  });
});

describe('review server: 提交与分级落章', () => {
  it('未展开详情就 confirm → 服务端落地为 assent（verified 仍 false）', async () => {
    add('2026-10-27-c1', '结论', { confidence: 0.55 });
    const { server, applied } = await start(['2026-10-27-c1']);

    const res = await fetch(`${base(server)}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: server.token, decisions: [{ id: '2026-10-27-c1', action: 'confirm' }] }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.outcomes[0]).toMatchObject({ status: 'ok', requested: 'confirm', applied: 'assent' });
    expect(findById(home, '2026-10-27-c1')!.entry.fm.verified).toBe(false);
    expect(applied()[0].read).toBe(false);
  });

  it('先 GET detail（=展开）再 confirm → verified，且前端传来的 read 被忽略', async () => {
    add('2026-10-27-c2', '结论', { confidence: 0.55 });
    const { server } = await start(['2026-10-27-c2']);

    await fetch(`${base(server)}/api/detail/2026-10-27-c2?token=${server.token}`);

    const res = await fetch(`${base(server)}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 故意传 read:false，服务端应无视并以已阅集合为准
      body: JSON.stringify({
        token: server.token,
        decisions: [{ id: '2026-10-27-c2', action: 'confirm', read: false }],
      }),
    });
    const body = await res.json();

    expect(body.outcomes[0]).toMatchObject({ status: 'ok', applied: 'confirm' });
    expect(findById(home, '2026-10-27-c2')!.entry.fm.verified).toBe(true);
  });

  it('重复提交 → 409，且不二次写入', async () => {
    add('2026-10-27-c3', '结论', { confidence: 0.55 });
    const { server } = await start(['2026-10-27-c3']);
    const payload = JSON.stringify({ token: server.token, decisions: [{ id: '2026-10-27-c3', action: 'confirm', read: true }] });

    const first = await fetch(`${base(server)}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    const second = await fetch(`${base(server)}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(findById(home, '2026-10-27-c3')!.entry.fm.confirmations).toBe(1);
  });

  it('非法 action 被丢弃，不产生决议', async () => {
    add('2026-10-27-c4', '结论');
    const { server, applied } = await start(['2026-10-27-c4']);

    const res = await fetch(`${base(server)}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: server.token, decisions: [{ id: '2026-10-27-c4', action: 'delete-everything' }] }),
    });

    expect(res.status).toBe(200);
    expect(applied()).toHaveLength(0);
  });

  it('非 application/json → 415（阻断简单表单跨站提交）', async () => {
    add('2026-10-27-c5', '结论');
    const { server } = await start(['2026-10-27-c5']);

    const res = await fetch(`${base(server)}/api/apply`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'token=whatever',
    });

    expect(res.status).toBe(415);
  });
});

describe('review server: 超时', () => {
  it('未提交时超时返回 null，不写入任何东西', async () => {
    add('2026-10-27-d1', '结论', { confidence: 0.55 });
    const { server } = await start(['2026-10-27-d1'], 30);

    const result = await server.waitForResult();

    expect(result).toBeNull();
    expect(findById(home, '2026-10-27-d1')!.entry.fm.verified).toBe(false);
  });
});
