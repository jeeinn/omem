// save_memory 的自动置信度。只改 confidence——D2 之后没有别的信任标记。
// 依据必须是会话文件里某个 ## user 段的连续子串；模型引用自己的话不算。
// 比对前先归一化（D8）：复用 normalizeForHash，两条写入路径共用一把尺子。
import { evidenceUserKey, evidenceUserText, listStoredSessionFiles, readSessionsById, readStoredSession, splitSessionKey } from '../collect/session-store.js';
import { listEntries } from '../core/store.js';
import { evidenceForScore } from '../core/entry.js';
import { searchSessions } from '../core/search.js';
import { normalizeForHash } from '../core/util.js';
import type { OmemIndex } from '../core/index.js';

export const SCORE_GROUNDED = 0.55;
export const SCORE_CORROBORATED = 0.75;
export const SCORE_UNGROUNDED = 0.35;
export const SCORE_AUTO_CAP = 0.8;
export const SCORE_CONFIRMED = 0.9;
/** API 档产物的硬上限（D2）：没人看过的产物不进高置信区间。 */
export const SCORE_API_CAP = 0.75;

/** evidence 原文门槛（§7.2）：归一化只用于比对，不用于量长度。 */
export const MIN_EVIDENCE = 12;

export interface ScoreInput {
  content: string;
  sessionId?: string;
  /** 被本次写入吸收的多会话清单（不含 sessionId）；透传给 commitEntry 的 source_sessions。 */
  sessionIds?: string[];
  /** 证据锚定原文：单字符串（向后兼容）或多条 evidence（取最佳印证结果）。 */
  evidence?: string | string[];
}

export interface Anchor {
  evidence: string;
  /** 命中的会话（裸 id）。 */
  session: string;
}

export interface ScoreResult {
  confidence: number;
  tags: string[];
  /**
   * 主引用会话是否在已采集集合里。false 表示这个 id 根本找不到（拼错、未 sync、别的 profile），
   * 与「会话存在但没这句话」是两件事，响应必须能分开说。
   */
  sessionFound?: boolean;
  /**
   * 逐条证据的归属。只报 overall「锚定成功/失败」时，
   * 两条证据里一条真一条假也会整体通过——举证纪律就退化成「过安检即可」。
   */
  anchors?: { total: number; matched: Anchor[] };
}

function charLen(s: string): number {
  return [...s].length;
}

/**
 * 归一化子串比对（D8）：evidence 与原文都过 normalizeForHash 再 includes。
 * 门槛仍按原文长度 ≥12 字符——标点密度高的既有 evidence 不能因归一化变短而回归 ungrounded。
 */
export function evidenceIn(haystack: string, evidence: string): boolean {
  const h = normalizeForHash(haystack);
  const e = normalizeForHash(evidence);
  return e.length > 0 && h.includes(e);
}

export interface CorroborationInfo {
  /** 独立印证来源数（按「用户输入」去重，不是按会话文件） */
  count: number;
  /** 印证来源的去重项目指纹数 */
  uniqueProjects: number;
}

/**
 * 被排除的来源会话。
 *
 * ids   —— 会话 id（裸 id / 带 collector 前缀 / 路径末段都收），排除它自己。
 * keys  —— 来源会话的「证据域用户文本」指纹。用来挡住副本：同一段用户输入被同步两次、
 *          或两个采集器收了同一次对话，在磁盘上是两个会话文件，但只有一个来源，
 *          不能算两份印证（否则复制粘贴就能刷分）。
 */
interface SourceSkip {
  ids: Set<string>;
  userKeys: Set<string>;
}

function buildSourceSkip(home: string, skipIds?: string | string[]): SourceSkip {
  const ids = new Set<string>();
  const userKeys = new Set<string>();
  const bare: string[] = [];
  for (const raw of Array.isArray(skipIds) ? skipIds : (skipIds ? [skipIds] : [])) {
    const value = raw.trim();
    if (!value) continue;
    ids.add(value);
    const sessionId = splitSessionKey(value).sessionId;
    ids.add(sessionId);
    const last = value.split('/').filter(Boolean).pop();
    if (last) ids.add(last);
    bare.push(sessionId);
  }
  // 来源会话占位：它的用户文本指纹先入集合，副本就撞在这里。
  for (const id of bare) {
    for (const s of readSessionsById(home, id)) userKeys.add(evidenceUserKey(s.body));
  }
  return { ids, userKeys };
}

