// save_memory 的自动置信度。只改 confidence——D2 之后没有别的信任标记。
// 依据必须是会话文件里某个 ## user 段的连续子串；模型引用自己的话不算。
// 比对前先归一化（D8）：复用 normalizeForHash，两条写入路径共用一把尺子。
import { evidenceUserKey, evidenceUserText, readSessionsById, readStoredSession, splitSessionKey } from '../collect/session-store.js';
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

// applyAssent 已迁至 core/lifecycle.ts：它是「确认刷新」的一种，与 reconfirm 同属
// 生命周期语义，放在 process 层会让 lifecycle ↔ score 成环。此处保持导出，
// 调用方（mcp/tools.ts 与测试）无需改动。
export { applyAssent } from '../core/lifecycle.js';
