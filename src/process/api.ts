// 档 3：API 加工的端点/鉴权/模型探测/宽松解析（文档 §3.1–§3.4、§3.10–§3.11、§6.1）。
// 发送内容 = sessions/ 存储正文（已脱敏）；未配置/策略拒绝抛 UsageError(1)，
// 端点不可用抛 BackendUnavailableError(2)，单条传输失败抛 ApiTransportError 由 pipeline 计数。
// 加工语义（§7，prompt v2）：多条 session → 一份 topic 活文档；证据锚定定置信度，不采信模型自评。
import type { OmemConfig } from '../core/config.js';
import type { MemoryType } from '../core/entry.js';
import { inferDomain } from './rules.js';
import { MIN_EVIDENCE } from './score.js';
import { UsageError, BackendUnavailableError } from '../core/util.js';

export const EXTRACT_PROMPT_V2 = `You are a personal memory extractor. Distill long-term living documents from the session.
Output a JSON array only, with no other text. Each item follows this format:
{"topic":"kebab-case-slug","content":"3-10 sentences, conclusions only","type":"preference|fact|decision|experience","domain":"coding|general|...","evidence":["verbatim quote from a user message, at least 12 characters"],"tags":["..."]}
Rules:
- At most 5 items; one topic per item; each topic appears at most once in the array.
- If existing living documents are provided and the session belongs to one of their topics, output the UPDATED full document for that topic (merge the new evidence, keep conclusions only) and reuse its topic slug exactly as given.
- Create a new topic slug only when the session is truly about a new subject; prefer the provided slugs.
- Store conclusions and discard process; do not fabricate.
- evidence strings must be copied verbatim from user messages; do not paraphrase.`;

/** 活文档抽取产物（§7.2 契约；置信度不由模型给出，由证据锚定决定）。 */
export interface DocItem {
  topic: string;
  content: string;
  type: MemoryType;
  domain: string;
  evidence: string[];
  tags: string[];
}

export interface ApiOverrides {
  base?: string;
  model?: string;
  /** CLI 显式 --limit：唯一可越过非本机硬上限 50 的入口（D3）。 */
  limit?: number;
}

export interface ApiRuntimeConfig {
  base: string;
  key: string;
  model: string;
  timeoutMs: number;
  maxInputChars: number;
  limit: number;
  isLocal: boolean;
  /** 请求是否会携带 Authorization（§3.2 规则 1/2）。 */
  keyWillSend: boolean;
  warnings: string[];
  notes: string[];
}

/** 单条传输级失败（HTTP 非 2xx / 超时 / 网络错误）：不写加工状态，计入中止计数。 */
export class ApiTransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiTransportError';
  }
}

/** 模型输出解析失败：计一次解析失败（§3.5 规则 4），不计入中止计数。 */
export class ApiParseError extends Error {
  constructor(readonly raw: string) {
    super('model output is not parseable JSON (raw logged)');
    this.name = 'ApiParseError';
  }
}

/** 回环判定只认字面量（§3.2）：localhost / 127.0.0.0/8 / ::1 / 内嵌 127/8 的 IPv4 映射地址。 */
export function isLoopbackBase(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  return isLoopbackHost(url.hostname);
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv4：127.0.0.0/8
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return Number(v4[1]) === 127;
  // IPv4 映射（::ffff:a.b.c.d 或 URL 规范化后的 ::ffff:XXXX:YYYY）：内嵌 IPv4 属 127/8 才算
  const mapped = h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (mapped) return Number(mapped[1]) === 127;
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    return parseInt(mappedHex[1], 16) >> 8 === 127;
  }
  return false;
}

