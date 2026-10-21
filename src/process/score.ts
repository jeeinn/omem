// save_memory 的自动置信度。只改 confidence，不把 verified 设为 true。
// 依据必须是会话文件里某个 ## user 段的连续子串；模型引用自己的话不算。
// 比对前先归一化（D8）：复用 normalizeForHash，两条写入路径共用一把尺子。
import { readSessionsById, readStoredSession, splitSessionKey, userSectionText } from '../collect/session-store.js';
import { searchSessions } from '../core/search.js';
import { updateEntry } from '../core/store.js';
import { serializeEntry } from '../core/entry.js';
import { normalizeForHash } from '../core/util.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import type { OmemIndex } from '../core/index.js';

export const SCORE_GROUNDED = 0.55;
export const SCORE_CORROBORATED = 0.75;
export const SCORE_UNGROUNDED = 0.35;
export const SCORE_AUTO_CAP = 0.8;
export const SCORE_CONFIRMED = 0.9;
/** API 档产物的硬上限（D2）：没人看过的产物不进高置信区间。 */
export const SCORE_API_CAP = 0.75;

const INSTRUCTION_TONE = /(以后总是|必须|一律|永远|每次都要|无条件|务必|always must)/;
/** evidence 原文门槛（§7.2）：归一化只用于比对，不用于量长度。 */
export const MIN_EVIDENCE = 12;

export interface ScoreInput {
  content: string;
  sessionId?: string;
  evidence?: string;
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

/** 用会话全文索引缩小范围，再对 user 段做归一化子串比对。 */
function corroboratingSessions(index: OmemIndex, evidence: string, skipId?: string): number {
  const probe = [...evidence].slice(0, 24).join('');
  const hits = searchSessions(index, probe, 8);
  const seen = new Set<string>();
  for (const hit of hits) {
    const id = splitSessionKey(hit.session_key).sessionId;
    if (!id || id === skipId || seen.has(id)) continue;
    const stored = readStoredSession(hit.path);
    if (!stored) continue;
    if (!evidenceIn(userSectionText(stored.body), evidence)) continue;
    seen.add(id);
  }
  return seen.size;
}

/** 按依据给结论打分。自动分不超过 0.8。传入 index 时用 sessions_fts 找印证，不扫全部会话文件。 */
export function scoreEvidence(home: string, input: ScoreInput, index?: OmemIndex): ScoreResult {
  const evidence = (input.evidence ?? '').trim();
  const tags: string[] = [];
  const cited = input.sessionId ? readSessionsById(home, input.sessionId) : [];
  const citedHit = cited.some((s) => evidenceIn(userSectionText(s.body), evidence));
  const longEnough = charLen(evidence) >= MIN_EVIDENCE;
  let base = SCORE_UNGROUNDED;
  let grounded = false;

  if (!evidence && cited.length === 0) {
    base = SCORE_GROUNDED;
    tags.push('pending-session');
  } else if (longEnough && citedHit) {
    const others = index ? corroboratingSessions(index, evidence, input.sessionId) : 0;
    base = others >= 1 ? SCORE_CORROBORATED : SCORE_GROUNDED;
    grounded = true;
  } else if (longEnough && !input.sessionId && index) {
    const hits = corroboratingSessions(index, evidence);
    if (hits > 0) {
      base = hits >= 2 ? SCORE_CORROBORATED : SCORE_GROUNDED;
      grounded = true;
    } else {
      tags.push('ungrounded');
    }
  } else {
    tags.push('ungrounded');
  }

  if (!grounded && !tags.includes('pending-session') && !tags.includes('ungrounded')) tags.push('ungrounded');

  let confidence = base;
  if (INSTRUCTION_TONE.test(input.content) || INSTRUCTION_TONE.test(evidence)) {
    confidence = Math.round(confidence * 0.5 * 100) / 100;
    tags.push('low-weight');
  }
  confidence = Math.min(SCORE_AUTO_CAP, confidence);
  return { confidence, tags };
}

/**
 * API 档活文档的证据锚定（文档 §7.1）：不采信模型自评，置信度由 evidence 锚定决定。
 * 完全沿用现有口径：锚得上 → 0.55 起；两个及以上会话互相印证 → 0.75；
 * 一条都锚不上 → 0.35 + `ungrounded`（仍落盘）；祈使语气减半 + `low-weight`。
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
      const others = index ? Math.max(...valid.map((e) => corroboratingSessions(index, e, input.sessionId))) : 0;
      base = others >= 1 ? SCORE_CORROBORATED : SCORE_GROUNDED;
      tags = [];
    } else if (!input.sessionId && index) {
      // 无引用会话时退化为全库印证（与 scoreEvidence 的无 sessionId 分支同一口径）
      const hits = Math.max(...valid.map((e) => corroboratingSessions(index, e)));
      if (hits >= 2) {
        base = SCORE_CORROBORATED;
        tags = [];
      } else if (hits === 1) {
        base = SCORE_GROUNDED;
        tags = [];
      }
    }
  }

  if (INSTRUCTION_TONE.test(input.content)) {
    base = Math.round(base * 0.5 * 100) / 100;
    tags.push('low-weight');
  }
  return { confidence: Math.min(SCORE_API_CAP, base), tags };
}

/**
 * 对话里的一次确认：分数提到自动上限，verified 保持原样。
 * omem 看不到聊天记录，不能据此把条目标成已确认。
 */
export function applyAssent(home: string, index: OmemIndex, ids: string[]): { updated: string[]; missing: string[] } {
  const updated: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const loc = updateEntry(home, id, (fm) => {
      if (fm.confidence < SCORE_AUTO_CAP) fm.confidence = SCORE_AUTO_CAP;
      if (!fm.tags.includes('assent')) fm.tags.push('assent');
      fm.confirmations += 1;
    });
    if (!loc) {
      missing.push(id);
      continue;
    }
    index.upsert(loc.entry, loc.path, serializeEntry(loc.entry));
    updated.push(id);
  }
  if (updated.length > 0) generateMemoryIndex(home, index);
  return { updated, missing };
}
