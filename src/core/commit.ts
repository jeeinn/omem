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
import { commitLocal } from '../sync/git.js';

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
   * 正文超过 `process.max_content_chars` 时怎么办。
   *
   * **必填、无默认值**（beta.9 / T02）：上限规则必须只有一处裁决点，而三条写路径
   * （`save_memory` / `omem add` / pipeline）必须各自显式表态。靠 TypeScript 在编译期
   * 把调用点标红，比靠 code review 记住「这里也得加」可靠。
   *
   * 运行时对 `undefined` 仍按 `reject` 处理：类型挡住新代码，运行时兜住任何漏网调用方，
   * 且兜的方向是安全侧（拒绝写入，而不是产生半截事实）。
   */
  overCap: OverCap;
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

/**
 * 超限策略：`reject`（默认语义，落 0 条 + 回执给出路）或 `truncate`（旧行为，只留给
 * CLI `--force` 这个显式逃生口）。
 */
export type OverCap = 'reject' | 'truncate';

/** 超限拒绝时回执要用的量化信息。数量、出路与「旧文档没动」三件事缺一不可。 */
export interface OverCapInfo {
  /** 实际字符数（code point）。 */
  chars: number;
  limit: number;
  /** 超出的字符数。 */
  overflow: number;
  /** 溢出片段预览：右侧会被丢掉的那一段（仅回执可见，不落盘）。 */
  preview: string;
  /** 该 topic 现在仍 active 的文档 id——它**没有被改动**，这是拒绝的全部价值。 */
  activeId?: string;
}

