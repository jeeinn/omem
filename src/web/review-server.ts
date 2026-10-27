// review --ui 的本地 HTTP 服务：只绑定 127.0.0.1，一次性 token，一次性提交。
//
// 设计约束（文档 docs/omem-review-ui设计方案.md §4.4-4.5）：
// - 三个端点全部校验 token。detail 返回正文，漏校验等于本机任意进程可读全部记忆。
// - 「已阅」只由服务端在 GET /api/detail/:id 成功时记录。前端改动不了它，
//   这是 verified 门槛的唯一真源。
// - 提交只接受一次；重复 POST 返回 409，避免用户双击造成二次写入。
// - 写盘由调用方通过 onApply 注入（命令层负责 snapshot 前置），服务本身不直接写。
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { findById } from '../core/store.js';
import { appendLog } from '../core/log.js';
import { nowIso } from '../core/util.js';
import type { ReviewAction, ReviewDecision, ReviewOutcome } from '../core/lifecycle.js';
import { buildReviewDetail } from './review-data.js';
import type { ReviewItem, SessionPathIndex } from './review-data.js';
import { renderReviewPage } from './review-page.js';

const ACTIONS: ReviewAction[] = ['confirm', 'assent', 'dismiss', 'stale'];
const ID_RE = /^[0-9A-Za-z-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 600_000;

export interface SubmitResult {
  decisions: ReviewDecision[];
  outcomes: ReviewOutcome[];
  submittedAt: string;
}

export interface ReviewServerHandle {
  url: string;
  token: string;
  port: number;
  /** 等待页面提交并完成写入；超时返回 null（此时不应写入任何东西）。 */
  waitForResult(): Promise<SubmitResult | null>;
  close(): Promise<void>;
}

export interface StartReviewServerArgs {
  home: string;
  items: ReviewItem[];
  sessionIndex: SessionPathIndex;
  /** 收到提交后由命令层落盘（含 snapshot）。抛错会被回传成 500。 */
  onApply: (decisions: ReviewDecision[]) => ReviewOutcome[];
  timeoutMs?: number;
  port?: number;
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 定长比较，避免用 === 比较 token 的时序差异。长度不同直接 false。 */
function tokenMatches(expected: string, got: string | null | undefined): boolean {
  if (!got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Host 只放行本机两种写法。localhost 不是可 rebind 的域名，放行以免手输地址被 403。 */
const HOST_RE = /^(127\.0\.0\.1|localhost):\d+$/;

export async function startReviewServer(args: StartReviewServerArgs): Promise<ReviewServerHandle> {
  const token = randomBytes(24).toString('hex');
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readIds = new Set<string>();
  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let finish: (value: SubmitResult | null) => void = () => {};

  const done = new Promise<SubmitResult | null>((resolve) => {
    finish = (value) => {
      if (settled && value === null) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? '';
        if (!HOST_RE.test(host)) return send(res, 403, 'Forbidden host');
        const url = new URL(req.url ?? '/', `http://${host}`);

        if (req.method === 'GET' && url.pathname === '/') {
          if (!tokenMatches(token, url.searchParams.get('token'))) return send(res, 403, 'Invalid token');
          return send(
            res,
            200,
            renderReviewPage({ token, items: args.items, timeoutMs }),
            'text/html; charset=utf-8',
          );
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/detail/')) {
          if (!tokenMatches(token, url.searchParams.get('token'))) return send(res, 403, 'Invalid token');
          const id = decodeURIComponent(url.pathname.slice('/api/detail/'.length));
          if (!ID_RE.test(id)) return send(res, 400, 'Bad id');
          const started = performance.now();
          const loc = findById(args.home, id, { includeArchived: true });
          if (!loc) return sendJson(res, 404, { error: 'Entry not found' });
          const counter = { hits: 0, misses: 0 };
          const detail = buildReviewDetail(args.home, loc, args.sessionIndex, counter);
          readIds.add(id);
          const ms = Math.round(performance.now() - started);
          appendLog(args.home, 'review.ui.detail', {
            id,
            sessions: detail.sessions.length,
            cache_hits: counter.hits,
            cache_misses: counter.misses,
            ms,
          });
          console.log(`[omem] detail ${id} · ${detail.sessions.length} session(s) · ${ms}ms`);
          return sendJson(res, 200, detail);
        }

        if (req.method === 'POST' && url.pathname === '/api/apply') {
          if (settled) return sendJson(res, 409, { error: 'Already submitted' });
          const type = String(req.headers['content-type'] ?? '');
          if (!type.includes('application/json')) return send(res, 415, 'Expected application/json');
          let body: { token?: string; decisions?: unknown };
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return send(res, 400, 'Bad JSON');
          }
          if (!tokenMatches(token, body.token)) return send(res, 403, 'Invalid token');

          const decisions: ReviewDecision[] = [];
          const raw = Array.isArray(body.decisions) ? body.decisions : [];
          for (const entry of raw) {
            const rec = entry as { id?: unknown; action?: unknown };
            const id = String(rec?.id ?? '');
            const action = String(rec?.action ?? '');
            if (!ID_RE.test(id)) continue;
            if (!ACTIONS.includes(action as ReviewAction)) continue;
            // read 由服务端裁定，忽略前端传来的任何值
            decisions.push({ id, action: action as ReviewAction, read: readIds.has(id) });
          }

          let outcomes: ReviewOutcome[] = [];
          try {
            outcomes = args.onApply(decisions);
          } catch (e) {
            settled = true;
            if (timer) clearTimeout(timer);
            return sendJson(res, 500, { error: String((e as Error)?.message ?? e) });
          }
          const result: SubmitResult = { decisions, outcomes, submittedAt: nowIso() };
          finish(result);
          return sendJson(res, 200, result);
        }

        return send(res, 404, 'Not found');
      } catch (e) {
        return send(res, 500, String((e as Error)?.message ?? e));
      }
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  timer = setTimeout(() => finish(null), timeoutMs);

  const url = `http://127.0.0.1:${port}/?token=${token}`;

  return {
    url,
    token,
    port,
    waitForResult: () => done,
    close: async () => {
      if (timer) clearTimeout(timer);
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
