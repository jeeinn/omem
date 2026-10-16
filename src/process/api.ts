// 档 3：自带 API key 加工（规格 §9.4，可选开关，默认关）。
// OpenAI 兼容端点 + 轻模型；prompt 版本化（本常量即 v1，进 git）。
import type { SessionDigest } from '../collect/types.js';
import type { Candidate } from './rules.js';
import { inferDomain } from './rules.js';

export const EXTRACT_PROMPT_V1 = `You are a personal memory extractor. Distill entries worth remembering long-term from the session.
Output a JSON array only, with no other text. Each item follows this format:
{"type":"preference|fact|decision|experience","domain":"coding|general|...","content":"3-10 sentences, faithful to the original","confidence":0.0-1.0,"tags":["..."]}
Rules: store conclusions and discard process; do not fabricate; lower confidence for imperative tone; one item per entry.`;

export function apiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OMEM_API_KEY && env.OMEM_API_BASE && env.OMEM_API_MODEL);
}

export function apiSetupHint(): string {
  return 'Tier 3 is not configured. Set OMEM_API_KEY / OMEM_API_BASE / OMEM_API_MODEL (OpenAI-compatible endpoint) and retry; or use the default tier 0 (zero-config rule extraction).';
}

/** 调用 OpenAI 兼容 chat completions 提炼一个会话 → 候选条目（source: 'llm'）。 */
export async function extractWithApi(digest: SessionDigest, env: NodeJS.ProcessEnv = process.env): Promise<Candidate[]> {
  const transcript = digest.messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n')
    .slice(0, 12000);
  const res = await fetch(`${env.OMEM_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OMEM_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OMEM_API_MODEL,
      messages: [
        { role: 'system', content: EXTRACT_PROMPT_V1 },
        { role: 'user', content: `Session (project ${digest.project_fp}):\n${transcript}` },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Tier 3 API call failed: HTTP ${res.status}`);
  const data: any = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? '';
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: any[];
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Candidate[] = [];
  for (const item of arr) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) continue;
    const type = (['preference', 'fact', 'decision', 'experience'] as const).includes(item.type) ? item.type : 'fact';
    const conf = typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.6;
    out.push({
      type,
      domain: typeof item.domain === 'string' && item.domain ? item.domain : inferDomain(item.content),
      content: item.content.trim(),
      confidence: conf,
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      project_fp: digest.project_fp,
      session_id: digest.session_id,
      source: 'llm',
    });
  }
  return out;
}
