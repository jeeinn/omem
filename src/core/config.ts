// config.toml —— 唯一配置入口（规格 §2.1）。
// 实现为 TOML 子集解析/序列化：章节 + key=value + 字符串/数字/布尔/字符串数组。
// 只保证对 omem 自己写出的文件无损往返；遇无法解析的行整体报错（调用方降级提示）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './util.js';

export type Profile = 'home' | 'work';
export type SyncBackendId = 'git' | 'webdav' | 'dir';
export type Tier = 'rules' | 'agent' | 'api';

export interface OmemConfig {
  general: { profile: Profile };
  collect: {
    claude_projects: string;
    workbuddy_projects: string;
    cursor_projects: string;
    qwenwork_projects: string;
    exclude_paths: string[];
  };
  process: { default_tier: Tier; stale_after_days: number; stale_weight: number; max_content_chars: number };
  /** 档 3（API 加工）端点配置（文档 §3.1）。timeout_ms / max_input_chars 为 0 时按端点类型取默认。 */
  api: {
    base: string;
    key: string;
    model: string;
    timeout_ms: number;
    max_input_chars: number;
    limit: number;
  };
  search: { top_k: number };
  sync: { backend: SyncBackendId; auto_snapshot: boolean; git: { remote: string } };
  install: { command: string };
  profile_work: { locked: boolean };
}

export function defaultConfig(): OmemConfig {
  return {
    general: { profile: 'home' },
    collect: {
      claude_projects: '~/.claude/projects',
      workbuddy_projects: '~/.workbuddy/projects',
      cursor_projects: '~/.cursor/projects',
      qwenwork_projects: '~/.qwenworkcn/projects',
      exclude_paths: [],
    },
    process: {
      default_tier: 'agent',
      stale_after_days: 180, // 规格 §11 开放问题 7：V0.1 保守值 180 天
      stale_weight: 0.5, // 规格 §4.2：L2 冷却降权 ×0.5
      max_content_chars: 2000,
    },
    api: {
      base: 'http://localhost:11434/v1', // ollama / llama-server 的 OpenAI 兼容端点
      key: '',
      model: '',
      timeout_ms: 0, // 0 = 按端点类型取默认（本机 300000 / 非本机 60000）
      max_input_chars: 0, // 0 = 按端点类型取默认（本机 6000 / 非本机 12000）
      limit: 20,
    },
    search: { top_k: 3 },
    sync: { backend: 'git', auto_snapshot: true, git: { remote: '' } },
    install: { command: 'omem' },
    profile_work: { locked: false },
  };
}

export function configPath(home: string): string {
  return join(home, 'config.toml');
}

export function loadConfig(home: string): OmemConfig {
  const p = configPath(home);
  if (!existsSync(p)) return defaultConfig();
  return fromParsed(parseTomlSubset(readFileSync(p, 'utf8')));
}

export function saveConfig(home: string, c: OmemConfig): void {
  atomicWrite(configPath(home), serializeConfig(c));
}

// 已从配置中移除的键。仍写在 config.toml 里会被静默忽略（unknown keys are ignored），
// 用户却会以为它生效——所以在 init 时点名提示，让他自己删掉那一行。
const REMOVED_KEYS: { section: string; key: string; note: string }[] = [
  {
    section: 'collect',
    key: 'exclude_keywords',
    note: 'removed; it no longer filters entries or session text. Only secret-pattern redaction (keys/tokens/JWT/PEM) applies.',
  },
];

/**
 * 被静默改写的键：值仍在生效，但效果不是字面那样，同样属于「看得见却不知道被骗了」。
 * 由 findRemovedConfigKeys 连同真正被移除的键一起点名提示。
 */
const REWRITTEN_KEYS: { section: string; key: string; expect: unknown; note: string }[] = [
  {
    section: 'process',
    key: 'default_tier',
    expect: 'rules',
    note: 'the rules tier was removed; this value is read as "agent" (transcripts only, conclusions come from the Agent via save_memory). Set it to "agent" to match reality.',
  },
];

