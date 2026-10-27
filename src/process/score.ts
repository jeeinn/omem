// save_memory 的自动置信度。只改 confidence，不把 verified 设为 true。
// 依据必须是会话文件里某个 ## user 段的连续子串；模型引用自己的话不算。
// 比对前先归一化（D8）：复用 normalizeForHash，两条写入路径共用一把尺子。
import { readSessionsById, readStoredSession, splitSessionKey, userSectionText } from '../collect/session-store.js';
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

export interface ScoreResult {
  confidence: number;
  tags: string[];
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
  /** 独立印证会话数（去重 sessionId） */
  count: number;
  /** 印证来源的去重项目指纹数 */
  uniqueProjects: number;
}

/** 用会话全文索引缩小范围，再对 user 段做归一化子串比对；跳过 source 会话避免自印证。 */
function corroboratingSessions(index: OmemIndex, evidence: string, skipIds?: string | string[]): CorroborationInfo {
  const probe = [...evidence].slice(0, 24).join('');
  const hits = searchSessions(index, probe, 8);
  const skipSet = new Set(Array.isArray(skipIds) ? skipIds : (skipIds ? [skipIds] : []));
  const seenSessions = new Set<string>();
  const seenProjects = new Set<string>();
  for (const hit of hits) {
    const id = splitSessionKey(hit.session_key).sessionId;
    if (!id || skipSet.has(id) || seenSessions.has(id)) continue;
    const stored = readStoredSession(hit.path);
    if (!stored) continue;
    if (!evidenceIn(userSectionText(stored.body), evidence)) continue;
    seenSessions.add(id);
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
  const primary = evidences[0] ?? '';
  const tags: string[] = [];
  // 引用会话：主 sessionId + 新增吸收的 sessionIds 合并用于 cited 检查
  const allSessionIds = [input.sessionId, ...(input.sessionIds ?? [])].filter((id): id is string => Boolean(id));
  const cited = allSessionIds.length > 0
    ? allSessionIds.flatMap((id) => readSessionsById(home, id))
    : [];
  const citedHit = evidences.length > 0 && evidences.some((e) => cited.some((s) => evidenceIn(userSectionText(s.body), e)));
  let base = SCORE_UNGROUNDED;
  let grounded = false;

  if (evidences.length === 0 && cited.length === 0) {
    base = SCORE_GROUNDED;
    tags.push('pending-session');
  } else if (citedHit) {
    // 多证据：对每条 evidence 独立查印证，取最佳（与 scoreApiDoc reduce 同口径）
    const others = index
      ? evidences.reduce<CorroborationInfo>((acc, e) => {
          const info = corroboratingSessions(index, e, allSessionIds);
          return {
            count: Math.max(acc.count, info.count),
            uniqueProjects: Math.max(acc.uniqueProjects, info.uniqueProjects),
          };
        }, { count: 0, uniqueProjects: 0 })
      : { count: 0, uniqueProjects: 0 };
    base = SCORE_GROUNDED + corroborationBonus(others);
    grounded = true;
  } else if (evidences.length > 0 && allSessionIds.length === 0 && index) {
    const info = evidences.reduce<CorroborationInfo>((acc, e) => {
      const cur = corroboratingSessions(index, e);
      return {
        count: Math.max(acc.count, cur.count),
        uniqueProjects: Math.max(acc.uniqueProjects, cur.uniqueProjects),
      };
    }, { count: 0, uniqueProjects: 0 });
    if (info.count > 0) {
      base = SCORE_GROUNDED + corroborationBonus(info);
      grounded = true;
    } else {
      tags.push('ungrounded');
    }
  } else {
    tags.push('ungrounded');
  }

  if (!grounded && !tags.includes('pending-session') && !tags.includes('ungrounded')) tags.push('ungrounded');

  const confidence = Math.min(SCORE_AUTO_CAP, base);
  return { confidence, tags };
}

/**
 * API 档活文档的证据锚定（文档 §7.1）：不采信模型自评，置信度由 evidence 锚定决定。
 * 复用与 scoreEvidence 同一套梯级口径：锚得上 → 0.55 起；
 * 多会话印证 / 跨项目印证按 corroborationBonus 叠加（封顶 +0.25）；
 * 一条都锚不上 → 0.35 + `ungrounded`（仍落盘）。
 * 上限 0.75（SCORE_API_CAP）、verified 恒 false 由调用方保证。
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
    const citedHit = valid.some((e) => cited.some((s) => evidenceIn(userSectionText(s.body), e)));
    if (citedHit) {
      const others = index
        ? valid.reduce<CorroborationInfo>((acc, e) => {
            const info = corroboratingSessions(index, e, input.sessionId);
            return {
              count: Math.max(acc.count, info.count),
              uniqueProjects: Math.max(acc.uniqueProjects, info.uniqueProjects),
            };
          }, { count: 0, uniqueProjects: 0 })
        : { count: 0, uniqueProjects: 0 };
      base = SCORE_GROUNDED + corroborationBonus(others);
      tags = [];
    } else if (!input.sessionId && index) {
      // 无引用会话时退化为全库印证（与 scoreEvidence 的无 sessionId 分支同一口径）
      const info = valid.reduce<CorroborationInfo>((acc, e) => {
        const cur = corroboratingSessions(index, e);
        return {
          count: Math.max(acc.count, cur.count),
          uniqueProjects: Math.max(acc.uniqueProjects, cur.uniqueProjects),
        };
      }, { count: 0, uniqueProjects: 0 });
      if (info.count > 0) {
        base = SCORE_GROUNDED + corroborationBonus(info);
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
