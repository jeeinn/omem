// Claude Code 会话采集器（评估 4.2：V0.1 唯一采集通道）。
// 只读解析 ~/.claude/projects/<encoded-cwd>/<session>.jsonl；SQLite 类源一律读副本（lore 教训——此处本就是 JSONL 只读）。
// 过滤：sidechain（子 agent）条目、summary 条目、纯 tool_use/tool_result 的 assistant 轮次。
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expandHome } from '../core/paths.js';
import { sha256hex } from '../core/util.js';
import type { SessionDigest, UnifiedMessage } from './types.js';

export function defaultProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.OMEM_CLAUDE_PROJECTS || '~/.claude/projects');
}

export interface SessionFile {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

export function listSessionFiles(root: string, opts: { since?: Date } = {}): SessionFile[] {
  if (!existsSync(root)) return [];
  const out: SessionFile[] = [];
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (opts.since && st.mtimeMs < opts.since.getTime()) continue;
      out.push({ path, sessionId: basename(name, '.jsonl'), mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** git remote origin URL 归一化 → sha256 前 12 位；无 git 回退 local:hash(cwd)（规格 5.3.2，V0.1 只用 remote hash）。 */
const fpCache = new Map<string, string>();
export function resolveProjectFp(cwd?: string): string {
  const key = cwd ?? '__no_cwd__';
  const cached = fpCache.get(key);
  if (cached) return cached;
  let fp: string;
  if (!cwd) {
    fp = 'unknown';
  } else {
    let remote: string | null = null;
    try {
      remote = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).trim() || null;
    } catch {
      remote = null;
    }
    if (remote) {
      const norm = remote
        .toLowerCase()
        .replace(/^[a-z+]+:\/\//, '')
        .replace(/^[^@/]+@/, '')
        .replace(/\.git$/, '')
        .replace(/\/+$/, '');
      fp = sha256hex(norm).slice(0, 12);
    } else {
      fp = 'local:' + sha256hex(cwd.toLowerCase()).slice(0, 8);
    }
  }
  fpCache.set(key, fp);
  return fp;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text as string)
      .join('\n');
  }
  return '';
}

/** 解析单个 JSONL 会话文件 → SessionDigest（null = 无有效消息）。 */
export function parseSessionFile(path: string): SessionDigest | null {
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
    if (j.type === 'summary') continue;
    if (j.isSidechain === true) continue; // 子 agent sidechain 不采集
    const role = j.type === 'user' ? 'user' : j.type === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const content = extractText(j.message?.content).trim();
    if (!content) continue;
    if (j.cwd) cwd = j.cwd;
    if (cwd && projectFp === 'unknown') projectFp = resolveProjectFp(cwd);
    messages.push({
      session_id: j.sessionId ?? sessionId,
      agent: 'claude-code',
      ts: typeof j.timestamp === 'string' ? j.timestamp : new Date().toISOString(),
      project_fp: projectFp,
      role,
      content,
      msg_uuid: typeof j.uuid === 'string' && j.uuid ? j.uuid : `${sessionId}#${i}`,
      cwd: j.cwd,
      git_branch: j.gitBranch,
    });
  }
  if (messages.length === 0) return null;
  return {
    session_id: sessionId,
    agent: 'claude-code',
    project_fp: projectFp,
    cwd,
    started_ts: messages[0].ts,
    ended_ts: messages[messages.length - 1].ts,
    messages,
  };
}