function envNum(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** env > config.toml [api] > 内置默认（§3.1）；校验 §3.2 安全护栏，不合格抛 UsageError。 */
export function resolveApiConfig(
  config: OmemConfig,
  env: NodeJS.ProcessEnv = process.env,
  over: ApiOverrides = {},
): ApiRuntimeConfig {
  const warnings: string[] = [];
  const notes: string[] = [];
  const base = (over.base ?? env.OMEM_API_BASE ?? config.api.base).replace(/\/+$/, '');
  const key = env.OMEM_API_KEY ?? config.api.key;
  const model = over.model ?? env.OMEM_API_MODEL ?? config.api.model;

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new UsageError(`Invalid API base URL: ${base} (expected e.g. http://localhost:11434/v1)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`Invalid API base URL scheme: ${url.protocol} (expected http: or https:)`);
  }
  // §3.1：必须带 /v1；缺失给可操作提示（不静默改写用户配置）
  if (!/\/v1\/?$/.test(url.pathname)) {
    notes.push(`Base path is ${url.pathname || '/'}; OpenAI-compatible servers usually need a /v1 suffix (e.g. ${base}/v1). Calls will hit ${base}/chat/completions.`);
  }

  const isLocal = isLoopbackHost(url.hostname);
  if (!isLocal && url.protocol === 'http:') {
    throw new UsageError(`Plain http to a non-local endpoint is not allowed: ${base}. Use https:// to send session transcripts off this machine.`);
  }
  if (!key && !isLocal) {
    throw new UsageError(
      `Non-local endpoint requires an API key: session transcripts would be sent unauthenticated to ${base}. `
        + 'Set OMEM_API_KEY or [api].key, or use a loopback endpoint.',
    );
  }

  // §3.6：非本机硬上限 50 只约束 config/env；CLI --limit 是唯一放行入口
  const rawLimit = over.limit ?? envNum(env, 'OMEM_API_LIMIT') ?? config.api.limit ?? 20;
  let limit = rawLimit;
  if (!isLocal && over.limit === undefined && rawLimit > 50) {
    limit = 50;
    warnings.push(`limit ${rawLimit} clamped to 50 for non-local endpoint (config/env); only CLI --limit can exceed 50.`);
  }

  const timeoutMs = envNum(env, 'OMEM_API_TIMEOUT_MS')
    ?? (config.api.timeout_ms > 0 ? config.api.timeout_ms : (isLocal ? 300_000 : 60_000));
  const maxInputChars = envNum(env, 'OMEM_API_MAX_CHARS')
    ?? (config.api.max_input_chars > 0 ? config.api.max_input_chars : (isLocal ? 6_000 : 12_000));

  return {
    base,
    key,
    model,
    timeoutMs,
    maxInputChars,
    limit,
    isLocal,
    keyWillSend: Boolean(key),
    warnings,
    notes,
  };
}

/** 粗估 token 量级（§3.11）：chars/1.5，输出永远带 rough estimate，不接价格表。 */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 1.5);
}

// ── 宽松解析（§3.10）：逐级尝试 + 失败兜底；明确不做语义修复 ──

export type LooseParseResult = { ok: true; value: unknown } | { ok: false; level: number };