/** 用会话全文索引缩小范围，再对 user 段做归一化子串比对；跳过 source 会话避免自印证。 */
function corroboratingSessions(index: OmemIndex, evidence: string, skip: SourceSkip): CorroborationInfo {
  const probe = [...evidence].slice(0, 24).join('');
  const hits = searchSessions(index, probe, 8);
  const seenSessions = new Set<string>();
  const seenUserKeys = new Set<string>();
  const seenProjects = new Set<string>();
  for (const hit of hits) {
    const id = splitSessionKey(hit.session_key).sessionId;
    if (!id || skip.ids.has(id) || seenSessions.has(id)) continue;
    const stored = readStoredSession(hit.path);
    if (!stored) continue;
    if (!evidenceIn(evidenceUserText(stored.body), evidence)) continue;
    // 同一段用户输入 = 一个来源。副本不算独立印证（AGENTS.md「印证必须独立」）。
    const userKey = evidenceUserKey(stored.body);
    if (skip.userKeys.has(userKey) || seenUserKeys.has(userKey)) continue;
    seenSessions.add(id);
    seenUserKeys.add(userKey);
    if (stored.project && stored.project !== 'unknown') {
      seenProjects.add(stored.project);
    }
  }
  return { count: seenSessions.size, uniqueProjects: seenProjects.size };
}

/**
 * 印证加分：第 1 个印证 +0.10，第 2 个 +0.06，第 3 个及以后每个 +0.03；
 * 跨项目额外 +0.03/个（封顶 2 个额外项目）；总封顶 0.25。
 * 纯 anchored 无印证 = 0 加分，保留 GROUNDED 基准 0.55。
 */
function corroborationBonus(info: CorroborationInfo): number {
  if (info.count === 0) return 0;
  let bonus = 0.10;
  if (info.count >= 2) bonus += 0.06;
  if (info.count >= 3) bonus += Math.min(info.count - 2, 3) * 0.03;
  if (info.uniqueProjects >= 2) {
    bonus += Math.min(info.uniqueProjects - 1, 2) * 0.03;
  }
  return Math.round(Math.min(bonus, 0.25) * 100) / 100;
}

/**
 * 没有引用会话时的印证口径（2026-10-27 修正的倒折算在这里）。
 *
 * 问题：`corroboratingSessions` 不给 skipIds 时，会把「证据的来源会话本身」算成一份独立印证，
 * 于是「给了证据但不指名 session_id」得 0.65，而「给了证据且指名了正确会话」只有 0.55——
 * 指名反而更低，激励方向是反的。
 *
 * 口径：无法证明第一个命中不是来源会话时，它不能算独立印证。
 * 命中 1 份 → 0 加分（0.55）；命中 ≥2 份 → 从第二份起才计入印证。
 * 方向上是收紧：既有条目只降不升，review 队列只会变严。
 */
function corroborationFromIndex(info: CorroborationInfo): number {
  return corroborationBonus({ count: Math.max(0, info.count - 1), uniqueProjects: info.uniqueProjects });
}

/** 归一化证据输入为字符串数组：兼容 string（向后兼容）与 string[]（多证据）。 */
function normalizeEvidence(ev: string | string[] | undefined): string[] {
  if (!ev) return [];
  const arr = Array.isArray(ev) ? ev : [ev];
  return arr.map((e) => e.trim()).filter((e) => charLen(e) >= MIN_EVIDENCE);
}

/** 按依据给结论打分。自动分不超过 0.8。传入 index 时用 sessions_fts 找印证，不扫全部会话文件。
 * 支持单证据（向后兼容）与多证据：多证据取最佳印证结果（与 scoreApiDoc 同口径，但 cap 0.8）。 */