export interface CommitResult {
  status: CommitStatus;
  id?: string;
  path?: string;
  redacted?: number;
  /** dry-run 且本应落盘时为 true；此时没有 id / path。 */
  dryRun?: boolean;
  reason?: string;
  /** 超限被拒时的量化信息（回执四段由 overCapNotice 统一渲染）。 */
  overCap?: OverCapInfo;
  /** `overCap:'truncate'` 真的截了：调用方必须把「尾巴丢了」说出来。 */
  truncated?: { chars: number; limit: number };
  /**
   * 被 supersede 掉的旧文档里原本是 `verified: true` 的那些（含旧 confidence）。
   * 只报「Saved / Unverified entry」时，调用方分不清「新写的」与「把 0.9 换成 0.55 的」。
   */
  supersededVerified?: { id: string; confidence: number }[];
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

/**
 * 自动提交的结果（beta.9 / T05 / R3）。
 *
 * `off` = 用户关掉了（配置）；`skipped` = 想提交但没能提交（非 git 仓、无改动、身份缺失）。
 * 两者都要能进回执，但都**不改变写入的成败**——记忆已经落盘了。
 */
export interface VcsResult {
  status: 'committed' | 'skipped' | 'off';
  sha?: string;
  files?: number;
  reason?: string;
}

/**
 * 写入路径的自动提交。一次工具调用 / 一次 add 结束时调一次，不是每个文件调一次。
 *
 * 为什么不是每个文件提交一次：`save_memory` 一次调用可能落 3 个文件（新文档 + 旧版
 * supersede + PROCESS.md 重算），分成 3 笔提交会把「一次写入」这件事拆成无法回溯的三步。
 *
 * 非 git 仓库：静默跳过（不抛、不写 stdout），由调用方在回执里说一句。
 */
export function autoCommit(home: string, config: OmemConfig, message: string): VcsResult {
  if (config.process.auto_commit !== 'session') return { status: 'off' };
  const r = commitLocal(home, message);
  if (r.committed) return { status: 'committed', sha: r.sha, files: r.files };
  appendLog(home, 'commit', { status: 'vcs-skipped', reason: r.reason });
  return { status: 'skipped', reason: r.reason };
}

/** 自动提交结果的一句话回执。CLI 与 MCP 只差「你能做什么」那半句。 */
export function vcsNotice(vcs: VcsResult, caller: 'cli' | 'mcp' = 'cli'): string {
  if (vcs.status === 'committed') {
    return `Version control: committed ${vcs.files ?? 1} file(s)${vcs.sha ? ` as ${vcs.sha}` : ''}.`;
  }
  if (vcs.status === 'off') return 'Version control: auto_commit is off; nothing was committed.';
  const why = vcs.reason ?? 'unknown reason';
  return caller === 'mcp'
    ? `Version control: nothing committed (${why}). The entry is on disk but has no version history yet — ask the user to run omem backup, or to init the data repo.`
    : `Version control: nothing committed (${why}). Run omem backup to create history, or omem init to create the data repo.`;
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

/** 溢出片段预览的长度上限：够看清「丢的是什么」，又不至于把回执撑爆。 */
const OVERFLOW_PREVIEW_CHARS = 90;

/**
 * 超限回执的**唯一**渲染处（beta.9 / T02）。
 *
 * 为什么放在 commit.ts 而不是各调用方自己拼：同一句话在 CLI 与 MCP 各手写一遍，
 * 必然一边先说「字数」一边先说「出口」，两句就漂了（`metadataDrift` 是同一教训）。
 * 这里只做 caller 分支（MCP 没有 `--force` 这种命令行语法），不做语义分支。
 *
 * 四段结构固定：超限量 / 旧文档没被动过 / 溢出片段预览 / 两个出口。
 * 缺任何一段，「拒绝」就退化成「写不进」——那正是 PM 唯一坚持的东西。
 */
export function overCapNotice(info: OverCapInfo, caller: 'cli' | 'mcp' = 'cli'): string[] {
  const { chars, limit, overflow } = info;
  const lines = [
    `Not written: content is ${chars.toLocaleString('en-US')} characters, over the ${limit.toLocaleString('en-US')} limit by ${overflow.toLocaleString('en-US')}.`,
  ];
  lines.push(info.activeId
    ? `Nothing was superseded; ${info.activeId} is still active and unchanged.`
    : 'Nothing was written; no existing document was touched.');
  if (info.preview) {
    lines.push(`Over-cap preview (not written): "${info.preview}${overflow > [...info.preview].length ? '…' : ''}"`);
  }
  lines.push(caller === 'mcp'
    ? `Options: (a) tighten the body to under ${limit.toLocaleString('en-US')} characters and resend; (b) start a narrower topic for the new fact and pass it as \`topic\` (the current document stays as it is).`
    : `Options: (a) tighten the body to under ${limit.toLocaleString('en-US')} characters and re-run; (b) use --topic <narrower-name> for the new fact (the current document stays as it is). --force truncates instead, discarding the tail.`);
  return lines;
}

/** 溢出尾部预览：右侧是被 cap 挡掉的那一段（新事实通常在尾部）。 */
function overflowPreview(chars: string[], limit: number): string {
  return chars.slice(limit, limit + OVERFLOW_PREVIEW_CHARS).join('').replace(/\s+/g, ' ').trim();
}

/**
 * 重写 PROCESS.md。清单是派生物，刷不动不该让已经落盘的记忆变成失败——
 * 记忆已经写好了，丢掉它才是真的损失。所以这里吞掉异常，只记日志。
 */
function refreshGuide(home: string, index: OmemIndex, config?: OmemConfig): void {
  try {
    refreshProcessGuide(home, index, config);
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

  const { text: redactedText, hits } = redactSecrets(raw);
  let text = redactedText;
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

  // ── 上限规则：唯一裁决点（beta.9 / T02） ──
  // 此前上限只存在于 `save_memory` 自己的入参截断里，`omem add` 与 pipeline 都没有，
  // 于是「2000 字」有三套纪律。现在三条路径都过这里。
  // 位置在 supersede 解析之前：拒绝时旧文档必须零改动——这是「拒绝」相对「截断」的全部价值
  // （截断会把旧文档 supersede 掉，内容永久退出检索）。
  const topic = resolveTopic(input);
  const capChars = [...text];
  const limit = Math.max(1, Math.floor(config.process.max_content_chars));
  const capMode: OverCap = input.overCap === 'truncate' ? 'truncate' : 'reject';
  let truncatedInfo: { chars: number; limit: number } | undefined;
  if (capChars.length > limit) {
    if (capMode === 'truncate') {
      // 旧行为，只留给 CLI `--force` 这个显式逃生口：回执必须说清尾巴丢了。
      truncatedInfo = { chars: capChars.length, limit };
      text = capChars.slice(0, limit).join('') + '…';
    } else {
      const activeForTopic = topic ? index.findActiveByTopic(topic) : undefined;
      return finish(home, {
        status: 'excluded',
        redacted,
        overCap: {
          chars: capChars.length,
          limit,
          overflow: capChars.length - limit,
          preview: overflowPreview(capChars, limit),
          activeId: activeForTopic?.id ?? (input.supersedes ?? []).map((s) => s.trim()).filter(Boolean)[0],
        },
        reason: `Content is ${capChars.length} characters, over the ${limit} limit by ${capChars.length - limit}; nothing was written`,
      }, input, opts);
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
  // topic 已在 cap 判定前解析（拒绝回执要用它指出「哪份文档没被动过」），此处不重复。
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
    return {
      status: 'written',
      redacted,
      dryRun: true,
      reason: 'dry-run',
      warnings,
      ...(truncatedInfo ? { truncated: truncatedInfo } : {}),
    };
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
  // 被取代的旧版里原本 verified 的，必须进回执（QA W4：回执一字不提，调用方无法察觉
  // 自己把 0.9 的活文档换成了 0.55 的新版）。旧文件仍然保留 verified: true，只是不再是
  // 活文档——所以措辞是「降级」，不是「验证信息蒸发」。
  const supersededVerified = oldEntries
    .filter((l) => l.entry.fm.verified)
    .map((l) => ({ id: l.entry.fm.id, confidence: l.entry.fm.confidence }));
  if (opts.refreshIndex !== false) generateMemoryIndex(home, index);
  // 吸收了会话就要把 PROCESS.md 里的待办减掉。save_memory 走 MCP，不经过
  // omem sync，清单原本只会在采集路径上重算——Agent 会读到已吸收的旧待办。
  if (opts.refreshGuide !== false) refreshGuide(home, index, config);
  logOutcome(home, 'written', { id: entry.fm.id, source: input.source, redacted: hits, supersedes, ...opts.audit });
  return {
    status: 'written',
    id: entry.fm.id,
    path: written.path,
    redacted,
    warnings,
    ...(truncatedInfo ? { truncated: truncatedInfo } : {}),
    ...(supersededVerified.length > 0 ? { supersededVerified } : {}),
  };
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
