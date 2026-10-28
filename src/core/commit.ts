// 统一写入（改进计划 P0-2）：add / save_memory / pipeline 的唯一提交点。
// 顺序：脱敏 → work 代码密度 → content-hash 去重 → 落盘 → upsert → 可选刷新热层 → 日志。
// force 只跳过代码密度；脱敏与去重不跳过。refreshIndex 默认 true，批量加工传 false。
import type { OmemConfig } from './config.js';
import type { OmemIndex } from './index.js';
import type { Entry, EntrySource, MemoryType, Profile } from './entry.js';
import { isNearDupTopic, mergeEvidence, newFrontmatter, normalizeDomain } from './entry.js';
import { ASSENT_CAP } from './lifecycle.js';
import { loadTopicPolicies } from './review-policy.js';
import { findById, writeEntry } from './store.js';
import type { Located } from './store.js';
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
  /**
   * 调用方类别。默认 'cli' 保持向后兼容。
   * 为什么需要：同一句冲突提示要按调用方生成——MCP 侧没有 `--force` 参数，
   * 也没有命令行，把 CLI 语法塞进去等于给 Agent 一条执行不了的指令。
   */
  caller?: 'mcp' | 'cli';
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
  /**
   * 调用方附加的审计字段，原样并入 commit 日志事件。
   * MCP 侧用它带出锚定归因（confidence / tags / session_found / anchors）——
   * 审计链路要能回答「这条当时锚没锚上」，光看落盘的 confidence 数值回答不了。
   */
  audit?: Record<string, unknown>;
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
  /**
   * 非致命提醒：写入成功，但这件事值得让调用方知道（跨 topic 合并、近似 topic、
   * 误把项目分组名当主题）。不拒绝写入——拒绝会打断 Agent 的写回流程。
   */
  warnings?: string[];
  /**
   * 命中 content-hash 去重时，既有条目的元数据。
   * 调用方据此判断「请求的 topic/type 与既有文档是否不一致」——不一致时要能说出来，
   * 否则元数据被静默丢弃，响应还读起来像成功。
   */
  existing?: { topic?: string; type: string; tags: string[] };
}

/**
 * 请求的元数据与既有（去重命中的）文档之间的差异，供 CLI 与 MCP 共用。
 * 两边各自手写一遍比对逻辑必然漂移（同一处此前就漏了 tags），所以口径收在这里：
 * 返回人类可读的差异片段，调用方只负责按自己的受众拼句子。
 */
