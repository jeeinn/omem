// 统一写入（改进计划 P0-2）：add / save_memory / pipeline 的唯一提交点。
// 顺序：脱敏 → work 代码密度 → content-hash 去重 → 落盘 → upsert → 可选刷新热层 → 日志。
// force 只跳过代码密度；脱敏与去重不跳过。refreshIndex 默认 true，批量加工传 false。
import type { OmemConfig } from './config.js';
import type { EntryRow, OmemIndex } from './index.js';
import type { Entry, EntrySource, Frontmatter, MemoryType, Profile } from './entry.js';
import { isNearDupTopic, mergeEvidence, newFrontmatter, normalizeDomain, normalizeTopic } from './entry.js';
import { rmSync } from 'node:fs';

import { findByTopic, writeEntry } from './store.js';
import { contentHash } from './util.js';
import { redactSecrets } from './redact.js';
import { currentProfile, isCodeHeavy } from './profile.js';
import { generateMemoryIndex } from './lifecycle.js';
import { appendLog } from './log.js';
import { inferDomain } from '../process/rules.js';
import { refreshProcessGuide } from '../process/guide.js';
import { commitLocal } from '../sync/git.js';
import { runSnapshot } from './snapshot.js';

export interface CommitInput {
  content: string;
  type: MemoryType;
  domain?: string;
  tags?: string[];
  project?: string;
  /**
   * 身份 = 文件名（D1-B′）。**必填**：每一条记忆都是一份 topic 文档，
   * 一次性记忆就是只被写过一次的 topic。
   */
  topic: string;
  session_id?: string;
  source_sessions?: string[];
  /** 证据锚定原文（文档 §7.2）：落盘保留原文，归一化只用于比对。 */
  evidence?: string[];
  source: EntrySource;
  confidence: number;
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
  /** 该 topic 现在仍 active 的文档——它**没有被改动**，这是拒绝的全部价值。 */
  activeTopic?: string;
}