export function scoreEvidence(home: string, input: ScoreInput, index?: OmemIndex): ScoreResult {
  const evidences = normalizeEvidence(input.evidence);
  const tags: string[] = [];
  // 引用会话：主 sessionId + 新增吸收的 sessionIds 合并用于 cited 检查
  const allSessionIds = [input.sessionId, ...(input.sessionIds ?? [])].filter((id): id is string => Boolean(id));
  const cited = allSessionIds.length > 0
    ? allSessionIds.flatMap((id) => readSessionsById(home, id))
    : [];
  const sessionFound = allSessionIds.length === 0 ? undefined : cited.length > 0;
  const anchors = {
    total: evidences.length,
    matched: evidences.flatMap((e) => {
      const hit = cited.find((s) => evidenceIn(evidenceUserText(s.body), e));
      return hit ? [{ evidence: e, session: hit.sessionId }] : [];
    }),
  };
  const citedHit = evidences.length > 0 && anchors.matched.length > 0;
  let base = SCORE_UNGROUNDED;
  let grounded = false;

  if (evidences.length === 0 && cited.length === 0) {
    base = SCORE_GROUNDED;
    tags.push('pending-session');
  } else if (citedHit) {
    // 多证据：对每条 evidence 独立查印证，取最佳（与 scoreApiDoc reduce 同口径）
    const skip = buildSourceSkip(home, allSessionIds);
    const others = index
      ? evidences.reduce<CorroborationInfo>((acc, e) => {
          const info = corroboratingSessions(index, e, skip);
          return {
            count: Math.max(acc.count, info.count),
            uniqueProjects: Math.max(acc.uniqueProjects, info.uniqueProjects),
          };
        }, { count: 0, uniqueProjects: 0 })
      : { count: 0, uniqueProjects: 0 };
    base = SCORE_GROUNDED + corroborationBonus(others);
    grounded = true;
  } else if (evidences.length > 0 && allSessionIds.length === 0 && index) {
    const skip = buildSourceSkip(home, undefined);
    const info = evidences.reduce<CorroborationInfo>((acc, e) => {
      const cur = corroboratingSessions(index, e, skip);
      return {
        count: Math.max(acc.count, cur.count),
        uniqueProjects: Math.max(acc.uniqueProjects, cur.uniqueProjects),
      };
    }, { count: 0, uniqueProjects: 0 });
    if (info.count > 0) {
      base = SCORE_GROUNDED + corroborationFromIndex(info);
      grounded = true;
    } else {
      tags.push('ungrounded');
    }
  } else {
    tags.push('ungrounded');
  }

  if (!grounded && !tags.includes('pending-session') && !tags.includes('ungrounded')) tags.push('ungrounded');

  const confidence = Math.min(SCORE_AUTO_CAP, base);
  return { confidence, tags, sessionFound, anchors };
}

/**
 * API 档活文档的证据锚定（文档 §7.1）：不采信模型自评，置信度由 evidence 锚定决定。
 * 复用与 scoreEvidence 同一套梯级口径：锚得上 → 0.55 起；
 * 多会话印证 / 跨项目印证按 corroborationBonus 叠加（封顶 +0.25）；
 * 一条都锚不上 → 0.35 + `ungrounded`（仍落盘）。
 * 上限 0.75（SCORE_API_CAP）。D2：不再有 `verified` 位，过目由 review 写 0.9。
 */
export function scoreApiDoc(
  home: string,
  input: { sessionId?: string; evidence: string[]; content: string },
  index?: OmemIndex,
): ScoreResult {
  const valid = input.evidence.map((e) => e.trim()).filter((e) => charLen(e) >= MIN_EVIDENCE);
  let base = SCORE_UNGROUNDED;
  let tags: string[] = ['ungrounded'];

  if (valid.length > 0) {
    const cited = input.sessionId ? readSessionsById(home, input.sessionId) : [];
    const citedHit = valid.some((e) => cited.some((s) => evidenceIn(evidenceUserText(s.body), e)));
    if (citedHit) {
      const skip = buildSourceSkip(home, input.sessionId);
      const others = index
        ? valid.reduce<CorroborationInfo>((acc, e) => {
            const info = corroboratingSessions(index, e, skip);
            return {
              count: Math.max(acc.count, info.count),
              uniqueProjects: Math.max(acc.uniqueProjects, info.uniqueProjects),
            };
          }, { count: 0, uniqueProjects: 0 })
        : { count: 0, uniqueProjects: 0 };
      base = SCORE_GROUNDED + corroborationBonus(others);
      tags = [];
    } else if (!input.sessionId && index) {
      // 无引用会话时退化为全库印证（与 scoreEvidence 的无 sessionId 分支同一口径，含首位不计）
      const skip = buildSourceSkip(home, undefined);
      const info = valid.reduce<CorroborationInfo>((acc, e) => {
        const cur = corroboratingSessions(index, e, skip);
        return {
          count: Math.max(acc.count, cur.count),
          uniqueProjects: Math.max(acc.uniqueProjects, cur.uniqueProjects),
        };
      }, { count: 0, uniqueProjects: 0 });
      if (info.count > 0) {
        base = SCORE_GROUNDED + corroborationFromIndex(info);
        tags = [];
      }
    }
  }

  return { confidence: Math.min(SCORE_API_CAP, base), tags };
}