/** 级 1：整体 JSON。 */
function level1(text: string): unknown | undefined {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

/** 级 2：剥掉 ```json / ``` 围栏（允许语言标签、缩进、前后空行）后解析。 */
function level2(text: string): unknown | undefined {
  const fenced = text.match(/```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n\s*```/);
  const inner = fenced ? fenced[1] : undefined;
  return inner === undefined ? undefined : level1(inner);
}

/**
 * 级 3：括号计数取第一个平衡切片（字符串感知）。
 * 引号内括号不计数；反斜杠跳过下一字符（任意 \X，含 \\）；引号自身失衡 → 该级失败。
 */
function level3(text: string): unknown | undefined {
  const start = text.search(/[{\[]/);
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++; // 跳过转义的下一字符（\X 一律吞掉，含 \\ 与 \"）
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return level1(text.slice(start, i + 1));
    }
  }
  return undefined; // 括号不平衡 / 字符串未闭合
}

/** 三级降级 + 兜底。失败级别仅用于诊断；raw 由调用方截断写日志。 */
export function parseLooseJson(text: string): LooseParseResult {
  const a = level1(text);
  if (a !== undefined) return { ok: true, value: a };
  const b = level2(text);
  if (b !== undefined) return { ok: true, value: b };
  const c = level3(text);
  if (c !== undefined) return { ok: true, value: c };
  return { ok: false, level: 3 };
}

// ── HTTP 层 ──

function authHeaders(cfg: ApiRuntimeConfig): Record<string, string> {
  // §3.2：空 key 不发 Authorization（不是发 Bearer undefined）；有 key 一律发（llama-server --api-key）
  return cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {};
}

/** 探测端点上的模型列表（§3.3）；失败抛 UsageError 要求显式 --model。 */
export async function probeModels(cfg: ApiRuntimeConfig): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${cfg.base}/models`, {
      method: 'GET',
      headers: { ...authHeaders(cfg) },
      signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 30_000)),
    });
  } catch (e) {
    throw new UsageError(`Model probe failed for ${cfg.base}: ${(e as Error).message}. Set [api].model or --model explicitly.`);
  }
  if (!res.ok) {
    throw new UsageError(`Model probe failed for ${cfg.base}: HTTP ${res.status}. Set [api].model or --model explicitly.`);
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new UsageError(`Model probe returned non-JSON from ${cfg.base}. Set [api].model or --model explicitly.`);
  }
  const ids: string[] = Array.isArray(data?.data) ? data.data.map((m: any) => String(m?.id ?? '')).filter(Boolean) : [];
  if (ids.length === 0) {
    throw new UsageError(`No models listed at ${cfg.base}. Set [api].model or --model explicitly.`);
  }
  return ids;
}

/** 解析生效模型：显式给了就用；否则每运行探测一次 /v1/models，取第一个 id。 */
export async function resolveModel(cfg: ApiRuntimeConfig): Promise<{ model: string; notes: string[] }> {
  if (cfg.model) return { model: cfg.model, notes: [] };
  const ids = await probeModels(cfg);
  const notes: string[] = [];
  if (ids.length > 1) {
    notes.push(`models available: ${ids.join(', ')}; using ${ids[0]}; set [api].model or --model to override.`);
  }
  return { model: ids[0], notes };
}

export interface ExtractInput {
  /** sessions/ 存储正文（入库时已过 redactSecrets，§6.1：不另拼原文）。 */
  body: string;
  projectFp: string;
  sessionId: string;
  /** 注入的该项目既有 active 活文档（§7.2）；无 project 的会话为空数组（边界：只新建 topic）。 */
  existingDocs: { topic: string; content: string }[];
}

/** 截断保留最近 N 字符（§3.6），头部标注 (truncated)。 */
export function truncateBody(body: string, maxInputChars: number): string {
  if (body.length <= maxInputChars) return body;
  return `(truncated)\n${body.slice(-maxInputChars)}`;
}

/**
 * 调用 OpenAI 兼容 chat completions 加工一个会话 → 活文档（source: 'llm'）。
 * 传输级失败抛 ApiTransportError；输出解析失败抛 ApiParseError（raw 在内）。
 * 响应校验（§7.2/V31）：≤5 份、topic 唯一（重复取第一份）、evidence ≥12 原文字符——违规项跳过并记进 notes。
 */
export async function extractWithApi(
  input: ExtractInput,
  cfg: ApiRuntimeConfig,
  model: string,
): Promise<{ docs: DocItem[]; notes: string[] }> {
  const notes: string[] = [];
  const transcript = truncateBody(input.body, cfg.maxInputChars);
  let userMsg = `Session (project ${input.projectFp}):\n${transcript}`;
  if (input.existingDocs.length > 0) {
    // §7.2 增量合并的实现机制：模型看得见既有活文档全文，同主题输出更新版
    userMsg += `\n\nExisting living documents for this project (if this session belongs to one of these topics, output the updated full document and reuse its topic slug exactly; otherwise create a new topic):\n`
      + input.existingDocs.map((d) => `--- topic: ${d.topic}\n${d.content}`).join('\n\n');
  }
  let res: Response;
  try {
    res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(cfg),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: EXTRACT_PROMPT_V2 },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new ApiTransportError(timedOut ? `timeout after ${cfg.timeoutMs}ms` : err.message);
  }
  if (!res.ok) throw new ApiTransportError(`HTTP ${res.status}`, res.status);

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new ApiParseError('');
  }
  const text: string = String(data?.choices?.[0]?.message?.content ?? '');
  const parsed = parseLooseJson(text);
  if (!parsed.ok) throw new ApiParseError(text);
  if (!Array.isArray(parsed.value)) throw new ApiParseError(text);

  const rawItems = parsed.value;
  const items = rawItems.slice(0, 5);
  if (rawItems.length > 5) notes.push(`response has ${rawItems.length} docs; keeping first 5`);
  const out: DocItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) continue;
    const topic = typeof item.topic === 'string' ? item.topic.trim() : '';
    if (!topic) {
      notes.push('doc without topic skipped');
      continue;
    }
    if (seen.has(topic)) {
      notes.push(`duplicate topic ${topic} in one response; keeping first`);
      continue;
    }
    seen.add(topic);
    const type = (['preference', 'fact', 'decision', 'experience'] as const).includes(item.type) ? item.type : 'fact';
    const rawEvidence: string[] = Array.isArray(item.evidence) ? item.evidence.map(String).map((e: string) => e.trim()) : [];
    const evidence = rawEvidence.filter((e: string) => [...e].length >= MIN_EVIDENCE);
    if (evidence.length < rawEvidence.length) notes.push(`doc ${topic}: ${rawEvidence.length - evidence.length} evidence string(s) below ${MIN_EVIDENCE} chars dropped`);
    out.push({
      topic,
      content: item.content.trim(),
      type,
      domain: typeof item.domain === 'string' && item.domain ? item.domain : inferDomain(item.content),
      evidence,
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    });
  }
  return { docs: out, notes };
}

/** §6.2：未配置文案（档 0 已移除，不能再引用）。 */
export function apiSetupHint(): string {
  return 'API tier is not configured. Set OMEM_API_KEY / OMEM_API_BASE / OMEM_API_MODEL (OpenAI-compatible endpoint) and retry; conclusions can also be written via save_memory or omem add.';
}

/** 连续传输失败中止（§3.4）：exit 2，提示看 api status。 */
export function endpointUnavailableError(failures: number): BackendUnavailableError {
  return new BackendUnavailableError(
    `endpoint appears unavailable (${failures} consecutive transport failures); partial results kept`,
    'run omem api status',
  );
}
