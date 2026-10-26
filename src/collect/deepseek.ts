// DeepSeek Harness（dsh-desktop）会话只读采集器。
// 目录形态：<root>/<project-dir>/<session-id>/session.jsonl.zstd（v0）或 session.v4.jsonl.zstd（v4）。
// 行格式是 typed JSONL：首行 {"type":"session", ...}，后续行 {"type":"user/message"|"assistant/message"|..., "data":{...}}。
// 只保留 user/message 与 assistant/message 的 text 块；跳过 reasoning / tool-call / image 等其余类型。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Decoder } from '@toondepauw/node-zstd';
import { expandHome } from '../core/paths.js';
import type { SessionFile } from './claude-code.js';
import { stripHarness } from './dialogue.js';
import type { SessionDigest, UnifiedMessage } from './types.js';

// @toondepauw/node-zstd：预编译原生模块，跨平台（win32/darwin/linux × x64/arm64），无源码编译依赖。
const ZSTD_DECODER = new Decoder();

/** 默认扫描根：Windows / macOS / Linux 统一在 ~/.dsh/sessions/。 */
export function defaultDeepSeekRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMEM_DEEPSEEK_PROJECTS ?? expandHome('~/.dsh/sessions');
}

/**
 * 列出 DeepSeek 会话：<root>/<project-dir>/<session-id>/session{.v4}.jsonl.zstd。
 * 同一 session_id 只取一个文件（优先 v4，其次 v0）。
 */
export function listDeepSeekSessions(root: string, opts: { since?: Date } = {}): SessionFile[] {
  if (!existsSync(root)) return [];
  const bySession = new Map<string, SessionFile>();
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return [];
  }
  for (const proj of projectDirs) {
    const projDir = join(root, proj);
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      const sessionDir = join(projDir, sid);
      // 优先 session.v4.jsonl.zstd，其次 session.jsonl.zstd
      const v4Path = join(sessionDir, 'session.v4.jsonl.zstd');
      const v0Path = join(sessionDir, 'session.jsonl.zstd');
      let path: string | undefined;
      let st;
      try {
        if (existsSync(v4Path)) {
          path = v4Path;
          st = statSync(v4Path);
        } else {
          path = v0Path;
          st = statSync(v0Path);
        }
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (opts.since && st.mtimeMs < opts.since.getTime()) continue;
      const existing = bySession.get(sid);
      if (!existing || st.mtimeMs > existing.mtimeMs) {
        bySession.set(sid, { path, sessionId: sid, mtimeMs: st.mtimeMs });
      }
    }
  }
  return [...bySession.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** 路径 .../<project>/<sid>/session*.zstd → cwd（从 session 首行读取，回退 unknown）。 */
export function parseDeepSeekFile(path: string): SessionDigest | null {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = ZSTD_DECODER.decodeSync(raw).toString('utf8');
  } catch {
    return null; // 解压失败
  }
  const lines = text.split(/\r?\n/);
  let sessionId = '';
  let cwd: string | undefined;
  let createdAt = 0;
  // 首行：session 元数据
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'session') {
        sessionId = obj.id;
        cwd = obj.cwd;
        createdAt = obj.createdAt ?? 0;
      }
    } catch {
      // 跳过
    }
    break;
  }
  if (!sessionId) return null;

  const startedTs = createdAt ? new Date(createdAt).toISOString() : new Date(0).toISOString();
  const messages: UnifiedMessage[] = [];
  let lastTs = startedTs;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const type = obj.type;
    if (type === 'session') continue;

    if (type === 'user/message') {
      const d = obj.data;
      if (!d) continue;
      const content = extractUserContent(d);
      if (!content) continue;
      messages.push(makeMessage(sessionId, cwd, 'user', content, messages.length, startedTs));
    } else if (type === 'assistant/message') {
      const msg = obj.data?.message;
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type !== 'text') continue; // 跳过 reasoning / tool-call / image
        const raw = typeof block.text === 'string' ? block.text.trim() : '';
        const content = stripHarness(raw).trim();
        if (!content) continue;
        messages.push(makeMessage(sessionId, cwd, 'assistant', content, messages.length, startedTs));
      }
    }
    // 其余 type（tool/call, tool/result, step/start, ...）全部跳过
  }

  if (messages.length === 0) return null;
  return {
    session_id: sessionId,
    agent: 'deepseek',
    project_fp: cwd ?? 'unknown',
    cwd,
    started_ts: messages[0].ts,
    ended_ts: messages[messages.length - 1].ts,
    messages,
  };
}

/** 提取 user/message 的正文：data.content 可能是 string 或 content block 数组。 */
function extractUserContent(data: any): string | null {
  if (typeof data.content === 'string') {
    return stripHarness(data.content).trim() || null;
  }
  if (Array.isArray(data.content)) {
    const parts: string[] = [];
    for (const block of data.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
      // 跳过 image 等其余 block
    }
    const joined = stripHarness(parts.join('\n')).trim();
    return joined || null;
  }
  return null;
}

function makeMessage(
  sessionId: string,
  cwd: string | undefined,
  role: 'user' | 'assistant',
  content: string,
  seq: number,
  fallbackTs: string,
): UnifiedMessage {
  return {
    session_id: sessionId,
    agent: 'deepseek',
    ts: fallbackTs, // deepseek 消息无独立时间戳：占位，稳定
    project_fp: cwd ?? 'unknown',
    role,
    content,
    msg_uuid: `${sessionId}#${seq}`,
    cwd,
  };
}
