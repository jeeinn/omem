// 记忆条目数据模型：frontmatter 契约（规格 §2.2）+ Markdown 序列化/解析。
// YAML 子集：扁平 key: value，值 ∈ 字符串 / 数字 / 布尔 / [字符串数组]。
// 一条记忆 = 一个文件（规格 §2.1）。

export type MemoryType = 'preference' | 'fact' | 'decision' | 'experience';
/** `superseded` 已随 D1-B′ 删除：更新 = 重写同一份文件，版本由 git 承担。 */
export type EntryStatus = 'active' | 'stale' | 'archived';
export type Profile = 'home' | 'work';
export type EntrySource = 'rules' | 'agent' | 'llm' | 'manual';

export interface Frontmatter {
  /**
   * 身份 = 文件名（D1-B′）。**不从磁盘读、不落盘**：`parseEntry(text, path)` 由路径注入，
   * `serializeEntry` 跳过它。这样「主题名」只有一个事实源（文件名），不存在字段与路径漂移。
   */
  topic: string;
  type: MemoryType;
  domain: string;
  profile: Profile;
  status: EntryStatus;
  confidence: number;
  /**
   * D2：`verified` 已删除。信任只有一个数字——`confidence`，且它永远描述**当前这份正文**。
   * 「人看过」由 `confirmations > 0` + `last_confirmed` 表达（过目 = 提到 0.9）。
   * 布尔标记会在原地更新下退化成「这个主题曾被人看过一次」。
   */
  source: EntrySource;
  session_id?: string;
  project?: string;
  /** 已吸收进这份活文档的会话 id。 */
  source_sessions: string[];
  /** 证据锚定原文（文档 §7.2）：从 ## user 段原样摘出，归一化只用于比对、不写进文档。 */
  evidence: string[];
  created: string;
  last_confirmed: string;
  confirmations: number;
  tags: string[];
}

export interface Entry {
  fm: Frontmatter;
  body: string;
}

/** 落盘顺序。`topic` 不在其中——它是文件名，不是字段。 */
const FM_ORDER: (keyof Frontmatter)[] = [
  'type', 'domain', 'profile', 'status', 'confidence', 'source',
  'session_id', 'project', 'source_sessions', 'evidence', 'created', 'last_confirmed', 'confirmations',
  'tags',
];

/** 允许序列化的键（防止 `topic` 被误写进 frontmatter——那会让身份重新变成两个）。 */
const PERSISTED = new Set<string>(FM_ORDER);

export { PERSISTED as PERSISTED_FM_KEYS };

export function serializeEntry(e: Entry): string {
  const lines: string[] = ['---'];
  for (const key of FM_ORDER) {
    const v = e.fm[key];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      lines.push(`${key}: [${v.map((x) => `"${escapeFmString(String(x))}"`).join(', ')}]`);
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${key}: ${v}`);
    } else {
      lines.push(`${key}: ${String(v)}`);
    }
  }
  lines.push('---', '', e.body.trimEnd(), '');
  return lines.join('\n');
}

/** 数组元素的单行转义：`\` `"` 与换行必须可逆（evidence 原文含逗号/引号/换行时仍无损往返）。 */
function escapeFmString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function unescapeFmString(s: string): string {
  return s.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
}

/**
 * 解析一份记忆文件。
 *
 * `path` 不是可选的装饰：topic 是身份、只存在于文件名里，不传路径就得不到 topic。
 * 只有纯文本场景（测试、快照比对）才允许省略，此时 `fm.topic` 为空串。
 */
export function parseEntry(text: string, path?: string): Entry | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, any> = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1]] = parseFmValue(kv[2].trim());
  }
  if (!fm.type) return null;
  const entry: Entry = { fm: normalizeFm(fm), body: m[2].trim() };
  if (path) entry.fm.topic = topicFromPath(path);
  return entry;
}

/** 路径 → topic：`<domain>/<topic>.md` 取 basename；`.conflict.md` 归到原主题。 */
export function topicFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  return name.replace(/\.conflict\.md$/i, '').replace(/\.md$/i, '');
}

function parseFmValue(v: string): any {
  if (v.startsWith('[') && v.endsWith(']')) {
    return splitFmArray(v.slice(1, -1));
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^"(.*)"$/, '$1');
}