/** 返回 config.toml 里残留的已移除/已被改写的键（人类可读描述），供 init / run 提示；解析失败时返回空。 */
export function findRemovedConfigKeys(home: string): string[] {
  const p = configPath(home);
  if (!existsSync(p)) return [];
  let parsed: Record<string, any>;
  try {
    parsed = parseTomlSubset(readFileSync(p, 'utf8'));
  } catch {
    return []; // 配置本身解析不了时由别的路径报错，这里不重复干扰
  }
  const removed = REMOVED_KEYS.filter((k) => parsed?.[k.section]?.[k.key] !== undefined);
  const rewritten = REWRITTEN_KEYS.filter((k) => parsed?.[k.section]?.[k.key] === k.expect);
  return [...removed, ...rewritten].map((k) => `[${k.section}] ${k.key} — ${k.note}`);
}

// ── 解析 ──

function stripComment(line: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * 引号感知的点号路径切分：`projects.'E:\a.b'` → ['projects', 'E:\\a.b']。
 * 引号内的点不作分隔，引号本身剥除；裸键保持原样。TOML 的空格容错由 trim 处理。
 */
export function splitTomlPath(path: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (const ch of path) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '.') {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf.trim());
  return parts.filter((p) => p.length > 0);
}

export function parseTomlSubset(text: string): Record<string, any> {
  const root: Record<string, any> = {};
  let current: Record<string, any> = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      current = root;
      for (const part of splitTomlPath(sec[1])) {
        current[part] ??= {};
        current = current[part];
      }
      continue;
    }
    // key 允许裸键或带引号键——`"gpt-5.2-codex" = "gpt-5.4"` 是合法 TOML（codex config.toml 会用到）
    const kv = line.match(/^(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*(.+)$/);
    if (!kv) throw new Error(`config: cannot parse line: ${line}`);
    current[kv[1] ?? kv[2] ?? kv[3]] = parseTomlValue(kv[4].trim());
  }
  return root;
}

function parseTomlValue(v: string): any {
  if (v.startsWith('"') && v.endsWith('"')) return JSON.parse(v);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const arr = v.match(/^\[(.*)\]$/);
  if (arr) {
    const inner = arr[1].trim();
    if (!inner) return [];
    // 按不在引号内的逗号切分
    const items: string[] = [];
    let buf = '';
    let inStr: string | null = null;
    for (const ch of inner) {
      if (inStr) {
        buf += ch;
        if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'") {
        inStr = ch;
        buf += ch;
      } else if (ch === ',') {
        items.push(buf);
        buf = '';
      } else {
        buf += ch;
      }
    }
    if (buf.trim()) items.push(buf);
    return items.map((s) => parseTomlValue(s.trim()));
  }
  return v; // 裸字符串兜底
}

// ── 解析结果 → 类型化配置（枚举校验，防配置笔误击穿运行时） ──