export interface CommitResult {
  status: CommitStatus;
  /** 身份 = 文件名（D1-B′）。写入或去重命中时给出。 */
  topic?: string;
  path?: string;
  redacted?: number;
  /** dry-run 且本应落盘时为 true；此时没有 id / path。 */
  dryRun?: boolean;
  reason?: string;
  /** 超限被拒时的量化信息（回执四段由 overCapNotice 统一渲染）。 */
  overCap?: OverCapInfo;
  /** `overCap:'truncate'` 真的截了：调用方必须把「尾巴丢了」说出来。 */
  truncated?: { chars: number; limit: number };
  /** 覆盖了既有活文档（而不是新建）。回执要能分清这两件事。 */
  updated?: boolean;
  /**
   * 非致命提醒：写入成功，但这件事值得让调用方知道（跨 topic 合并、近似 topic、
   * 误把项目分组名当主题）。不拒绝写入——拒绝会打断 Agent 的写回流程。
   */
  warnings?: string[];
  /**
   * 命中 content-hash 去重时，既有条目的元数据。
   * 调用方据此判断「请求的 topic/type 与既有文档是否不一致」——不一致时要能说出来，
   * 否则元数据被静默丢弃，响应还读起来像成功。
   *
   * `confidence` 带的是**落盘值**：去重意味着这次没有写入，所以这次算出来的分只是
   * 一个假设。回执报假设分会让调用方以为磁盘上是这个数（补分被守卫生效时尤其明显）。
   */
  existing?: { topic?: string; type: string; tags: string[]; confidence: number };
  /**
   * 去重命中但补了分（2026-11-02）：正文一字未改，只是这次带的证据锚上了，
   * 于是把 `confidence` 与证据链刷新回账本值。`applied:false` 只出现在 dry-run——
   * 数算出来了，文件没动。调用方必须把这件事说出来，否则回执「什么都没写」
   * 与磁盘被改过的事实对不上。
   */
  rescored?: { from: number; to: number; applied: boolean };
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
 * 补分回执的唯一渲染处（CLI 与 MCP 共用）。理由与 `metadataDrift` 相同：
 * 同一句「分数被补上了」各写一遍，必然一边先报旧分一边先报新分。
 */
export function rescoreNotice(r: NonNullable<CommitResult['rescored']>): string {
  const range = `from ${r.from.toFixed(2)} to ${r.to.toFixed(2)}`;
  return r.applied
    ? `Confidence raised ${range}: the quotes now anchor. The body was not rewritten — only the frontmatter (confidence, evidence, source sessions) was refreshed.`
    : `Confidence would be raised ${range}: the quotes now anchor. Dry-run wrote nothing.`;
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
  reason?: string;
  /** 提交后工作区里仍然脏的路径（不是本次写过的）。空 = 干净。 */
  residue?: string[];
}

/**
 * 写入路径的自动提交。一次工具调用 / 一次 add 结束时调一次，不是每个文件调一次。
 *
 * 为什么不是每个文件提交一次：`save_memory` 一次调用可能落 3 个文件（新文档 + 旧版
 * supersede + PROCESS.md 重算），分成 3 笔提交会把「一次写入」这件事拆成无法回溯的三步。
 *
 * 非 git 仓库：静默跳过（不抛、不写 stdout），由调用方在回执里说一句。
 */
export function autoCommit(home: string, config: OmemConfig, message: string, paths: string[] = []): VcsResult {
  if (config.process.auto_commit !== 'session') return { status: 'off' };
  const r = commitLocal(home, message, paths);
  if (r.committed) return { status: 'committed', sha: r.sha, residue: r.residue ?? [] };
  appendLog(home, 'commit', { status: 'vcs-skipped', reason: r.reason, paths: paths.length });
  return { status: 'skipped', reason: r.reason, residue: r.residue ?? [] };
}

/** 自动提交结果的一句话回执。CLI 与 MCP 只差「你能做什么」那半句。 */
export function vcsNotice(vcs: VcsResult, caller: 'cli' | 'mcp' = 'cli'): string {
  if (vcs.status === 'committed') {
    const left = vcs.residue ?? [];
    const tail = left.length > 0
      ? ` ${left.length} path(s) outside this write are still uncommitted: ${left.slice(0, 3).join(', ')}${left.length > 3 ? ' …' : ''}.`
      : ' Working tree is clean.';
    return `Version control: committed${vcs.sha ? ` as ${vcs.sha}` : ''} (one commit per write).${tail}`;
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
  lines.push(info.activeTopic
    ? `Nothing was written; "${info.activeTopic}" is still active and unchanged.`
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

/** 补分的容差：与 `verifyConfidence` 同一口径——浮点大小不比字面相等。 */
const RESCORE_TOL = 0.005;

/** 阶梯标记。分数变了它们必须跟着变，否则 review 队列与分数各说一套。 */
const LADDER_TAGS = new Set(['ungrounded', 'pending-session']);

/**
 * 去重命中时的「补分」（2026-11-02 裁定）。
 *
 * 要解决的问题：会话通常在写入**之后**才被 `omem sync` 收进来，当时那条只能落
 * 0.35 `ungrounded`。正文没变，分数却过时了；而重发同样的正文会被 body_hash 去重
 * 挡回来——补采之后没有任何一条路能自愈（`omem verify` 只报告不改写）。
 *
 * 因此：同一条正文、同一个 topic、这次带的证据确实锚上了 → 只刷新 frontmatter
 * 的 `confidence` 与证据链，正文一字不动。
 *
 * 四个边界，每一条都是防「自己给自己涨分」：
 *   - topic 必须相同：写 A 不许动 B 的分。
 *   - 必须带 evidence：不带证据的单子算 `pending-session` 0.55，若允许它补分，
 *     一句「什么都不举」就能把 0.35 抬上去，举证纪律当场失效。
 *   - 只升不降：降分是 `omem verify` 报给人判断的事，不该是写入的副作用。
 *   - 人工过目过的（`confirmations > 0`）不碰：0.9 是人给的，机器不覆盖。
 *
 * 返回 null = 不满足条件，调用方按普通去重回执。
 */
function rescoreOnDedup(
  home: string,
  index: OmemIndex,
  dup: EntryRow,
  topic: string,
  input: CommitInput,
  opts: CommitOpts,
  redacted: number | undefined,
): CommitResult | null {
  if (dup.topic !== topic || dup.status !== 'active') return null;
  if (dup.confirmations > 0) return null;
  const evidence = (input.evidence ?? []).map((e) => e.trim()).filter(Boolean);
  if (evidence.length === 0) return null;
  if (!(input.confidence > dup.confidence + RESCORE_TOL)) return null;

  const loc = findByTopic(home, dup.topic, { includeArchived: true });
  if (!loc) return null;
  const fm = loc.entry.fm;
  const from = fm.confidence;
  if (!(input.confidence > from + RESCORE_TOL)) return null;
  const rescored = { from, to: input.confidence, applied: !opts.dryRun };

  if (opts.dryRun) {
    return finish(home, {
      status: 'deduped',
      topic: dup.topic,
      redacted,
      reason: 'Content already exists; the score would be refreshed',
      rescored,
      existing: { topic: dup.topic, type: fm.type, tags: fm.tags, confidence: fm.confidence },
    }, input, opts);
  }

  fm.confidence = input.confidence;
  // 证据链与会话 id 跟分数同源：只提分不留证据的话，下一次 `omem verify`
  // 会用同一本账把它判成 overstated（账本重算读的正是这两个字段）。
  fm.evidence = mergeEvidence(evidence, [fm.evidence]);
  fm.source_sessions = collectSourceSessions(input, fm);
  if (!fm.session_id && input.session_id) fm.session_id = input.session_id;
  fm.tags = fm.tags.filter((t) => !LADDER_TAGS.has(t));
  const written = writeEntry(home, loc.entry);
  if (loc.path !== written.path) rmSync(loc.path, { force: true });
  index.upsert(loc.entry, written.path, written.content);
  if (opts.refreshIndex !== false) generateMemoryIndex(home, index);
  // PROCESS.md 不依赖 confidence 与 tags，重算它只是多花一次渲染——跳过。
  logOutcome(home, 'deduped', {
    topic: dup.topic,
    source: input.source,
    redacted: redacted ?? 0,
    reason: 'rescore',
    rescored: { from, to: input.confidence },
    ...opts.audit,
  });
  return {
    status: 'deduped',
    topic: dup.topic,
    path: written.path,
    redacted,
    rescored,
    existing: { topic: dup.topic, type: fm.type, tags: fm.tags, confidence: fm.confidence },
  };
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

  // 回执用的非致命提醒；cap 的截断分支在这里 push 第一条（见下）。
  const warnings: string[] = [];

  // ── 上限规则：唯一裁决点（beta.9 / T02） ──
  // 三条写路径（save_memory / omem add / pipeline）都过这里。
  // 位置在覆盖写入之前：拒绝时既有文档必须零改动——这是「拒绝」相对「截断」的全部价值。
  const topic = input.topic ? normalizeTopic(input.topic) : undefined;
  if (!topic) {
    return finish(home, {
      status: 'excluded',
      redacted,
      reason: 'A topic is required: every memory is a living document, and its name is the topic.',
    }, input, opts);
  }
  const activeRow = index.findActiveByTopic(topic);
  const capChars = [...text];
  const limit = Math.max(1, Math.floor(config.process.max_content_chars));
  const capMode: OverCap = input.overCap === 'truncate' ? 'truncate' : 'reject';
  let truncatedInfo: { chars: number; limit: number } | undefined;
  if (capChars.length > limit) {
    if (capMode === 'truncate') {
      // 旧行为，只留给 CLI `--force` 这个显式逃生口：回执必须说清尾巴丢了，
      // 并在 `logs/omem.log` 留一条审计（QA P1-6：只有一次性回执的话，过一周没人能区分
      // 「人为控制长度」与「被截断」。不加 frontmatter 字段、不加 tags——那些会改语义）。
      truncatedInfo = { chars: capChars.length, limit };
      text = capChars.slice(0, limit).join('') + '…';
      warnings.push(
        `Force-truncated: ${capChars.length - limit} character(s) were cut from the tail. `
        + 'Review the end of the body; this file is recorded as force-truncated in logs/omem.log.',
      );
    } else {
      return finish(home, {
        status: 'excluded',
        redacted,
        overCap: {
          chars: capChars.length,
          limit,
          overflow: capChars.length - limit,
          preview: overflowPreview(capChars, limit),
          activeTopic: activeRow?.topic,
        },
        reason: `Content is ${capChars.length} characters, over the ${limit} limit by ${capChars.length - limit}; nothing was written`,
      }, input, opts);
    }
  }

  const dup = index.getByBodyHash(contentHash(text));
  if (dup) {
    // 正文已经存在 ≠ 分数已经正确：会话常常在写入之后才被 `omem sync` 收进来。
    // 满足条件时补分（只改 frontmatter），否则退回平常的去重回执。
    const rescored = rescoreOnDedup(home, index, dup, topic, input, opts, redacted);
    if (rescored) return rescored;
    return finish(home, {
      status: 'deduped',
      topic: dup.topic,
      redacted,
      reason: 'Content already exists',
      // 去重命中时把既有元数据带回去：调用方要判断请求的 topic/type 是否与既有一致。
      existing: {
        topic: dup.topic,
        type: dup.type,
        tags: (dup.tags ?? '').split(/\s+/).filter(Boolean),
        confidence: dup.confidence,
      },
    }, input, opts);
  }

  // D1-B′：写入即覆盖同一份文件。既有文档存在时继承它的「痕迹」（会话、证据、创建时间），
  // 但置信度与过目时间由本次写入决定——信任不会因为「主题没变」而自动继承。
  const existingLoc = findByTopic(home, topic, { includeArchived: true });
  const existingFm = existingLoc?.entry.fm;

  // D5：主题级审阅策略（review.toml）已删除——「这个主题我信得过」不再折算成自动提分。
  // 置信度只由本次证据决定（M1），人工动作只剩过目/归档/冷却。

  // 只在新建主题时查近似：命中不拒绝（拒绝会让 Agent 卡住），而是提示可能应当并入既有主题。
  if (!existingFm && !activeRow) {
    const near = index.activeTopics().find((t) => isNearDupTopic(topic, t));
    if (near) {
      // 两个方向都要说清：只说「写进去」会把「本来就该是两个主题」的情况也诱导成合并。
      warnings.push(
        `Topic "${topic}" is close to existing "${near}". If they describe the same subject, write into "${near}" instead of starting a second living document; if they are different subjects, keep the new topic and ignore this warning.`,
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
      topic,
      type: input.type,
      // domain 是 topic 的属性，不是本次正文的属性：覆盖时沿用既有 domain，
      // 否则同一主题会因为「这次内容看起来像代码」而搬到另一个目录，留下两份文件。
      domain: normalizeDomain(input.domain || existingFm?.domain || inferDomain(text)),
      profile,
      status: 'active',
      confidence: input.confidence,
      source: input.source,
      session_id: input.session_id,
      project: input.project,
      // created 沿用首次创建时间：路径不变，git 里的「第一笔」不该被这次覆盖重置。
      ...(existingFm?.created ? { created: existingFm.created } : {}),
      // 「人看过这个主题」是主题级事实，不是这次正文的属性：覆盖时保留过目记录，
      // 否则 `once` 策略会在每次更新后重新变回「未审」，人工介入退化成无限循环。
      ...(existingFm ? { confirmations: existingFm.confirmations, last_confirmed: existingFm.last_confirmed } : {}),
      source_sessions: collectSourceSessions(input, existingFm),
      evidence: mergeEvidence(input.evidence ?? [], existingFm ? [existingFm.evidence] : []),
      tags: input.tags ?? [],
    }),
    body: text,
  };
  // 覆盖既有活文档前打一个快照（A-3 / M2 护栏）：AI 整篇重写是本模型的主要风险，
  // git 是最终退路，但快照更便宜也更容易被人翻出来。打不出来不该让写失败——记忆已经准备好了。
  if (existingFm) {
    try {
      runSnapshot(home);
    } catch (err) {
      appendLog(home, 'commit', { status: 'snapshot-failed', topic, error: (err as Error).message });
    }
  }
  const written = writeEntry(home, entry);
  // 路径变了（归档主题被重写搬回 knowledge/，或 domain 显式改过）：删旧文件，
  // 否则同一 topic 会在磁盘上留下两份，"一个主题一份活文档"就不成立了。
  if (existingLoc && existingLoc.path !== written.path) rmSync(existingLoc.path, { force: true });
  index.upsert(entry, written.path, written.content);
  if (opts.refreshIndex !== false) generateMemoryIndex(home, index);
  // 吸收了会话就要把 PROCESS.md 里的待办减掉。save_memory 走 MCP，不经过
  // omem sync，清单原本只会在采集路径上重算——Agent 会读到已吸收的旧待办。
  if (opts.refreshGuide !== false) refreshGuide(home, index, config);
  logOutcome(home, 'written', {
    topic,
    updated: Boolean(existingFm),
    source: input.source,
    redacted: hits,
    ...(truncatedInfo ? { truncated: truncatedInfo } : {}),
    ...opts.audit,
  });
  return {
    status: 'written',
    topic,
    path: written.path,
    redacted,
    updated: Boolean(existingFm),
    warnings,
    ...(truncatedInfo ? { truncated: truncatedInfo } : {}),
  };
}

/**
 * 主题归一化已迁至 `core/entry.ts`（与 `normalizeDomain` 同处，二者共用一套字符政策）。
 * 这里保留重导出，调用方（MCP / pipeline / topic 命令）无需改路径。
 */
export { normalizeTopic } from './entry.js';

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
function collectSourceSessions(input: CommitInput, existing?: Frontmatter): string[] {
  const ids = new Set<string>();
  const add = (id?: string): void => {
    const v = id?.trim();
    if (v) ids.add(v);
  };
  add(input.session_id);
  for (const id of input.source_sessions ?? []) add(id);
  if (existing) {
    add(existing.session_id);
    for (const id of existing.source_sessions) add(id);
  }
  return [...ids].slice(0, MAX_SOURCE_SESSIONS);
}

function finish(home: string, result: CommitResult, input: CommitInput, opts: CommitOpts): CommitResult {
  if (!opts.dryRun) {
    logOutcome(home, result.status, { topic: result.topic, source: input.source, redacted: result.redacted ?? 0, reason: result.reason, ...opts.audit });
  }
  return result;
}
