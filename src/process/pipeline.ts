// 加工流水线（评估 4.5 加工器）：会话 → 候选 → 条目。
// 顺序：抽取（档 0/2/3）→ 脱敏 → 禁区过滤 → profile 过滤（work 排除代码类）→ content-hash 去重 → 落盘 + 索引。
import type { OmemConfig, Tier } from '../core/config.js';
import type { OmemIndex } from '../core/index.js';
import type { Entry } from '../core/entry.js';
import { newFrontmatter } from '../core/entry.js';
import { writeEntry } from '../core/store.js';
import { contentHash, nowIso, newId, parseSince } from '../core/util.js';
import { redactSecrets } from '../core/redact.js';
import { currentProfile, isCodeHeavy } from '../core/profile.js';
import { generateMemoryIndex, applySupersedes } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';
import { scanSessions } from '../collect/collector.js';
import { extractFromDigest } from './rules.js';
import { printGuide } from './guide.js';
import { extractWithApi, apiConfigured, apiSetupHint } from './api.js';
import type { Candidate } from './rules.js';
import type { SessionDigest } from '../collect/types.js';

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
    report.notes.push('采集已暂停（omem resume 恢复）');
    return report;
  }

  const since = opts.since ? parseSince(opts.since) : undefined;
  const scan = scanSessions(index, config, { since, sessionId: opts.sessionId });
  report.skipped = scan.skipped;
  if (!scan.rootExists) {
    report.notes.push(`未找到 Claude Code 会话目录: ${scan.root}（可用 OMEM_CLAUDE_PROJECTS 指定）`);
    return report;
  }

  // ── 档 2：Agent 协作（打印引导，不落盘） ──
  if (tier === 'agent') {
    printGuide(scan.digests);
    report.sessions = scan.digests.length;
    report.messages = scan.digests.reduce((n, d) => n + d.messages.length, 0);
    report.notes.push('已打印加工引导；请由 Agent 提炼后调 save_memory / omem add 回写');
    return report;
  }

  for (const digest of scan.digests) {
    report.sessions++;
    report.messages += digest.messages.length;
    const candidates = extractFromDigest(digest);
    report.candidates += candidates.length;
    for (const c of candidates) {
      const outcome = commitCandidate(home, config, index, c, digest, opts.dryRun ?? false, report);
      if (outcome) report.written.push(outcome);
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
    report.notes.push('采集已暂停（omem resume 恢复）');
    return report;
  }
  if (!apiConfigured()) throw new Error(apiSetupHint());

  const since = opts.since ? parseSince(opts.since) : undefined;
  const scan = scanSessions(index, config, { since, sessionId: opts.sessionId });
  report.skipped = scan.skipped;
  if (!scan.rootExists) {
    report.notes.push(`未找到 Claude Code 会话目录: ${scan.root}`);
    return report;
  }
  for (const digest of scan.digests) {
    report.sessions++;
    report.messages += digest.messages.length;
    const candidates = await extractWithApi(digest);
    report.candidates += candidates.length;
    for (const c of candidates) {
      const outcome = commitCandidate(home, config, index, c, digest, opts.dryRun ?? false, report);
      if (outcome) report.written.push(outcome);
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

/** 单候选 → 条目：脱敏 / 过滤 / 去重 / 落盘。返回新条目 id 或 null（跳过）。 */
function commitCandidate(
  home: string,
  config: OmemConfig,
  index: OmemIndex,
  c: Candidate,
  digest: SessionDigest,
  dryRun: boolean,
  report: RunReport,
): string | null {
  // 1. 脱敏
  const { text, hits } = redactSecrets(c.content);
  if (hits > 0) {
    report.redacted++;
    if (!text.replace(/[*REDACTED*]/g, '').trim()) {
      report.excluded++;
      return null; // 整条都是密钥，丢弃
    }
  }

  // 2. 禁区关键词
  for (const kw of config.collect.exclude_keywords) {
    if (kw && text.includes(kw)) {
      report.excluded++;
      return null;
    }
  }

  // 3. work profile 排除代码类条目
  const profile = currentProfile(config);
  if (profile === 'work' && isCodeHeavy(text)) {
    report.excluded++;
    return null;
  }

  // 4. content-hash 去重（双通道/重复加工的保证）
  const hash = contentHash(text);
  if (index.getByBodyHash(hash)) {
    report.deduped++;
    return null;
  }

  if (dryRun) return null;

  // 5. 落盘 + 索引
  const entry: Entry = {
    fm: newFrontmatter({
      id: newId(text + digest.session_id),
      type: c.type,
      domain: c.domain,
      profile,
      status: 'active',
      confidence: c.confidence,
      verified: false, // 自动加工产物恒为未验证（规格 §2.2）
      source: c.source,
      session_id: c.session_id,
      project: c.project_fp,
      tags: c.tags,
    }),
    body: text,
  };
  const { path, content } = writeEntry(home, entry);
  const located = { entry, path, location: 'knowledge' as const };
  index.upsert(entry, path, content);
  applySupersedes(home, index, located);
  return entry.fm.id;
}