function fromParsed(p: Record<string, any>): OmemConfig {
  const d = defaultConfig();
  // 数字同样要防笔误：越界（含负数/NaN/字符串）一律回退默认，与枚举同等纪律
  const numIn = (v: any, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  const strArr = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const tier = p?.process?.default_tier;
  const backend = p?.sync?.backend;
  return {
    general: {
      profile: p?.general?.profile === 'work' ? 'work' : 'home',
    },
    collect: {
      claude_projects: typeof p?.collect?.claude_projects === 'string' ? p.collect.claude_projects : d.collect.claude_projects,
      workbuddy_projects: typeof p?.collect?.workbuddy_projects === 'string' ? p.collect.workbuddy_projects : d.collect.workbuddy_projects,
      cursor_projects: typeof p?.collect?.cursor_projects === 'string' ? p.collect.cursor_projects : d.collect.cursor_projects,
      qwenwork_projects: typeof p?.collect?.qwenwork_projects === 'string' ? p.collect.qwenwork_projects : d.collect.qwenwork_projects,
      exclude_paths: strArr(p?.collect?.exclude_paths),
    },
    process: {
      default_tier: tier === 'api' ? 'api' : 'agent',
      stale_after_days: numIn(p?.process?.stale_after_days, 1, 3650, d.process.stale_after_days),
      stale_weight: numIn(p?.process?.stale_weight, 0, 1, d.process.stale_weight),
      max_content_chars: numIn(p?.process?.max_content_chars, 100, 100_000, d.process.max_content_chars),
    },
    api: {
      base: typeof p?.api?.base === 'string' && p.api.base ? p.api.base : d.api.base,
      key: typeof p?.api?.key === 'string' ? p.api.key : '',
      model: typeof p?.api?.model === 'string' ? p.api.model : '',
      timeout_ms: numIn(p?.api?.timeout_ms, 0, 3_600_000, d.api.timeout_ms),
      max_input_chars: numIn(p?.api?.max_input_chars, 0, 1_000_000, d.api.max_input_chars),
      limit: numIn(p?.api?.limit, 1, 10_000, d.api.limit),
    },
    search: { top_k: numIn(p?.search?.top_k, 1, 50, d.search.top_k) },
    sync: {
      backend: backend === 'webdav' || backend === 'dir' ? backend : 'git',
      auto_snapshot: p?.sync?.auto_snapshot === undefined ? true : Boolean(p.sync.auto_snapshot),
      git: { remote: typeof p?.sync?.git?.remote === 'string' ? p.sync.git.remote : '' },
    },
    install: { command: typeof p?.install?.command === 'string' ? p.install.command : d.install.command },
    profile_work: { locked: Boolean(p?.profile_work?.locked) },
  };
}

// ── 序列化（固定字段序，往返稳定） ──

function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function tomlArr(a: string[]): string {
  return `[${a.map(tomlStr).join(', ')}]`;
}

export function serializeConfig(c: OmemConfig): string {
  return [
    '# omem config (managed by omem; hand edits welcome; unknown keys are ignored)',
    '',
    '[general]',
    `profile = ${tomlStr(c.general.profile)}`,
    '',
    '[collect]',
    `claude_projects = ${tomlStr(c.collect.claude_projects)}`,
    `workbuddy_projects = ${tomlStr(c.collect.workbuddy_projects)}`,
    `cursor_projects = ${tomlStr(c.collect.cursor_projects)}`,
    `qwenwork_projects = ${tomlStr(c.collect.qwenwork_projects)}`,
    `exclude_paths = ${tomlArr(c.collect.exclude_paths)}`,
    '',
    '[process]',
    `default_tier = ${tomlStr(c.process.default_tier)}`,
    `stale_after_days = ${c.process.stale_after_days}`,
    `stale_weight = ${c.process.stale_weight}`,
    `max_content_chars = ${c.process.max_content_chars}`,
    '',
    '# [api].key will be committed to the git data repo by omem backup (doc §4 D5); leave empty for loopback endpoints',
    '[api]',
    `base = ${tomlStr(c.api.base)}`,
    `key = ${tomlStr(c.api.key)}`,
    `model = ${tomlStr(c.api.model)}`,
    // 0 = 按端点类型取默认（本机 300000 / 非本机 60000；本机 6000 / 非本机 12000）；
    // 显式写进 config 会固定生效、压过按端点分档，所以只在 >0 时落行。
    ...(c.api.timeout_ms > 0 ? [`timeout_ms = ${c.api.timeout_ms}`] : ['# timeout_ms = 300000  (unset: per-endpoint default)']),
    ...(c.api.max_input_chars > 0 ? [`max_input_chars = ${c.api.max_input_chars}`] : ['# max_input_chars = 6000  (unset: per-endpoint default)']),
    `limit = ${c.api.limit}`,
    '',
    '[search]',
    `top_k = ${c.search.top_k}`,
    '',
    '[sync]',
    `backend = ${tomlStr(c.sync.backend)}`,
    `auto_snapshot = ${c.sync.auto_snapshot}`,
    '',
    '[sync.git]',
    `remote = ${tomlStr(c.sync.git.remote)}`,
    '',
    '[install]',
    `command = ${tomlStr(c.install.command)}`,
    '',
    '[profile.work]',
    `locked = ${c.profile_work.locked}`,
    '',
  ].join('\n');
}
