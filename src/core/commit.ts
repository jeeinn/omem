// 统一写入（改进计划 P0-2）：add / save_memory / pipeline 的唯一提交点。
// 顺序：脱敏 → work 代码密度 → content-hash 去重 → 落盘 → upsert → 可选刷新热层 → 日志。
// force 只跳过代码密度；脱敏与去重不跳过。refreshIndex 默认 true，批量加工传 false。
import type { OmemConfig } from './config.js';
import type { OmemIndex } from './index.js';
import type { Entry, EntrySource, MemoryType, Profile } from './entry.js';
import { newFrontmatter } from './entry.js';
import { findById, writeEntry } from './store.js';
import { contentHash, newId } from './util.js';
import { redactSecrets } from './redact.js';
import { currentProfile, isCodeHeavy } from './profile.js';
import { applySupersedes, generateMemoryIndex } from './lifecycle.js';
import { appendLog } from './log.js';
import { inferDomain } from '../process/rules.js';
import { refreshProcessGuide } from '../process/guide.js';

export interface CommitInput {
  content: string;
  type: MemoryType;
  domain?: string;
  tags?: string[];
  project?: string;
  topic?: string;
  session_id?: string;
  source_sessions?: string[];
  /** 证据锚定原文（文档 §7.2）：落盘保留原文，归一化只用于比对。 */
  evidence?: string[];
  source: EntrySource;
  confidence: number;
  verified: boolean;
  supersedes?: string[];
  profile?: Profile;
}

export interface CommitOpts {
  dryRun?: boolean;
  /** 默认 true。pipeline 传 false，整次 run 结束再刷一次热层。 */
  refreshIndex?: boolean;
  /**
   * 默认 true。写入成功后重算 PROCESS.md（待吸收会话清单）。
   * pipeline 批量加工时传 false——它自己在一轮结束时统一刷新一次。
   */
  refreshGuide?: boolean;
  /** 只跳过禁区关键词与代码密度。 */
  force?: boolean;
}

export type CommitStatus = 'written' | 'deduped' | 'excluded' | 'redacted-empty';

export interface CommitResult {
  status: CommitStatus;
  id?: string;
  path?: string;
  redacted?: number;
  /** dry-run 且本应落盘时为 true；此时没有 id / path。 */
  dryRun?: boolean;
  reason?: string;
}

/** 脱敏后只剩下供应商前缀和占位符，视为整条都是密钥。 */
export function isRedactionShell(text: string): boolean {
  const core = text
    .replace(/sk-ant-|sk-|AKIA|PEM|gh\*_|jwt/gi, '')
    .replace(/\*+REDACTED\*+/gi, '')
    .replace(/[\s\-→*]/g, '');
  return core.length === 0;
}

function logOutcome(home: string, status: CommitStatus, extra: Record<string, unknown>): void {
  appendLog(home, 'commit', { status, ...extra });
}

/**
 * 重写 PROCESS.md。清单是派生物，刷不动不该让已经落盘的记忆变成失败——
 * 记忆已经写好了，丢掉它才是真的损失。所以这里吞掉异常，只记日志。
 */
function refreshGuide(home: string, index: OmemIndex): void {
  try {
    refreshProcessGuide(home, index);
  } catch (err) {
    appendLog(home, 'commit', { status: 'written', guide_refresh_failed: (err as Error).message });
  }
}