export function metadataDrift(
  existing: CommitResult['existing'],
  requested: { topic?: string; type?: string; tags?: string[] },
): string[] {
  if (!existing) return [];
  const diffs: string[] = [];
  const wantedTopic = requested.topic?.trim() ? normalizeTopic(requested.topic) : undefined;
  if (wantedTopic && wantedTopic !== existing.topic) {
    diffs.push(`topic "${wantedTopic}" vs stored ${existing.topic ? `"${existing.topic}"` : 'none'}`);
  }
  if (requested.type && existing.type !== requested.type) {
    diffs.push(`type "${requested.type}" vs stored "${existing.type}"`);
  }
  const wantedTags = (requested.tags ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (wantedTags.length > 0) {
    const stored = new Set(existing.tags);
    const missing = wantedTags.filter((t) => !stored.has(t));
    if (missing.length > 0) diffs.push(`tags [${missing.join(', ')}] not on the stored entry`);
  }
  return diffs;
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
    return finish(home, {
      status: 'deduped',
      id: dup.id,
      redacted,
      reason: 'Content already exists',
      // 去重命中时把既有元数据带回去：调用方要判断请求的 topic/type 是否与既有一致。
      existing: { topic: dup.topic ?? undefined, type: dup.type, tags: (dup.tags ?? '').split(/\s+/).filter(Boolean) },
    }, input, opts);
  }

  const supersedes = (input.supersedes ?? []).map((s) => s.trim()).filter(Boolean);
  // 提前解析 topic：supersedes 落空时的提示要用它给出「该主题现在的活文档是谁」。
  const topic = resolveTopic(input);
  // 一次遍历同时完成「存在性校验」和「继承所需的数据」，避免对同一批 id 反复 findById。
  const oldEntries: Located[] = [];
  const missing: string[] = [];
  for (const id of supersedes) {
    const loc = findById(home, id, { includeArchived: true });
    if (loc) oldEntries.push(loc);
    else missing.push(id);
  }
  if (missing.length > 0) {
    return finish(home, {
      status: 'excluded',
      redacted,
      reason: `Old entries not found: ${missing.join(', ')}. It may be mistyped, already superseded, or in another profile.${missingHint(index, topic, input.caller)}`,
    }, input, opts);
  }

  const warnings: string[] = [];
  // `once` 策略：该主题被人工审过之后，后续版本自动落 assent（提底 0.8、不设 verified），
  // 于是不再回到 review 队列。低置信或未锚定的条目不参与——那是安全阀，必须留给人看。
  const policy = topic ? loadTopicPolicies(home).get(topic) : undefined;
  const lowTrust = input.confidence <= 0.35 || (input.tags ?? []).includes('ungrounded');
  const autoAssent =
    policy === 'once' && Boolean(topic) && !lowTrust && index.topicReviewedBefore(topic as string);
  if (topic) {
    const active = index.findActiveByTopic(topic);
    if (active && !supersedes.includes(active.id)) {
      // 按 caller 生成「下一步」：MCP 侧没有 --force 参数，也没有命令行，
      // 把 CLI 语法塞进 MCP 响应等于给 Agent 一条执行不了的指令。
      const next = input.caller === 'mcp'
        ? `Pass supersedes: ["${active.id}"] to update it.`
        : `Pass --supersedes ${active.id} (or supersedes: ["${active.id}"]) to update it. --force does not bypass this.`;
      return finish(home, {
        status: 'excluded',
        id: active.id,
        redacted,
        reason: `Topic "${topic}" already has an active document ${active.id}. ${next}`,
      }, input, opts);
    }
    // 只在新建主题时查近似：命中不拒绝（拒绝会让 Agent 卡住），而是提示它
    // 改用既有主题 + supersedes。此前只有 API 档做这个检查。
    if (!active) {
      const near = index.activeTopics().find((t) => isNearDupTopic(topic, t));
      if (near) {
        // 两个方向都要说清：只说「写进去」会把「本来就该是两个主题」的情况也诱导成合并。
        warnings.push(
          `Topic "${topic}" is close to existing "${near}". If they describe the same subject, write into "${near}" with supersedes instead of starting a second living document; if they are different subjects, keep the new topic and ignore this warning.`,
        );
      }
    }
  }

  // 跨主题合并：被取代的旧文档属于别的主题时，那些主题名此后不再出现在检索结果里
  // （旧文件置 superseded，默认查询排除）。合并是合法操作，但必须让操作者知道。
  if (supersedes.length > 0) {
    const retired = new Map<string, string>();
    for (const old of oldEntries) {
      const oldTopic = old.entry.fm.topic;
      if (oldTopic && oldTopic !== topic) retired.set(oldTopic, old.entry.fm.id);
    }
    if (retired.size > 0) {
      const names = [...retired.keys()].join(', ');
      // MCP 侧没有 omem topic list / omem search --all，给 CLI 命令等于空话。
      const where = (topicName?: string): string => (input.caller === 'mcp'
        ? `search_memory(topic="${topicName ?? '<name>'}") shows where it went.`
        : `\`omem topic list --all\` shows where it went.`);
      warnings.push(
        topic
          ? `Merged ${retired.size} topic(s) into "${topic}": ${names}. Those names stop resolving in search; ${where()}`
          : `Superseded ${retired.size} topic(s) without giving the new document a topic: ${names}. The topic is now only reachable with \`status\` including superseded entries.`,
      );
    }
  }

  if (opts.dryRun) {
    return { status: 'written', redacted, dryRun: true, reason: 'dry-run', warnings };
  }

  const entry: Entry = {
    fm: newFrontmatter({
      id: newId(text + (input.session_id ?? '')),
      type: input.type,
      domain: normalizeDomain(input.domain || inferDomain(text)),
      profile,
      status: 'active',
      confidence: autoAssent ? Math.max(input.confidence, ASSENT_CAP) : input.confidence,
      verified: input.verified,
      source: input.source,
      session_id: input.session_id,
      project: input.project,
      topic,
      source_sessions: collectSourceSessions(input, oldEntries),
      evidence: mergeEvidence(input.evidence ?? [], oldEntries.map((l) => l.entry.fm.evidence ?? [])),
      tags: autoAssent ? [...new Set([...(input.tags ?? []), 'assent'])] : (input.tags ?? []),
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
  logOutcome(home, 'written', { id: entry.fm.id, source: input.source, redacted: hits, supersedes, ...opts.audit });
  return { status: 'written', id: entry.fm.id, path: written.path, redacted, warnings };
}

function resolveTopic(input: CommitInput): string | undefined {
  // 只有调用方显式给了 topic 才成活文档。project 只用于归组，不在这里回落。
  if (!input.topic?.trim()) return undefined;
  return normalizeTopic(input.topic);
}

/**
 * supersedes 指向不存在的 id 时的补充线索。
 * 调用方多半同时知道 topic——那就直接告诉它该主题现在的活文档是谁，
 * 比让它再去猜「是拼错了、已被 superseded、还是归档了」有用得多。
 */
function missingHint(index: OmemIndex, topic: string | undefined, caller?: 'mcp' | 'cli'): string {
  if (topic) {
    const active = index.findActiveByTopic(topic);
    if (active) return ` The active document for "${topic}" is ${active.id}.`;
  }
  return caller === 'mcp'
    ? ' Use search_memory(topic="<name>") to look up the current id.'
    : ' Check ids with `omem topic list` or `omem search --all`.';
}

/** 小写，空白收成连字符，避免热层把「knee rehab」切成两个标签。 */
export function normalizeTopic(raw: string): string | undefined {
  const topic = raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return topic || undefined;
}

/**
 * frontmatter 里保留的会话 id 上限。长期活文档会累积几百个，frontmatter 跟着膨胀，
 * 每次 listEntries 解析都变慢。
 *
 * 取 200 而不是 50：`absorbedSessionIds()`（process/guide.ts）靠遍历 frontmatter 判断
 * 「这个会话是否已被吸收」，截断会让被截掉的 id 重新出现在 PROCESS.md 待办里。200 次更新
 * 才会触发的场景在现实中不存在，所以这个副作用是可控的；真触发时重跑 `omem sync` 会
 * 重新处理那几条会话，内容不丢，只是多一次加工成本。
 */
const MAX_SOURCE_SESSIONS = 200;

/** 新文档继承被取代文档的会话，并加上本次写回的会话。新的排在前面，超出上限先丢最旧的。 */
function collectSourceSessions(input: CommitInput, oldEntries: Located[]): string[] {
  const ids = new Set<string>();
  const add = (id?: string): void => {
    const v = id?.trim();
    if (v) ids.add(v);
  };
  add(input.session_id);
  for (const id of input.source_sessions ?? []) add(id);
  for (const old of oldEntries) {
    add(old.entry.fm.session_id);
    for (const id of old.entry.fm.source_sessions) add(id);
  }
  return [...ids].slice(0, MAX_SOURCE_SESSIONS);
}

function finish(home: string, result: CommitResult, input: CommitInput, opts: CommitOpts): CommitResult {
  if (!opts.dryRun) {
    logOutcome(home, result.status, { id: result.id, source: input.source, redacted: result.redacted ?? 0, reason: result.reason, ...opts.audit });
  }
  return result;
}