/** 字符串感知的数组切分：引号内的逗号不算分隔，`\"`/`\\`/转义换行可逆。 */
function splitFmArray(inner: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === '\\') {
        buf += ch + (inner[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === '"') inStr = false;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .map((s) => unescapeFmString(s))
    .filter((s) => s.length > 0);
}

/**
 * 磁盘字段 → Frontmatter。
 *
 * 三个容忍点，都是为了「旧库不会被解析成垃圾」：
 * - `status: superseded` 映射成 `archived`（旧版的非活跃状态统一归为归档，默认不参与检索）；
 * - 旧的 `id` / `supersedes` / `superseded_by` 字段直接丢弃（D9：不兼容，要求 re-init）；
 * - 旧的 `verified` 字段直接丢弃（D2：信任只剩 confidence 一个数字）。
 */
function normalizeFm(fm: Record<string, any>): Frontmatter {
  const str = (v: any, d = '') => (typeof v === 'string' && v ? v : d);
  const num = (v: any, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const arr = (v: any): string[] => (Array.isArray(v) ? v.map(String) : []);
  const type = (['preference', 'fact', 'decision', 'experience'] as const).includes(fm.type) ? fm.type : 'fact';
  const rawStatus = fm.status === 'superseded' ? 'archived' : fm.status;
  const status = (['active', 'stale', 'archived'] as const).includes(rawStatus) ? rawStatus : 'active';
  const profile = fm.profile === 'work' ? 'work' : 'home';
  const source = (['rules', 'agent', 'llm', 'manual'] as const).includes(fm.source) ? fm.source : 'manual';
  const now = new Date().toISOString();
  return {
    topic: '',
    type,
    domain: str(fm.domain, 'general'),
    profile,
    status,
    confidence: Math.min(1, Math.max(0, num(fm.confidence, 0.5))),
    source,
    session_id: fm.session_id ? String(fm.session_id) : undefined,
    project: fm.project ? String(fm.project) : undefined,
    source_sessions: arr(fm.source_sessions),
    evidence: arr(fm.evidence),
    created: str(fm.created, now),
    last_confirmed: str(fm.last_confirmed, str(fm.created, now)),
    confirmations: num(fm.confirmations, 0),
    tags: arr(fm.tags),
  };
}

/** 新建 frontmatter 的默认值（调用方覆盖）。`topic` 是必填身份。 */
export function newFrontmatter(partial: Partial<Frontmatter> & Pick<Frontmatter, 'topic' | 'type' | 'domain'>): Frontmatter {
  const now = new Date().toISOString();
  return {
    profile: 'home',
    status: 'active',
    confidence: 0.5,
    source: 'manual',
    created: now,
    last_confirmed: now,
    confirmations: 0,
    source_sessions: [],
    evidence: [],
    tags: [],
    ...partial,
  };
}

/**
 * 证据链合并（活文档更新时用）：本次的优先，旧版按原顺序补，去重后截断。
 *
 * 为什么不能全量继承：evidence 是「从 `## user` 段摘出的原文」，每更新一代就多一条。
 * 不设上限会让 frontmatter 无限膨胀，拖慢解析与索引。8 条 / 2000 字符足够覆盖
 * 「这条结论由哪些原话支撑」，同时保证本次写入的证据一定留下。
 */
export function mergeEvidence(
  fresh: string[],
  inherited: string[][],
  limit = 8,
  maxChars = 2000,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  const push = (raw: string): void => {
    const value = raw.trim();
    if (!value || seen.has(value)) return;
    if (out.length >= limit) return;
    if (chars + value.length > maxChars) return;
    seen.add(value);
    out.push(value);
    chars += value.length;
  };
  for (const e of fresh) push(e);
  for (const list of inherited) for (const e of list) push(e);
  return out;
}

/**
 * 近似主题判据（规格 §7.4-3）：归一化后互为前缀、或去掉分隔符后相同，且不是同一个 topic。
 * 放在 core 是因为所有写入路径都要用它——API 档曾经是唯一检查点，Agent 路径没有护栏。
 */
export function isNearDupTopic(a: string, b: string): boolean {
  if (a === b) return false;
  const strip = (s: string): string => s.replace(/[-_]/g, '');
  return a.startsWith(b) || b.startsWith(a) || strip(a) === strip(b);
}

/**
 * 域名归一化。domain 是唯一进入文件路径的自由输入（id/created 由程序生成），
 * 不校验就能用 `domain: "../../x"` 把文件写出知识库。规则：保留 a-z0-9 与
 * 中日韩字符，其余折叠为 '-'；空值回落 'general'。
 */
export function normalizeDomain(raw: string | undefined): string {
  if (!raw) return 'general';
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'general';
}

/** topic 的长度上限（code point）。文件名要留在 Windows 260 字符路径内。 */
export const MAX_TOPIC_CHARS = 64;

/** Windows 保留设备名：不能直接做文件名，加前缀而不是拒绝（拒绝会打断写入）。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/**
 * 主题归一化（D1-B′：topic 即身份 → 这里的规则同时是**路径安全规则**）。
 *
 * 历史教训：topic 曾经只是 frontmatter 字段，清洗随意；一旦它变成文件名，
 * `../../x` 就能把文件写出知识库。所以字符政策与 `normalizeDomain` 对齐：
 * 只保留字母（含 CJK）/数字/下划线/连字符，其余折叠为 '-'。
 *
 * 与 `normalizeDomain` 的差别只有两处，都是因为它是「身份」而非「分类」：
 * 长度有上限（按 code point 截断，不硬切 surrogate）、Windows 保留名加前缀。
 */
export function normalizeTopic(raw: string): string | undefined {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const clipped = [...cleaned].slice(0, MAX_TOPIC_CHARS).join('').replace(/-+$/, '');
  if (!clipped) return undefined;
  return WINDOWS_RESERVED.test(clipped) ? `topic-${clipped}` : clipped;
}

/** 标题 = 正文首行（截断）；用于检索摘要行与 MEMORY-INDEX。 */
export function deriveTitle(body: string, max = 60): string {
  const first = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const clean = first.replace(/^[#>\-\s]+/, '');
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '…';
}

/**
 * 摘要 = 前两句（中英句界均支持；无句界时按 code point 截断）。
 *
 * 句界判定不能对拉丁标点一视同仁：`sys_service.status != 0` 会被旧正则切成
 * `sys_service.status !` —— 代码里的 `.` 与 `!=` 的 `!` 都被当成了句末。
 * 规则：CJK 句末符（。！？）即时生效；拉丁 `.` `!` `?` 只有后接空白或行尾才算句界。
 * 库里 coding 域占绝大多数，这个坑的覆盖面比看起来大。
 */
export function deriveSummary(body: string, max = 120): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const s = firstSentences(flat, 2);
  return [...s].length <= max ? s : [...s].slice(0, max - 1).join('') + '…';
}

function firstSentences(text: string, count: number): string {
  let out = '';
  let taken = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += ch;
    const cjk = ch === '。' || ch === '！' || ch === '？';
    const latin = (ch === '.' || ch === '!' || ch === '?')
      && (i + 1 >= text.length || /\s/.test(text[i + 1]));
    if (!cjk && !latin) continue;
    taken++;
    if (taken >= count) break;
  }
  return out.trim();
}
