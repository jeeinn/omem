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
  sessionKey,
  splitSessionKey,
  writeSessionFile,
} from '../collect/session-store.js';
import type { SessionDigest } from '../collect/types.js';
import { GUIDE_BATCH, renderGuide, writeProcessGuide, type GuideSessionRef, type GuideTopic } from './guide.js';
import { extractWithApi, apiConfigured, apiSetupHint } from './api.js';
import type { Candidate } from './rules.js';

export interface RunOpts {
  since?: string; // '7d' | 'YYYY-MM-DD'
  sessionId?: string;
  /** 命令行显式传入的档位。缺省时不把 config 里的 rules 当成自动抽取。 */
  tier?: Tier;
  dryRun?: boolean;
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

/** 档 3 的异步版本（API 加工需要网络调用）。原文仍先落盘。 */
export async function runPipelineAsync(home: string, config: OmemConfig, index: OmemIndex, opts: RunOpts = {}): Promise<RunReport> {
  const { tier } = resolveTier(config, opts.tier ?? 'api');
  if (tier !== 'api') return runPipeline(home, config, index, opts);

  const report = emptyReport('api');
  if (config.general.paused) {
    report.notes.push('Collection paused (run omem resume to resume)');
    return report;
  }
  if (!apiConfigured()) throw new Error(apiSetupHint());

  const scan = scanHome(config, index, opts);
  report.skipped = scan.skipped;
  if (!noteMissingRoots(report, scan)) return report;
  ingest(home, index, scan.digests, opts.dryRun ?? false, report);
  for (const digest of scan.digests) {
    const candidates = await extractWithApi(digest);
    report.candidates += candidates.length;
    for (const c of candidates) commitCandidate(home, config, index, c, opts.dryRun ?? false, report);
  }
  finish(home, index, report, opts.dryRun ?? false);
  return report;
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
    const { path, text } = writeSessionFile(home, digest, body, hash);
    index.putSession({
      session_id: sessionKey(digest.agent, digest.session_id),
      agent: digest.agent,
      path,
      content_hash: hash,
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

export function pendingTopics(home: string, index: OmemIndex): [GuideTopic[], number, GuideSessionRef[]] {
  const absorbed = absorbedSessionIds(home);
  const active = listEntries(home).filter((l) => l.entry.fm.status === 'active');
  const byTopic = new Map<string, GuideTopic>();
  const unassigned: GuideSessionRef[] = [];
  for (const rec of index.listSessions()) {
    const { agent, sessionId } = splitSessionKey(rec.session_id);
    if (absorbed.has(sessionId) || absorbed.has(rec.session_id)) continue;
    const ref: GuideSessionRef = {
      path: rec.path,
      sessionId,
      agent: rec.agent || agent,
    };
    const project = rec.project_fp || 'unknown';
    if (!project || project === 'unknown') {
      unassigned.push(ref);
      continue;
    }
    let topic = byTopic.get(project);
    if (!topic) {
      const doc = active.find((l) => l.entry.fm.topic === project);
      topic = {
        topic: project,
        docId: doc?.entry.fm.id,
        docTitle: doc ? deriveTitle(doc.entry.body) : undefined,
        sessions: [],
      };
      byTopic.set(project, topic);
    }
    topic.sessions.push(ref);
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
