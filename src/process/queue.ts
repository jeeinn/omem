// API 档工作队列（档 3 文档 §3.5）：从 sessions 台账物化「待加工」清单。
// 状态事实源是 session 文件 frontmatter 的 api_state；sessions 表只作镜像加速。
// 状态语法：`ok|fail|skip : <prompt版本> : <content_hash> [: 计数]`——
// 内容哈希或 prompt 版本对不上就视为从未加工（重排），fail 可重试，skip 隔离。
import type { OmemIndex, SessionRecord } from '../core/index.js';
import { parseSince } from '../core/util.js';

/** 当前加工 prompt 的版本号（§7 prompt v2，活文档语义）；prompt 内容变化必须同步升版（规则 2 全量重排）。 */
export const API_PROMPT_VERSION = 'v2';

export type ApiStateStatus = 'ok' | 'fail' | 'skip';

export interface ApiState {
  status: ApiStateStatus;
  prompt: string;
  hash: string;
  /** 仅 fail 有：解析失败计数（规则 4 计到 2 即隔离）。 */
  count: number;
}

export function parseApiState(raw: string | null | undefined): ApiState | null {
  if (!raw) return null;
  const parts = raw.split(':').map((s) => s.trim());
  if (parts.length < 3) return null;
  const [status, prompt, hash] = parts;
  if (status !== 'ok' && status !== 'fail' && status !== 'skip') return null;
  if (!prompt || !hash) return null;
  const count = status === 'fail' && parts.length > 3 ? Math.max(1, Number(parts[3]) || 1) : 0;
  return { status, prompt, hash, count };
}

export function formatApiState(s: ApiState): string {
  return s.status === 'fail' ? `${s.status}:${s.prompt}:${s.hash}:${s.count}` : `${s.status}:${s.prompt}:${s.hash}`;
}

export interface QueueItem {
  /** 主键 `agent:sessionId`。 */
  key: string;
  agent: string;
  sessionId: string;
  path: string;
  project_fp: string;
  last_ts: string;
  content_hash: string;
  /** 上一次失败计数（进队重试时带上，成功/隔离后清零语义归状态机）。 */
  failCount: number;
  /** prompt 版本重排标记（规则 2）：旧状态是 ok 但 prompt 已升级。 */
  requeuedByPrompt: boolean;
}

export interface QueueOptions {
  since?: string;
  /** 显式点名：越过隔离与 limit（规则 7）。 */
  sessionId?: string;
  limit?: number;
  promptVersion?: string;
}

export interface QueueResult {
  items: QueueItem[];
  /** 全部待加工数（limit 之前）。 */
  pending: number;
  /** 批次溢出数（pending − 实际取走；状态未写、下次继续）。 */
  overflow: number;
  quarantined: number;
  /** 其中因 prompt 版本升级重排的待加工数。 */
  requeuedByPrompt: number;
}

/** 判定单条会话是否待加工。返回 'done' | 'quarantined' | 'pending'。 */
export function classifySession(
  rec: Pick<SessionRecord, 'content_hash' | 'api_state'>,
  promptVersion = API_PROMPT_VERSION,
): { verdict: 'done' | 'quarantined' | 'pending'; failCount: number; requeuedByPrompt: boolean } {
  const state = parseApiState(rec.api_state ?? null);
  const current = rec.content_hash;
  if (state && state.hash === current && state.prompt === promptVersion) {
    if (state.status === 'ok') return { verdict: 'done', failCount: 0, requeuedByPrompt: false };
    if (state.status === 'skip') return { verdict: 'quarantined', failCount: 0, requeuedByPrompt: false };
    return { verdict: 'pending', failCount: state.count, requeuedByPrompt: false };
  }
  // 状态对不上当前内容/prompt：旧 state 视为不存在（规则 1/2）
  const requeuedByPrompt = Boolean(state && state.hash === current && state.prompt !== promptVersion && state.status === 'ok');
  return { verdict: 'pending', failCount: 0, requeuedByPrompt };
}

/** 物化待加工队列：状态机判定 → --since 过滤 → last_ts DESC → 溢出切片。 */
export function materializeQueue(index: OmemIndex, opts: QueueOptions = {}): QueueResult {
  const promptVersion = opts.promptVersion ?? API_PROMPT_VERSION;
  const since = opts.since ? parseSince(opts.since) : undefined;
  const explicit = opts.sessionId?.trim();

  const pendingItems: QueueItem[] = [];
  let quarantined = 0;
  let requeuedByPrompt = 0;

  for (const rec of index.listSessions()) {
    const { agent, sessionId } = splitKey(rec.session_id);
    const isExplicit = Boolean(explicit && (sessionId === explicit || rec.session_id === explicit));
    if (explicit && !isExplicit) continue;

    const { verdict, failCount, requeuedByPrompt: requeued } = classifySession(rec, promptVersion);
    // 规则 7：显式点名越过全部队列过滤（done / 隔离 / since / limit），单会话重加工；
    // 状态改写仍按规则 1/3/4——成功才落新 state，哈希未变不抹旧 state。
    if (!isExplicit) {
      if (verdict === 'done' || verdict === 'quarantined') {
        if (verdict === 'quarantined') quarantined++;
        continue;
      }
      if (since && new Date(rec.last_ts) < since) continue;
      if (requeued) requeuedByPrompt++;
    }

    pendingItems.push({
      key: rec.session_id,
      agent: rec.agent || agent,
      sessionId,
      path: rec.path,
      project_fp: rec.project_fp || 'unknown',
      last_ts: rec.last_ts,
      content_hash: rec.content_hash,
      // 显式重跑隔离会话：failCount 顶到 2，再解析失败保持 skip（规则 4 计数不因显式点名清零）
      failCount: isExplicit && verdict === 'quarantined' ? 2 : failCount,
      requeuedByPrompt: Boolean(requeued && !isExplicit),
    });
  }

  // 规则 6：最新优先
  pendingItems.sort((a, b) => (a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0));
  const pending = pendingItems.length;
  // 显式点名越过 limit（规则 7）
  const items = explicit ? pendingItems : (opts.limit && opts.limit > 0 ? pendingItems.slice(0, opts.limit) : pendingItems);
  return { items, pending, overflow: pending - items.length, quarantined, requeuedByPrompt };
}

function splitKey(key: string): { agent: string; sessionId: string } {
  const i = key.indexOf(':');
  return i <= 0 ? { agent: '', sessionId: key } : { agent: key.slice(0, i), sessionId: key.slice(i + 1) };
}
