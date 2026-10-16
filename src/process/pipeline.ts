// 加工流水线（评估 4.5 加工器）：会话 → 候选 → 条目。
// 顺序：抽取（档 0/2/3）→ 脱敏 → 禁区过滤 → profile 过滤（work 排除代码类）→ content-hash 去重 → 落盘 + 索引。
import type { OmemConfig, Tier } from '../core/config.js';
import type { OmemIndex } from '../core/index.js';
import { nowIso, parseSince } from '../core/util.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';
import { commitEntry } from '../core/commit.js';
import { scanSessions, type ScanResult } from '../collect/collector.js';
import { extractFromDigest } from './rules.js';
import { printGuide } from './guide.js';
import { extractWithApi, apiConfigured, apiSetupHint } from './api.js';
import type { Candidate } from './rules.js';

export interface RunOpts {
  since?: string; // '7d' | 'YYYY-MM-DD'
  sessionId?: string;
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

export function runPipeline(home: string, config: OmemConfig, index: OmemIndex, opts: RunOpts = {}): RunReport {
  const tier: Tier = opts.tier ?? config.process.default_tier;
  const report: RunReport = {
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

  if (config.general.paused) {
    report.notes.push('Collection paused (run omem resume to resume)');
    return report;
  }

  const since = opts.since ? parseSince(opts.since) : undefined;
  const scan = scanSessions(index, config, { since, sessionId: opts.sessionId });
  report.skipped = scan.skipped;
  if (!noteMissingRoots(report, scan)) return report;

  // ── 档 2：Agent 协作（打印引导，不落盘） ──
  if (tier === 'agent') {
    printGuide(scan.digests);
    report.sessions = scan.digests.length;
    report.messages = scan.digests.reduce((n, d) => n + d.messages.length, 0);
    report.notes.push('Processing guide printed; have the Agent distill it and write back via save_memory / omem add');
    return report;
  }

  for (const digest of scan.digests) {
    report.sessions++;
    report.messages += digest.messages.length;
    const candidates = extractFromDigest(digest);
    report.candidates += candidates.length;
    for (const c of candidates) {
      commitCandidate(home, config, index, c, opts.dryRun ?? false, report);
    }
    if (!opts.dryRun) {
      index.putSession({
        session_id: digest.session_id,
        project_fp: digest.project_fp,
        msg_count: digest.messages.length,
        last_ts: digest.ended_ts,
        processed_at: nowIso(),
      });
    }
  }

  if (!opts.dryRun) generateMemoryIndex(home, index);
  appendLog(home, 'run', {
    tier,
    sessions: report.sessions,
    messages: report.messages,
    candidates: report.candidates,
    written: report.written.length,
    deduped: report.deduped,
  });
  return report;
}

/** 档 3 的异步版本（API 加工需要网络调用）。 */
export async function runPipelineAsync(home: string, config: OmemConfig, index: OmemIndex, opts: RunOpts = {}): Promise<RunReport> {
  const tier: Tier = opts.tier ?? config.process.default_tier;
  if (tier !== 'api') return runPipeline(home, config, index, opts);

  const report: RunReport = {
    tier, sessions: 0, skipped: 0, messages: 0, candidates: 0,
    written: [], deduped: 0, redacted: 0, excluded: 0, notes: [],
  };
  if (config.general.paused) {
    report.notes.push('Collection paused (run omem resume to resume)');
    return report;
  }
  if (!apiConfigured()) throw new Error(apiSetupHint());

  const since = opts.since ? parseSince(opts.since) : undefined;
  const scan = scanSessions(index, config, { since, sessionId: opts.sessionId });
  report.skipped = scan.skipped;
  if (!noteMissingRoots(report, scan)) return report;
  for (const digest of scan.digests) {
    report.sessions++;
    report.messages += digest.messages.length;
    const candidates = await extractWithApi(digest);
    report.candidates += candidates.length;
    for (const c of candidates) {
      commitCandidate(home, config, index, c, opts.dryRun ?? false, report);
    }
    if (!opts.dryRun) {
      index.putSession({
        session_id: digest.session_id,
        project_fp: digest.project_fp,
        msg_count: digest.messages.length,
        last_ts: digest.ended_ts,
        processed_at: nowIso(),
      });
    }
  }
  if (!opts.dryRun) generateMemoryIndex(home, index);
  appendLog(home, 'run', { tier: 'api', sessions: report.sessions, written: report.written.length });
  return report;
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