/**
 * 账本复算（`omem verify` 用）：以当前账本重算一条活文档的自动分，与落盘值比对。
 *
 * 为什么比的是**区间**而不是一个数：落盘的 confidence 是**写入那一刻**算的，
 * 那时排除自印证的会话集合 = 主来源会话 + 本次写入吸收的那几个。落盘之后
 * `source_sessions` 继续累积，账本里已经分不出「当时到底是哪几个」，
 * 于是只能算出两个界：
 *
 *   max —— 只排除主来源会话（把本条目自己的其它来源都当成印证）；
 *   min —— 把本条目自己的所有来源会话都算作自印证。
 *
 * 区间 [min, max] 覆盖了写入批次带来的全部差异；落在区间内 = 没有漂移。
 * 只报告、不改写：自动改写会在每次 verify 时抖动 git 历史，而且「谁该赢」不是机器能判的。
 *
 * 复算用 `evidenceForScore`：`evidence_current` 在场时只认本次引文，缺席才用历史链。
 * 历史引文不给当前正文加印证。本函数仍只报告、不改写（AGENTS.md）。
 */
export interface ConfidenceDrift {
  topic: string;
  stored: number;
  min: number;
  max: number;
  /** 落盘值低于账本允许的下界（条目被低估）。 */
  verdict: 'understated' | 'overstated';
  /** `evidence_current` 在场为 current；缺席的旧文件为 legacy。 */
  layer: 'current' | 'legacy';
  /** 这次复算实际用上的引文条数。当前层为空时是 0。 */
  quotes: number;
}

/** verify 一行说明的唯一渲染处。空的当前层单独说，避免被读成「会话被删了」。 */
export function driftNotice(d: ConfidenceDrift): string {
  if (d.layer === 'current' && d.quotes === 0 && d.verdict === 'overstated') {
    return 'scored from an empty evidence_current; historical quotes were not counted';
  }
  const layer = d.layer === 'current'
    ? 'scored from evidence_current'
    : 'scored from evidence (this file has no evidence_current)';
  const verdict = d.verdict === 'overstated'
    ? 'stored above ledger — the evidence may no longer anchor (session deleted or edited)'
    : 'stored below ledger — more independent sources exist than were counted';
  return `${layer}; ${verdict}`;
}

/**
 * 只有 `source: agent` 的条目参与比对：
 *
 *   - `manual`：人亲手写的，0.9 是设计值，不是自动分；
 *   - `llm`：API 档有 0.75 上限，等价性不成立；
 *   - `rules`：v0.1 的规则来源，这一版不再产生新条目。
 *
 * 人工过目过的（`confirmations > 0`）落盘 0.9，同样不参与。
 */
export function verifyConfidence(
  home: string,
  index: OmemIndex,
): { checked: number; skipped: number; drifts: ConfidenceDrift[] } {
  const drifts: ConfidenceDrift[] = [];
  let checked = 0;
  let skipped = 0;
  for (const loc of listEntries(home)) {
    const fm = loc.entry.fm;
    if (fm.status !== 'active' || fm.source !== 'agent' || fm.confirmations > 0) {
      skipped++;
      continue;
    }
    checked++;
    const used = evidenceForScore(fm);
    const base = { content: loc.entry.body, evidence: used };
    const layer = fm.evidence_current !== undefined ? 'current' as const : 'legacy' as const;
    // max：只排除主来源会话。
    const max = scoreEvidence(home, { ...base, sessionId: fm.session_id, sessionIds: [] }, index).confidence;
    // min：把本条目自己的所有来源会话都算作自印证。
    const min = fm.session_id
      ? scoreEvidence(home, { ...base, sessionId: fm.session_id, sessionIds: fm.source_sessions }, index).confidence
      : max;
    const tol = 0.005;
    if (fm.confidence < min - tol) {
      drifts.push({ topic: fm.topic, stored: fm.confidence, min, max, verdict: 'understated', layer, quotes: used.length });
    } else if (fm.confidence > max + tol) {
      drifts.push({ topic: fm.topic, stored: fm.confidence, min, max, verdict: 'overstated', layer, quotes: used.length });
    }
  }
  drifts.sort((a, b) => a.topic.localeCompare(b.topic));
  return { checked, skipped, drifts };
}

// ── 引文覆盖率（v0.4.0 T1）──────────────────────────────────────────────
// 审计门槛用严格逐字子串，与计分用的 evidenceIn（归一化）是两把不同用途的尺子：
// 归一化会放过「仅标点/大小写不同」的引文，不能用来证明「原文逐字引用」。
// 本函数只读 Markdown + 会话原文，不写盘、不改 confidence（verify reports, never rewrites）。

export type QuoteMissReason = 'session-not-found' | 'not-in-user-text';

export interface QuoteMiss {
  topic: string;
  quote: string;
  layer: 'current' | 'legacy';
  reason: QuoteMissReason;
}

