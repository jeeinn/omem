// CodeBuddy（腾讯云代码助手 / CodeBuddy IDE）会话只读解析。
//
// 落盘形态：<root>/projects/<encoded-cwd>/<session-id>.jsonl
// 行格式与 WorkBuddy 同构：type=message，role 在顶层，正文是
// input_text / output_text 内容块；function_call / function_call_result 是
// 独立的行类型，不进对话。
//
// 与 WorkBuddy 的两处差异（2026-10-26 实测本机数据）：
//  1. timestamp 是毫秒数字（不是 ISO 字符串）；
//  2. 会话行里没有 cwd 字段——项目路径只能从目录名反解。
//
// 目录名编码：路径里的盘符冒号与路径分隔符都换成 '-'（e:\projects\boss-sql
// → e-projects-boss-sql）。这个编码有损：'boss-sql' 里的 '-' 与路径分隔符
// 无法区分。所以这里不猜——枚举所有可能的还原方式，取文件系统里真实
// 存在的那一个；都不存在就留 unknown，不编造 cwd。
//
// 国际版与中文版是两个根（~/.codebuddy 与 ~/.codebuddycn），格式相同，
// 按 session_id 去重（保留 mtime 最新的那份）。
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { expandHome } from '../core/paths.js';
import { resolveProjectFp } from './claude-code.js';
import { stripHarness } from './dialogue.js';
import type { SessionDigest, UnifiedMessage } from './types.js';
import type { SessionFile } from './claude-code.js';

const TEXT_PARTS = new Set(['input_text', 'output_text', 'text']);

/** 国际版默认根。 */
export function defaultCodeBuddyRoot(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.OMEM_CODEBUDDY_PROJECTS || '~/.codebuddy');
}

/** 中文版默认根。 */
export function defaultCodeBuddyCnRoot(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.OMEM_CODEBUDDY_CN_PROJECTS || '~/.codebuddycn');
}

/**
 * 从目录名反解项目路径。
 *
 * 编码规则（实测）：路径里的 ':' 与 '\' 一律换成 '-'。于是
 * 'e:\projects\boss-sql' → 'e-projects-boss-sql'——但 'boss-sql' 里的
 * 连字符也被编码成了 '-'，两者无法从字符串上区分。
 *
 * 所以不枚举组合，而是从盘符根做文件系统 BFS：逐段尝试「当前目录下的
 * 某个子目录，其名字是剩余编码串的前缀」，把能走通的路径收集起来。
 * 真实存在的路径通常只有一个。
 *
 * 都不存在就返回 undefined（不编造 cwd）——目录名对不上文件系统时，
 * 编一个出来比留空更糟。
 *
 * 广度上限：最多访问 200 个目录、最多 8 层，避免病态目录树拖慢扫描。
 */
export function decodeProjectDir(dirName: string): string | undefined {
  const m = dirName.match(/^([a-zA-Z])-(.*)$/);
  if (!m) return undefined;
  const drive = m[1];
  const rest = m[2];
  if (!rest) return undefined;

  const root = `${drive}:${String.fromCharCode(92)}`;
  let visited = 0;
  const found: string[] = [];

  // BFS：state = [当前目录, 剩余编码串]
  let frontier: [string, string][] = [[root, rest]];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const next: [string, string][] = [];
    for (const [dir, remaining] of frontier) {
      if (visited++ > 200) break;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue; // 目录不可读（权限 / 不存在）
      }
      for (const name of entries) {
        if (!name) continue;
        // 编码串的下一段必须以这个目录名开头。
        if (!remaining.startsWith(name)) continue;
        const after = remaining.slice(name.length);
        const child = join(dir, name);
        if (after === '') {
          // 整个编码串匹配完毕，这个子目录就是候选路径。
          found.push(child);
          continue;
        }
        if (!after.startsWith('-')) continue; // 编码串必须以 '-' 分隔
        // 两种解释：'-' 是路径分隔符（进入下一层），或 '-' 属于目录名本身
        // （目录名更长，如 'boss-sql' 对应编码 'boss-sql'）。
        // 前者：剩余串去掉 '-' 继续在 child 里找下一段。
        next.push([child, after.slice(1)]);
        // 后者：目录名其实更长——在同层找一个更长的名字，其前缀是 name + '-'。
        // 由下一轮对 child 的扫描覆盖不到（那时 remaining 已变短），
        // 所以这里显式补一条：把 name + '-' 当作已消费的名字。
        const longer = join(dir, name + '-');
        const longerAfter = after.slice(1);
        try {
          if (existsSync(longer)) {
            if (longerAfter === '') found.push(longer);
            else next.push([longer, longerAfter]);
          }
        } catch {
          // 忽略不可访问的候选。
        }
      }
    }
    frontier = next;
    if (found.length > 0) break; // 找到就不再往下钻
  }
  if (found.length === 0) return undefined;
  // 多个候选时取最短的那个（更可能是原路径——编码时多拆一层是巧合）。
  found.sort((a, b) => a.length - b.length);
  return found[0];
}

