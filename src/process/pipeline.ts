// 加工流水线：先把对话写入 sessions/，再按档位处理。
// 默认档 agent 只写原文和 PROCESS.md。规则抽取已移除，不再写入 knowledge。
// API 档结束时也重写 PROCESS.md（已吸收会话离开待办），但不把引导全文打到终端。
import type { OmemConfig, Tier } from '../core/config.js';
import type { OmemIndex } from '../core/index.js';
import { nowIso, parseSince, BackendUnavailableError } from '../core/util.js';
import { deriveTitle } from '../core/entry.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';
import { commitEntry } from '../core/commit.js';
import { listEntries } from '../core/store.js';
import { scanSessions, type ScanResult } from '../collect/collector.js';
import {
  prepareDialogue,
  readStoredSession,
  sessionKey,
  splitSessionKey,
  updateSessionApiState,
  writeSessionFile,
} from '../collect/session-store.js';
import type { SessionDigest } from '../collect/types.js';
import { GUIDE_BATCH, renderGuide, writeProcessGuide, type GuideSessionRef, type GuideTopic } from './guide.js';
import {
  extractWithApi,
  resolveApiConfig,
  resolveModel,
  estimateTokens,
  endpointUnavailableError,
  ApiTransportError,
  ApiParseError,
  type DocItem,
} from './api.js';
import { materializeQueue, formatApiState, API_PROMPT_VERSION, type QueueItem } from './queue.js';
import { scoreApiDoc } from './score.js';
import { normalizeTopic } from '../core/commit.js';

export interface RunOpts {
  since?: string; // '7d' | 'YYYY-MM-DD'
  sessionId?: string;
  /** 命令行显式传入的档位。缺省时不把 config 里的 rules 当成自动抽取。 */
  tier?: Tier;
  dryRun?: boolean;
  /** API 档 CLI 覆盖（§4）：--base / --model / --limit。 */
  apiBase?: string;
  apiModel?: string;
  apiLimit?: number;
  /** TTY 进度。非 TTY 调用方传了也只是空操作（由 createRunProgress 决定）。 */
  onProgress?: (phase: string, done: number, total: number) => void;
}

export interface RunReport {
  tier: Tier;
  sessions: number;
  skipped: number;
  messages: number;
  candidates: number;
  written: string[];
  deduped: number;
  redacted: number;
  excluded: number;
  notes: string[];
  /** API 档汇总（§3.9 分列计数）。 */
  failed?: number;
  parseFailed?: number;
  quarantined?: number;
  queuePending?: number;
  elapsedMs?: number;
  /** PROCESS.md 里还有会话的主题组数（不含本批截断）。 */
  waitingTopics?: number;
  waitingUnassigned?: number;
  duplicateTopics?: number;
}

/** 显式 --tier 优先。rules 已从产品路径移除，残留配置按 agent 处理。 */
export function resolveTier(config: OmemConfig, explicit?: Tier): { tier: Tier } {
  const requested = explicit ?? config.process.default_tier;
  return { tier: requested === 'rules' ? 'agent' : requested };
}

export function runPipeline(home: string, config: OmemConfig, index: OmemIndex, opts: RunOpts = {}): RunReport {
  const { tier } = resolveTier(config, opts.tier);
  const report = emptyReport(tier);
  const scan = scanHome(config, index, opts);
  report.skipped = scan.skipped;
  if (!noteMissingRoots(report, scan)) return report;
  ingest(home, index, scan.digests, opts.dryRun ?? false, report, opts.onProgress);
  publishGuide(home, index, opts.dryRun ?? false, report);
  finish(home, index, report, opts.dryRun ?? false);
  return report;
}

