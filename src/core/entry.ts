// 记忆条目数据模型：frontmatter 契约（规格 §2.2）+ Markdown 序列化/解析。
// YAML 子集：扁平 key: value，值 ∈ 字符串 / 数字 / 布尔 / [字符串数组]。
// 一条记忆 = 一个文件（规格 §2.1）。

export type MemoryType = 'preference' | 'fact' | 'decision' | 'experience';
export type EntryStatus = 'active' | 'stale' | 'superseded' | 'archived';
export type Profile = 'home' | 'work';
export type EntrySource = 'rules' | 'agent' | 'llm' | 'manual';

export interface Frontmatter {
  id: string;
  type: MemoryType;
  domain: string;
  profile: Profile;
  status: EntryStatus;
  confidence: number;
  verified: boolean;
  source: EntrySource;
  session_id?: string;
  project?: string;
  /** L1 活文档主题。同一主题同时只有一份 active。 */
  topic?: string;
  /** 已吸收进这份活文档的会话 id。 */
  source_sessions: string[];
  /** 证据锚定原文（文档 §7.2）：从 ## user 段原样摘出，归一化只用于比对、不写进文档。 */
  evidence: string[];
  created: string;
  last_confirmed: string;
  confirmations: number;
  supersedes: string[];
  superseded_by?: string;
  tags: string[];
}

export interface Entry {
  fm: Frontmatter;
  body: string;
}

const FM_ORDER: (keyof Frontmatter)[] = [
  'id', 'type', 'domain', 'profile', 'status', 'confidence', 'verified', 'source',
  'session_id', 'project', 'topic', 'source_sessions', 'evidence', 'created', 'last_confirmed', 'confirmations',
  'supersedes', 'superseded_by', 'tags',
];

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

export function parseEntry(text: string): Entry | null {
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
  if (!fm.id || !fm.type) return null;
  return { fm: normalizeFm(fm), body: m[2].trim() };
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

function normalizeFm(fm: Record<string, any>): Frontmatter {
  const str = (v: any, d = '') => (typeof v === 'string' && v ? v : d);
  const num = (v: any, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const arr = (v: any): string[] => (Array.isArray(v) ? v.map(String) : []);
  const type = (['preference', 'fact', 'decision', 'experience'] as const).includes(fm.type) ? fm.type : 'fact';
  const status = (['active', 'stale', 'superseded', 'archived'] as const).includes(fm.status) ? fm.status : 'active';
  const profile = fm.profile === 'work' ? 'work' : 'home';
  const source = (['rules', 'agent', 'llm', 'manual'] as const).includes(fm.source) ? fm.source : 'manual';
  const now = new Date().toISOString();
  return {
    id: str(fm.id),
    type,
    domain: str(fm.domain, 'general'),
    profile,
    status,
    confidence: Math.min(1, Math.max(0, num(fm.confidence, 0.5))),
    verified: Boolean(fm.verified),
    source,
    session_id: fm.session_id ? String(fm.session_id) : undefined,
    project: fm.project ? String(fm.project) : undefined,
    topic: fm.topic ? String(fm.topic) : undefined,
    source_sessions: arr(fm.source_sessions),
    evidence: arr(fm.evidence),
    created: str(fm.created, now),
    last_confirmed: str(fm.last_confirmed, str(fm.created, now)),
    confirmations: num(fm.confirmations, 0),
    supersedes: arr(fm.supersedes),
    superseded_by: fm.superseded_by ? String(fm.superseded_by) : undefined,
    tags: arr(fm.tags),
  };
}

/** 新建 frontmatter 的默认值（调用方覆盖）。 */
export function newFrontmatter(partial: Partial<Frontmatter> & Pick<Frontmatter, 'id' | 'type' | 'domain'>): Frontmatter {
  const now = new Date().toISOString();
  return {
    profile: 'home',
    status: 'active',
    confidence: 0.5,
    verified: false,
    source: 'manual',
    created: now,
    last_confirmed: now,
    confirmations: 0,
    supersedes: [],
    source_sessions: [],
    evidence: [],
    tags: [],
    ...partial,
  };
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

/** 标题 = 正文首行（截断）；用于检索摘要行与 MEMORY-INDEX。 */
export function deriveTitle(body: string, max = 60): string {
  const first = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const clean = first.replace(/^[#>\-\s]+/, '');
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '…';
}

/** 摘要 = 前两句（中英句界均支持；无句界时按 code point 截断）。 */
export function deriveSummary(body: string, max = 120): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^(?:[^。！？.!?]+[。！？.!?]){1,2}/);
  const s = m ? m[0] : flat;
  return [...s].length <= max ? s : [...s].slice(0, max - 1).join('') + '…';
}