/** 列出单个根下的会话文件。 */
export function listCodeBuddySessions(root: string, opts: { since?: Date } = {}): SessionFile[] {
  const projectsDir = join(root, 'projects');
  if (!existsSync(projectsDir)) return [];
  const out: SessionFile[] = [];
  let projects: string[];
  try {
    projects = readdirSync(projectsDir);
  } catch {
    return [];
  }
  for (const proj of projects) {
    const dir = join(projectsDir, proj);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (opts.since && st.mtimeMs < opts.since.getTime()) continue;
        out.push({ path, sessionId: basename(name, '.jsonl'), mtimeMs: st.mtimeMs });
      } catch {
        // 文件在扫描期间被删：跳过，不让整个采集失败。
      }
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** 合并国际版与中文版两个根；同一 session_id 保留 mtime 最新的那份。 */
export function listCodeBuddySessionsBothRoots(rootIntl: string, rootCn: string): SessionFile[] {
  const byId = new Map<string, SessionFile>();
  for (const f of [...listCodeBuddySessions(rootIntl), ...listCodeBuddySessions(rootCn)]) {
    const ex = byId.get(f.sessionId);
    if (!ex || f.mtimeMs > ex.mtimeMs) byId.set(f.sessionId, f);
  }
  return [...byId.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && TEXT_PARTS.has(b.type) && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim();
}

/** CodeBuddy 的 timestamp 是毫秒数字；也兼容 ISO 字符串。 */
function toIso(ts: unknown): string {
  if (typeof ts === 'string' && ts) return ts;
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  return new Date().toISOString();
}

/**
 * 从会话文件路径反推项目目录名 → cwd。
 * 目录形态：<root>/projects/<encoded>/<session>.jsonl
 */
export function cwdFromSessionPath(path: string): string | undefined {
  const parts = path.split(/[\\/]/);
  const idx = parts.lastIndexOf('projects');
  if (idx < 0 || idx + 1 >= parts.length) return undefined;
  return decodeProjectDir(parts[idx + 1]);
}

/**
 * 解析单个 CodeBuddy JSONL。
 * function_call / function_call_result 行不进对话（它们是工具调用与结果）。
 */
export function parseCodeBuddyFile(path: string): SessionDigest | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const sessionId = basename(path, '.jsonl');
  const messages: UnifiedMessage[] = [];
  let projectFp = 'unknown';
  let cwd: string | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // 容忍截断/损坏行
    }
    if (j.type !== 'message') continue;
    if (j.isSidechain === true) continue;
    const role = j.role === 'user' ? 'user' : j.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const content = stripHarness(extractText(j.content));
    if (!content) continue;
    if (!cwd && j.cwd) cwd = String(j.cwd);
    if (!cwd && j.project) cwd = String(j.project);
    // 会话行里没有 cwd 时，从目录名反解——编码有损，只能靠文件系统确认。
    if (!cwd) cwd = cwdFromSessionPath(path);
    if (cwd && projectFp === 'unknown') projectFp = resolveProjectFp(cwd);
    messages.push({
      session_id: j.sessionId ?? sessionId,
      agent: 'codebuddy',
      ts: toIso(j.timestamp),
      project_fp: projectFp,
      role,
      content,
      msg_uuid: typeof j.id === 'string' && j.id ? j.id : `${sessionId}#${i}`,
      cwd,
    });
  }
  if (messages.length === 0) return null;
  return {
    session_id: sessionId,
    agent: 'codebuddy',
    project_fp: projectFp,
    cwd,
    started_ts: messages[0].ts,
    ended_ts: messages[messages.length - 1].ts,
    messages,
  };
}