/** 档 3 的异步版本（API 加工需要网络调用）。原文仍先落盘；加工走 §3.5 工作队列。 */
export async function runPipelineAsync(home: string, config: OmemConfig, index: OmemIndex, opts: RunOpts = {}): Promise<RunReport> {
  const { tier } = resolveTier(config, opts.tier ?? 'api');
  if (tier !== 'api') return runPipeline(home, config, index, opts);

  const report = emptyReport('api');
  // §6.2：策略/配置错误抛 UsageError（exit 1），不再用裸 Error
  const cfg = resolveApiConfig(config, process.env, {
    base: opts.apiBase,
    model: opts.apiModel,
    limit: opts.apiLimit,
  });

  const scan = scanHome(config, index, opts);
  report.skipped = scan.skipped;
  if (!noteMissingRoots(report, scan)) return report;
  ingest(home, index, scan.digests, opts.dryRun ?? false, report, opts.onProgress);

  const queue = materializeQueue(index, {
    since: opts.since,
    sessionId: opts.sessionId,
    limit: cfg.limit,
    promptVersion: API_PROMPT_VERSION,
  });
  report.queuePending = queue.pending;
  report.quarantined = queue.quarantined;

  for (const w of cfg.warnings) console.warn(`[api] warning: ${w}`);
  for (const n of cfg.notes) console.log(`[api] note: ${n}`);

  // §3.11：批量预估行——dry-run 也打印，给用户看量级的机会
  const estChars = queue.items.reduce((n, it) => n + readBodyChars(it.path), 0);
  const tokens = estimateTokens(estChars);
  console.log(
    `[api] batch: ${queue.items.length} sessions · ~${Math.round(tokens / 1000)}k tokens (rough estimate) · `
      + `base ${cfg.base} (${cfg.isLocal ? 'local' : 'non-local'}, ${cfg.keyWillSend ? 'key will be sent' : 'no key'})`,
  );
  if (!cfg.isLocal) {
    console.log('[api] note: session transcripts will leave this machine; secrets are redacted, business content is not.');
  }
  if (queue.requeuedByPrompt > 0) {
    console.log(`[api] pending ${queue.pending} (${queue.requeuedByPrompt} requeued by ${API_PROMPT_VERSION} upgrade)`);
  }

  // §3.8：dry-run 零网络调用、不改任何加工状态，到此为止
  if (opts.dryRun) {
    report.notes.push(`dry-run: ${queue.items.length} session(s) would be processed (${queue.overflow} overflow, ${queue.quarantined} quarantined)`);
    finish(home, index, report, true);
    return report;
  }

  // 模型：显式给了就用；否则探测一次 /v1/models（§3.3）
  const resolved = await resolveModel(cfg);
  for (const n of resolved.notes) console.log(`[api] note: ${n}`);

  const apiLog = (extra: Record<string, unknown>): void => {
    appendLog(home, 'api', { model: resolved.model, base: cfg.base, ...extra });
  };

  const total = queue.items.length;
  const startedAt = Date.now();
  let transportFails = 0;
  let failed = 0;
  let parseFailed = 0;
  let quarantinedNow = 0;
  let dupTopics = 0;
  let stop: BackendUnavailableError | undefined;

  const mark = (done: number): void => opts.onProgress?.('Processing', done, total);

  let fatal: unknown;
  try {
  for (let i = 0; i < queue.items.length; i++) {
    const item = queue.items[i];
    const t0 = Date.now();
    try {
      const body = readStoredSession(item.path)?.body ?? '';
      // §7.2 注入既有活文档：按会话的 project_fp 取该项目的 active 活文档（无 project 的会话为空）
      const existingDocs = projectDocs(home, item.project_fp);
      const { docs, notes } = await extractWithApi(
        { body, projectFp: item.project_fp, sessionId: item.sessionId, existingDocs },
        cfg,
        resolved.model,
      );
      transportFails = 0;
      for (const n of notes) apiLog({ status: 'response_note', session: item.key, note: n });
      report.candidates += docs.length;
      for (const d of docs) {
        commitDoc(home, config, index, item, d, report, (note) => {
          dupTopics++;
          apiLog({ status: 'possible-duplicate-topic', session: item.key, note });
        });
      }
      // 规则 5 写序：先文件后索引
      const okState = formatApiState({ status: 'ok', prompt: API_PROMPT_VERSION, hash: item.content_hash, count: 0 });
      updateSessionApiState(item.path, okState);
      index.setSessionApiState(item.key, okState);
      mark(i + 1);
    } catch (e) {
      if (e instanceof ApiTransportError) {
        // 规则 3：传输失败不写状态 → 下次自动重试；连续 3 次中止整批（§3.4）
        failed++;
        transportFails++;
        apiLog({ status: 'transport_failed', error: e.message, http_status: e.status, session: item.key, duration_ms: Date.now() - t0 });
        mark(i + 1);
        if (transportFails >= 3) {
          apiLog({ status: 'aborted', consecutive_failures: transportFails });
          stop = endpointUnavailableError(transportFails);
          break;
        }
        continue;
      }
      if (e instanceof ApiParseError) {
        // 规则 4：解析失败计数到 2 即隔离；不计入中止计数。
        // 端点已经返回了正文，连续传输失败在这里断开（§3.4「连续」）。
        transportFails = 0;
        parseFailed++;
        const strikes = item.failCount + 1;
        const nextState = strikes >= 2
          ? formatApiState({ status: 'skip', prompt: API_PROMPT_VERSION, hash: item.content_hash, count: 0 })
          : formatApiState({ status: 'fail', prompt: API_PROMPT_VERSION, hash: item.content_hash, count: strikes });
        updateSessionApiState(item.path, nextState);
        index.setSessionApiState(item.key, nextState);
        if (strikes >= 2) quarantinedNow++;
        apiLog({ status: 'parse_failed', session: item.key, strikes, duration_ms: Date.now() - t0, raw: e.raw.slice(0, 2000) });
        mark(i + 1);
        continue;
      }
      throw e;
    }
  }
  } catch (e) {
    fatal = e;
  }

  report.failed = failed;
  report.parseFailed = parseFailed;
  report.quarantined += quarantinedNow;
  report.elapsedMs = Date.now() - startedAt;
  // 跑完再数：溢出的、传输失败的、尚未隔离的 parse_failed 都还在队列里。
  // 不沿用开跑前的 overflow，否则本批排得下、中间有失败时会报 pending 0。
  const pendingAfter = materializeQueue(index, {
    since: opts.since,
    promptVersion: API_PROMPT_VERSION,
  }).pending;
  report.queuePending = pendingAfter;
  report.duplicateTopics = dupTopics;
  if (!stop && !fatal) {
    // §3.9 汇总分列：parse_failed 与 failed 不混。中止走退出码 2，不打印看起来已经跑完的 done 行。
    console.log(
      `[api] done: written ${report.written.length} · deduped ${report.deduped} · failed ${failed} · parse_failed ${parseFailed} · `
        + `quarantined ${report.quarantined} · elapsed ${formatElapsed(report.elapsedMs)} · pending ${pendingAfter}`,
    );
  }
  // 规则 9：同一次运行就把已吸收会话从 PROCESS.md 待办里去掉。中止前也刷新，已产出留在索引里。
  publishGuide(home, index, false, report, true);
  finish(home, index, report, false);
  if (stop) throw stop;
  if (fatal) throw fatal;
  return report;
}