export function commitEntry(
  home: string,
  config: OmemConfig,
  index: OmemIndex,
  input: CommitInput,
  opts: CommitOpts = {},
): CommitResult {
  const raw = input.content.trim();
  if (!raw) return finish(home, { status: 'excluded', reason: 'Content is empty' }, input, opts);

  const { text, hits } = redactSecrets(raw);
  const redacted = hits > 0 ? hits : undefined;
  if (hits > 0 && isRedactionShell(text)) {
    return finish(home, { status: 'redacted-empty', redacted, reason: 'Entire entry is a secret; discarded' }, input, opts);
  }

  const profile = input.profile ?? currentProfile(config);
  if (!opts.force) {
    if (profile === 'work' && isCodeHeavy(text)) {
      return finish(home, { status: 'excluded', redacted, reason: 'Code-heavy entries excluded under work profile' }, input, opts);
    }
  }

  const dup = index.getByBodyHash(contentHash(text));
  if (dup) {
    return finish(home, { status: 'deduped', id: dup.id, redacted, reason: 'Content already exists' }, input, opts);
  }

  const supersedes = (input.supersedes ?? []).map((s) => s.trim()).filter(Boolean);
  const missing = supersedes.filter((id) => !findById(home, id, { includeArchived: true }));
  if (missing.length > 0) {
    return finish(home, { status: 'excluded', redacted, reason: `Old entries not found: ${missing.join(', ')}` }, input, opts);
  }

  const topic = resolveTopic(input);
  if (topic) {
    const active = index.findActiveByTopic(topic);
    if (active && !supersedes.includes(active.id)) {
      return finish(home, {
        status: 'excluded',
        id: active.id,
        redacted,
        reason: `Topic "${topic}" already has an active document ${active.id}. Pass --supersedes ${active.id} (or supersedes: ["${active.id}"]) to update it. --force does not bypass this.`,
      }, input, opts);
    }
  }

  if (opts.dryRun) {
    return { status: 'written', redacted, dryRun: true, reason: 'dry-run' };
  }

  const entry: Entry = {
    fm: newFrontmatter({
      id: newId(text + (input.session_id ?? '')),
      type: input.type,
      domain: input.domain || inferDomain(text),
      profile,
      status: 'active',
      confidence: input.confidence,
      verified: input.verified,
      source: input.source,
      session_id: input.session_id,
      project: input.project,
      topic,
      source_sessions: collectSourceSessions(home, input, supersedes),
      evidence: input.evidence ?? [],
      tags: input.tags ?? [],
      supersedes,
    }),
    body: text,
  };
  const written = writeEntry(home, entry);
  const located = { entry, path: written.path, location: 'knowledge' as const };
  index.upsert(entry, written.path, written.content);
  if (supersedes.length > 0) applySupersedes(home, index, located);
  if (opts.refreshIndex !== false) generateMemoryIndex(home, index);
  // 吸收了会话就要把 PROCESS.md 里的待办减掉。save_memory 走 MCP，不经过
  // omem sync，清单原本只会在采集路径上重算——Agent 会读到已吸收的旧待办。
  if (opts.refreshGuide !== false) refreshGuide(home, index);
  logOutcome(home, 'written', { id: entry.fm.id, source: input.source, redacted: hits, supersedes });
  return { status: 'written', id: entry.fm.id, path: written.path, redacted };
}

function resolveTopic(input: CommitInput): string | undefined {
  // 只有调用方显式给了 topic 才成活文档。project 只用于归组，不在这里回落。
  if (!input.topic?.trim()) return undefined;
  return normalizeTopic(input.topic);
}

/** 小写，空白收成连字符，避免热层把「knee rehab」切成两个标签。 */
export function normalizeTopic(raw: string): string | undefined {
  const topic = raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return topic || undefined;
}

/** 新文档继承被取代文档的会话，并加上本次写回的会话。 */
function collectSourceSessions(home: string, input: CommitInput, supersedes: string[]): string[] {
  const ids = new Set<string>();
  const add = (id?: string) => {
    const v = id?.trim();
    if (v) ids.add(v);
  };
  add(input.session_id);
  for (const id of input.source_sessions ?? []) add(id);
  for (const oldId of supersedes) {
    const old = findById(home, oldId, { includeArchived: true });
    if (!old) continue;
    add(old.entry.fm.session_id);
    for (const id of old.entry.fm.source_sessions) add(id);
  }
  return [...ids];
}

function finish(home: string, result: CommitResult, input: CommitInput, opts: CommitOpts): CommitResult {
  if (!opts.dryRun) {
    logOutcome(home, result.status, { id: result.id, source: input.source, redacted: result.redacted ?? 0, reason: result.reason });
  }
  return result;
}
