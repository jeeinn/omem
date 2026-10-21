// 加工流水线：先把对话写入 sessions/，再按档位处理。
// 默认档 agent 只写原文和 PROCESS.md。规则抽取已移除，不再写入 knowledge。
import type { OmemConfig, Tier } from '../core/config.js';
import type { OmemIndex } from '../core/index.js';
import { nowIso, parseSince } from '../core/util.js';
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
} from './api.js';
import { materializeQueue, formatApiState, API_PROMPT_VERSION } from './queue.js';
import type { Candidate } from './rules.js';

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
}

/** 显式 --tier 优先。rules 已从产品路径移除，残留配置按 agent 处理。 */
export function resolveTier(config: OmemConfig, explicit?: Tier): { tier: Tier } {
  const requested = explicit ?? config.process.default_tier;
  return { tier: requested === 'rules' ? 'agent' : requested };
}

export function runPipeline(home: string, config: OmemConfig, index: OmemIndex, opts: RunOpts = {}): RunReport {
  const { tier } = resolveTier(config, opts.tier);
  const report = emptyReport(tier);
  if (config.general.paused) {
    report.notes.push('Collection paused (run omem resume to resume)');
    return report;
  }

  const scan = scanHome(config, index, opts);
  report.skipped = scan.skipped;
  if (!noteMissingRoots(report, scan)) return report;
  ingest(home, index, scan.digests, opts.dryRun ?? false, report);
  publishGuide(home, index, opts.dryRun ?? false, report);
  finish(home, index, report, opts.dryRun ?? false);
  return report;
}

/** 档 3 的异步版本（API 加工需要网络调用）。原文仍先落盘；加工走 §3.5 工作队列。 */
export async function runPipelineAsync(home: string, config: OmemConfig, index: OmemIndex, opts: RunOpts = {}): Promise<RunReport> {
  const { tier } = resolveTier(config, opts.tier ?? 'api');
  if (tier !== 'api') return runPipeline(home, config, index, opts);

  const report = emptyReport('api');
  if (config.general.paused) {
    report.notes.push('Collection paused (run omem resume to resume)');
    return report;
  }
  // §6.2：策略/配置错误抛 UsageError（exit 1），不再用裸 Error
  const cfg = resolveApiConfig(config, process.env, {
    base: opts.apiBase,
    model: opts.apiModel,
    limit: opts.apiLimit,
  });

  const scan = scanHome(config, index, opts);
  report.skipped = scan.skipped;
  if (!noteMissingRoots(report, scan)) return report;
  ingest(home, index, scan.digests, opts.dryRun ?? false, report);

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

  const isTty = Boolean(process.stdout.isTTY);
  const total = queue.items.length;
  const startedAt = Date.now();
  let transportFails = 0;
  let failed = 0;
  let parseFailed = 0;
  let quarantinedNow = 0;

  const progress = (i: number, line: string): void => {
    if (isTty) {
      process.stdout.write(`\r\x1b[2K${line}`);
    } else if (i % 10 === 0 || i === total) {
      console.log(line);
    }
  };

  for (let i = 0; i < queue.items.length; i++) {
    const item = queue.items[i];
    const t0 = Date.now();
    const short = item.sessionId.slice(0, 8);
    try {
      const body = readStoredSession(item.path)?.body ?? '';
      const candidates = await extractWithApi(
        { body, projectFp: item.project_fp, sessionId: item.sessionId },
        cfg,
        resolved.model,
      );
      transportFails = 0;
      report.candidates += candidates.length;
      for (const c of candidates) commitCandidate(home, config, index, c, false, report);
      // 规则 5 写序：先文件后索引
      const okState = formatApiState({ status: 'ok', prompt: API_PROMPT_VERSION, hash: item.content_hash, count: 0 });
      updateSessionApiState(item.path, okState);
      index.setSessionApiState(item.key, okState);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      progress(i + 1, `[api] ${i + 1}/${total}  session ${short}…  →  ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}${candidates.length === 0 ? ' (nothing kept)' : ''}${' '.repeat(Math.max(1, 28 - short.length))}${secs}s`);
    } catch (e) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (e instanceof ApiTransportError) {
        // 规则 3：传输失败不写状态 → 下次自动重试；连续 3 次中止整批（§3.4）
        failed++;
        transportFails++;
        apiLog({ status: 'transport_failed', error: e.message, http_status: e.status, session: item.key, duration_ms: Date.now() - t0 });
        progress(i + 1, `[api] ${i + 1}/${total}  session ${short}…  →  failed: ${e.message} (logged, continue)${' '.repeat(Math.max(1, 8))}${secs}s`);
        if (transportFails >= 3) {
          if (isTty) process.stdout.write('\n');
          apiLog({ status: 'aborted', consecutive_failures: transportFails });
          throw endpointUnavailableError(transportFails);
        }
        continue;
      }
      if (e instanceof ApiParseError) {
        // 规则 4：解析失败计数到 2 即隔离；不计入中止计数
        parseFailed++;
        const strikes = item.failCount + 1;
        const nextState = strikes >= 2
          ? formatApiState({ status: 'skip', prompt: API_PROMPT_VERSION, hash: item.content_hash, count: 0 })
          : formatApiState({ status: 'fail', prompt: API_PROMPT_VERSION, hash: item.content_hash, count: strikes });
        updateSessionApiState(item.path, nextState);
        index.setSessionApiState(item.key, nextState);
        if (strikes >= 2) quarantinedNow++;
        apiLog({ status: 'parse_failed', session: item.key, strikes, duration_ms: Date.now() - t0, raw: e.raw.slice(0, 2000) });
        progress(i + 1, `[api] ${i + 1}/${total}  session ${short}…  →  parse_failed (raw in log; ${strikes}${strikes === 2 ? 'nd' : strikes === 1 ? 'st' : 'th'} strike${strikes >= 2 ? ' → quarantined' : ''})${' '.repeat(Math.max(1, 4))}${secs}s`);
        continue;
      }
      throw e;
    }
  }
  if (isTty && total > 0) process.stdout.write('\n');

  report.failed = failed;
  report.parseFailed = parseFailed;
  report.quarantined += quarantinedNow;
  report.elapsedMs = Date.now() - startedAt;
  // §3.9 汇总分列：parse_failed 与 failed 不混
  console.log(
    `[api] done: written ${report.written.length} · deduped ${report.deduped} · failed ${failed} · parse_failed ${parseFailed} · `
      + `quarantined ${report.quarantined} · elapsed ${formatElapsed(report.elapsedMs)} · pending ${queue.overflow}`,
  );
  finish(home, index, report, false);
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
  return scanSessions(index, config, { since, sessionId: opts.sessionId });
}