function readBodyChars(path: string): number {
  return readStoredSession(path)?.body.length ?? 0;
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

function isUnassigned(projectFp: string | undefined): boolean {
  return !projectFp || projectFp === 'unknown';
}

/** §7.2 注入源：该项目的 active 活文档（topic + 全文）。无 project 的会话为空——不做增量合并。 */
function projectDocs(home: string, projectFp: string | undefined): { topic: string; content: string }[] {
  if (isUnassigned(projectFp)) return [];
  return listEntries(home)
    .filter((l) => l.entry.fm.status === 'active' && l.entry.fm.topic && l.entry.fm.project === projectFp)
    .map((l) => ({ topic: l.entry.fm.topic as string, content: l.entry.body }));
}

function activeTopics(home: string): string[] {
  return listEntries(home)
    .filter((l) => l.entry.fm.status === 'active' && l.entry.fm.topic)
    .map((l) => l.entry.fm.topic as string);
}

/** §7.4-3 近似判据：归一化后互为前缀、或去掉分隔符后相同（且不是同一个 topic）。 */
function isNearDupTopic(a: string, b: string): boolean {
  if (a === b) return false;
  const strip = (s: string) => s.replace(/[-_]/g, '');
  return a.startsWith(b) || b.startsWith(a) || strip(a) === strip(b);
}

/**
 * 单份活文档落盘（§7）：topic 收敛 → 自动 supersede（§7.3）→ 证据锚定（§7.1）→ commitEntry。
 * 无 project 的会话只新建 topic：撞上既有 active 时不合并、不覆盖，告警后跳过（O1 边界）。
 * 返回落盘的 topic；跳过/去重返回 null。
 */
function commitDoc(
  home: string,
  config: OmemConfig,
  index: OmemIndex,
  item: QueueItem,
  doc: DocItem,
  report: RunReport,
  warnDup: (note: string) => void,
): string | null {
  const topic = normalizeTopic(doc.topic);
  if (!topic) return null;
  const unassigned = isUnassigned(item.project_fp);
  const active = index.findActiveByTopic(topic);
  let supersedes: string[] = [];
  if (active) {
    if (unassigned) {
      warnDup(`unassigned session ${item.sessionId}: topic ${topic} already active (${active.id}); skipped (only new topics without a project)`);
      return null;
    }
    // §7.3：API 档没有 Agent 在环，supersede 由 omem 自己补，否则每次都被 commitEntry 拒
    supersedes = [active.id];
  } else {
    for (const t of activeTopics(home)) {
      if (isNearDupTopic(topic, t)) {
        warnDup(`new topic ${topic} is suspiciously close to active ${t}; both kept for review`);
        break;
      }
    }
  }
  const scored = scoreApiDoc(home, { sessionId: item.sessionId, evidence: doc.evidence, content: doc.content }, index);
  const result = commitEntry(home, config, index, {
    content: doc.content,
    type: doc.type,
    domain: doc.domain,
    tags: [...doc.tags, ...scored.tags],
    project: unassigned ? undefined : item.project_fp,
    topic,
    evidence: doc.evidence,
    session_id: item.sessionId,
    source: 'llm',
    confidence: scored.confidence,
    verified: false,
    supersedes,
  }, { dryRun: false, refreshIndex: false });
  if ((result.redacted ?? 0) > 0) report.redacted++;
  if (result.status === 'excluded' || result.status === 'redacted-empty') report.excluded++;
  if (result.status === 'deduped') report.deduped++;
  if (result.status === 'written' && result.id) report.written.push(result.id);
  return result.status === 'written' ? topic : null;
}

function emptyReport(tier: Tier): RunReport {
  return {
    tier,
    sessions: 0,
    skipped: 0,
    messages: 0,
    candidates: 0,
    written: [],
    deduped: 0,
    redacted: 0,
    excluded: 0,
    notes: [],
  };
}

function scanHome(config: OmemConfig, index: OmemIndex, opts: RunOpts): ScanResult {
  const since = opts.since ? parseSince(opts.since) : undefined;
  return scanSessions(index, config, {
    since,
    sessionId: opts.sessionId,
    onProgress: opts.onProgress
      ? (done, total) => opts.onProgress!('Scanning sessions', done, total)
      : undefined,
  });
}

/** 把本批变化的对话写入 sessions/，并更新会话索引。 */
function ingest(
  home: string,
  index: OmemIndex,
  digests: SessionDigest[],
  dryRun: boolean,
  report: RunReport,
  onProgress?: (phase: string, done: number, total: number) => void,
): void {
  const total = digests.length;
  for (let i = 0; i < digests.length; i++) {
    const digest = digests[i];
    onProgress?.('Writing sessions', i + 1, total);
    report.sessions++;
    report.messages += digest.messages.length;
    const { body, hash } = prepareDialogue(digest);
    if (dryRun) continue;
    const { path, text, apiState } = writeSessionFile(home, digest, body, hash);
    index.putSession({
      session_id: sessionKey(digest.agent, digest.session_id),
      agent: digest.agent,
      path,
      content_hash: hash,
      api_state: apiState ?? null,
      project_fp: digest.project_fp,
      msg_count: digest.messages.length,
      last_ts: digest.ended_ts,
      processed_at: nowIso(),
    }, text);
  }
}

function publishGuide(home: string, index: OmemIndex, dryRun: boolean, report: RunReport, silent = false): void {
  const [topics, remaining, unassigned, counts] = pendingTopics(home, index);
  report.waitingTopics = counts.topics;
  report.waitingUnassigned = counts.unassigned;
  const text = renderGuide(topics, remaining, unassigned);
  if (!dryRun) {
    const path = writeProcessGuide(home, text);
    report.notes.push(`Processing guide written to ${path}`);
  }
  // 待办清单只写文件。终端由 omem sync 打总结，不把会话路径列出来。
  if (silent) return;
  report.notes.push('Conclusions are written by the Agent via save_memory / omem add after reading PROCESS.md; omem does not call a model');
}

type EntryLoc = ReturnType<typeof listEntries>[number];

function createdOf(loc: EntryLoc): string {
  return loc.entry.fm.created ?? '';
}

/** 一组可能同时存在几份活文档（一个项目可以拆成多个 topic），最新那份作为默认 supersede 对象。 */
function fillDocSlot(topic: GuideTopic, docs: EntryLoc[]): void {
  const sorted = [...docs].sort((a, b) => (createdOf(a) < createdOf(b) ? 1 : -1));
  const newest = sorted[0];
  if (!newest) return;
  topic.docId = newest.entry.fm.id;
  topic.docTitle = deriveTitle(newest.entry.body);
  topic.otherDocs = sorted.length - 1;
}

export function pendingTopics(home: string, index: OmemIndex): [GuideTopic[], number, GuideSessionRef[], { topics: number; unassigned: number }] {
  const absorbed = absorbedSessionIds(home);
  const active = listEntries(home).filter((l) => l.entry.fm.status === 'active');
  // 反查表：会话 → 它产出的活文档。项目分组名是 project_fp，而活文档用 Agent 自己起的 topic，
  // 两者不同命名空间，只能靠「同组里已被吸收的会话 → 当年写出的文档」把待办挂到现实存在的文档上。
  const docBySession = new Map<string, EntryLoc>();
  const remember = (key: string | undefined, loc: EntryLoc): void => {
    if (!key) return;
    const prev = docBySession.get(key);
    if (!prev || createdOf(loc) > createdOf(prev)) docBySession.set(key, loc);
  };
  for (const loc of active) {
    remember(loc.entry.fm.session_id, loc);
    for (const sid of loc.entry.fm.source_sessions) remember(sid, loc);
  }

  const byTopic = new Map<string, GuideTopic>();
  const groupDocs = new Map<string, Map<string, EntryLoc>>();
  const unassigned: GuideSessionRef[] = [];
  for (const rec of index.listSessions()) {
    const { agent, sessionId } = splitSessionKey(rec.session_id);
    const absorbedAlready = absorbed.has(sessionId) || absorbed.has(rec.session_id);
    const project = rec.project_fp || 'unknown';
    if (absorbedAlready) {
      // 已吸收的会话不再是待办，但它是这一组与现实文档的连线：记下它产出的文档。
      const doc = docBySession.get(sessionId) ?? docBySession.get(rec.session_id);
      if (doc && project !== 'unknown') {
        let docs = groupDocs.get(project);
        if (!docs) groupDocs.set(project, (docs = new Map()));
        docs.set(doc.entry.fm.id, doc);
      }
      continue;
    }
    const ref: GuideSessionRef = {
      path: rec.path,
      sessionId,
      agent: rec.agent || agent,
    };
    if (!project || project === 'unknown') {
      unassigned.push(ref);
      continue;
    }
    let topic = byTopic.get(project);
    if (!topic) {
      topic = {
        topic: project,
        docId: undefined,
        docTitle: undefined,
        otherDocs: 0,
        sessions: [],
      };
      byTopic.set(project, topic);
    }
    topic.sessions.push(ref);
  }
  // 分两趟：先收齐全组的连线，再回填文档，避免受 listSessions() 的会话顺序影响。
  for (const [project, topic] of byTopic) {
    const docs = groupDocs.get(project);
    if (docs) fillDocSlot(topic, [...docs.values()]);
  }
  const all = [...byTopic.values()].filter((t) => t.sessions.length > 0);
  return [
    all.slice(0, GUIDE_BATCH),
    Math.max(0, all.length - GUIDE_BATCH),
    unassigned.slice(0, GUIDE_BATCH),
    { topics: all.length, unassigned: unassigned.length },
  ];
}

/** 已写进任一结论的 session_id 或 source_sessions，不再进入待吸收列表。 */
function absorbedSessionIds(home: string): Set<string> {
  const ids = new Set<string>();
  for (const loc of listEntries(home, { includeArchived: true })) {
    const fm = loc.entry.fm;
    if (fm.session_id) ids.add(fm.session_id);
    for (const id of fm.source_sessions) ids.add(id);
  }
  return ids;
}

function finish(home: string, index: OmemIndex, report: RunReport, dryRun: boolean): void {
  if (!dryRun) generateMemoryIndex(home, index);
  appendLog(home, 'run', {
    tier: report.tier,
    sessions: report.sessions,
    messages: report.messages,
    candidates: report.candidates,
    written: report.written.length,
    deduped: report.deduped,
  });
}

const ROOT_ENV: Record<string, string> = {
  'claude-code': 'OMEM_CLAUDE_PROJECTS',
  workbuddy: 'OMEM_WORKBUDDY_PROJECTS',
  cursor: 'OMEM_CURSOR_PROJECTS',
  qwenwork: 'OMEM_QWENWORK_PROJECTS',
};

/** 缺目录只记提示。一个都不存在时返回 false，调用方不再加工。 */
function noteMissingRoots(report: RunReport, scan: ScanResult): boolean {
  for (const r of scan.roots) {
    if (r.exists) continue;
    const env = ROOT_ENV[r.id] ?? 'the corresponding environment variable';
    report.notes.push(`Session directory not found for ${r.id}: ${r.root} (set it via ${env})`);
  }
  return scan.roots.some((r) => r.exists);
}