export interface QuoteCoverage {
  /** 进入分母的条目数（active + agent + confirmations===0）。 */
  checked: number;
  /** 分母里的引文总条数（零引文条目不贡献）。 */
  quotes: number;
  matched: number;
  /** matched / quotes；quotes===0 时为 null，不伪造 100%。 */
  ratio: number | null;
  misses: QuoteMiss[];
  /** 合法零引文条目（0.35 ungrounded）：单列、不进分母、不判失败。 */
  noQuote: number;
  /** 未纳入审计的条目（stale/archived/manual/llm/过目）。 */
  skipped: number;
  /** v0.5.0 S1-c：每条命中引文的来源会话，供人复核「证据从哪来」。 */
  hits: QuoteHit[];
}

export interface QuoteHit {
  topic: string;
  quote: string;
  layer: 'current' | 'legacy';
  /** 命中的裸 session id（不带 collector 前缀）。 */
  sessionId: string;
  /** 证据域用户文本指纹（evidenceUserKey），与印证去重同口径。 */
  userKey: string;
}

/**
 * 严格逐字引文覆盖率。判定谓词与 `evidenceIn` 刻意不同：
 *   - 这里：原文 `includes`，不小写、不归一化——审计的是「是否逐字抄自 ## user」。
 *   - 计分：`evidenceIn` 走 normalizeForHash——语义等价即可。
 * 会话文本经 `evidenceUserText` 只剥 metadata 围栏，保留原大小写与标点。
 * 扫描全库会话而非只查 session_id：frontmatter 的 source_sessions 可能漏记，
 * 但引文确实存在于某篇会话里，应算命中（不因台账不全造假未命中）。
 */
export function verifyQuoteCoverage(home: string, index: OmemIndex): QuoteCoverage {
  // 一次性构建「证据域原文」池：session key → { 原文, id, 指纹 }。
  // S1-c 把命中来源一并记下，不新增读取通道、不改索引结构。
  interface SessionEvidence { text: string; sessionId: string; userKey: string }
  const userTexts = new Map<string, SessionEvidence>();
  const sessionEvidence: SessionEvidence[] = [];
  for (const path of listStoredSessionFiles(home)) {
    const stored = readStoredSession(path);
    if (!stored) continue;
    const item: SessionEvidence = {
      text: evidenceUserText(stored.body),
      sessionId: stored.sessionId,
      userKey: evidenceUserKey(stored.body),
    };
    userTexts.set(item.sessionId, item);
    userTexts.set(`${stored.agent}:${item.sessionId}`, item);
    sessionEvidence.push(item);
  }
  const sessionTexts = sessionEvidence.map((s) => s.text);

  const misses: QuoteMiss[] = [];
  const hits: QuoteHit[] = [];
  let checked = 0;
  let quotes = 0;
  let matched = 0;
  let noQuote = 0;
  let skipped = 0;

  for (const loc of listEntries(home)) {
    const fm = loc.entry.fm;
    if (fm.status !== 'active' || fm.source !== 'agent' || fm.confirmations > 0) {
      skipped++;
      continue;
    }
    checked++;
    const used = evidenceForScore(fm);
    const layer = fm.evidence_current !== undefined ? 'current' as const : 'legacy' as const;
    if (used.length === 0) {
      noQuote++;
      continue;
    }
    // 该条目声明的来源优先（不重复计入池），再加全库扫描。
    const declared: SessionEvidence[] = [];
    for (const id of [fm.session_id, ...(fm.source_sessions ?? [])]) {
      if (!id) continue;
      const t = userTexts.get(id);
      if (t !== undefined) declared.push(t);
    }
    for (const quote of used) {
      quotes++;
      const found = declared.find((t) => t.text.includes(quote))
        ?? sessionEvidence.find((t) => t.text.includes(quote));
      if (found) {
        matched++;
        hits.push({ topic: fm.topic, quote, layer, sessionId: found.sessionId, userKey: found.userKey });
      } else {
        misses.push({
          topic: fm.topic,
          quote,
          layer,
          reason: declared.length === 0 && sessionTexts.length === 0 ? 'session-not-found' : 'not-in-user-text',
        });
      }
    }
  }

  misses.sort((a, b) => a.topic.localeCompare(b.topic) || a.quote.localeCompare(b.quote));
  return {
    checked,
    quotes,
    matched,
    ratio: quotes === 0 ? null : matched / quotes,
    misses,
    noQuote,
    skipped,
    hits,
  };
}

// applyAssent 已迁至 core/lifecycle.ts：它是「确认刷新」的一种，与 reconfirm 同属
// 生命周期语义，放在 process 层会让 lifecycle ↔ score 成环。此处保持导出，
// 调用方（mcp/tools.ts 与测试）无需改动。
export { applyAssent } from '../core/lifecycle.js';