/** 把本批变化的对话写入 sessions/，并更新会话索引。 */
function ingest(
  home: string,
  index: OmemIndex,
  digests: SessionDigest[],
  dryRun: boolean,
  report: RunReport,
): void {
  for (const digest of digests) {
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

function publishGuide(home: string, index: OmemIndex, dryRun: boolean, report: RunReport): void {
  const [topics, remaining, unassigned] = pendingTopics(home, index);
  const text = renderGuide(topics, remaining, unassigned);
  if (!dryRun) {
    const path = writeProcessGuide(home, text);
    report.notes.push(`Processing guide written to ${path}`);
  }
  console.log(text);
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

export function pendingTopics(home: string, index: OmemIndex): [GuideTopic[], number, GuideSessionRef[]] {
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
  return [all.slice(0, GUIDE_BATCH), Math.max(0, all.length - GUIDE_BATCH), unassigned.slice(0, GUIDE_BATCH)];
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

/** 单候选走 commitEntry。热层由 run 结束时统一刷新。 */
function commitCandidate(
  home: string,
  config: OmemConfig,
  index: OmemIndex,
  c: Candidate,
  dryRun: boolean,
  report: RunReport,
): void {
  const result = commitEntry(home, config, index, {
    content: c.content,
    type: c.type,
    domain: c.domain,
    tags: c.tags,
    project: c.project_fp,
    session_id: c.session_id,
    source: c.source,
    confidence: c.confidence,
    verified: false,
  }, { dryRun, refreshIndex: false });
  if ((result.redacted ?? 0) > 0) report.redacted++;
  if (result.status === 'excluded' || result.status === 'redacted-empty') report.excluded++;
  if (result.status === 'deduped') report.deduped++;
  if (result.status === 'written' && result.id) report.written.push(result.id);
}
