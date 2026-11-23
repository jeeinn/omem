// DeepSeek Harness（dsh-desktop）会话只读采集器。
// 目录形态：<root>/<project-dir>/<session-id>/session.jsonl.zstd（v0）或 session.v4.jsonl.zstd（v4）。
// 行格式是 typed JSONL：首行 {"type":"session", ...}，后续行 {"type":"user/message"|"assistant/message"|..., "data":{...}}。
// 只保留 user/message 与 assistant/message 的 text 块；跳过 reasoning / tool-call / image 等其余类型。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { expandHome } from '../core/paths.js';
import type { SessionFile } from './claude-code.js';
import { stripHarness } from './dialogue.js';
import type { SessionDigest, UnifiedMessage } from './types.js';

// zstd 解压器必须“可选且可捕获”。
//
// 为什么不能在模块顶层 `new Decoder()`：@toondepauw/node-zstd 的 index.js 在 import
// 阶段就会抛（原生绑定缺失时），而 deepseek 只是九个采集器之一。顶层构造会把
// 「一个可选采集器的可选原生依赖」放大成「整个 CLI 起不来」——`omem --version`
// 也救不回来，因为崩溃发生在 import 链上。
//
// 顺序：Node 内置 zlib.zstdDecompressSync（22.15+ 起自带，零原生依赖）优先；
// 老 Node 回退到预编译原生包。两者都不可用时返回 null，由采集器自检上报。
type Decompress = (raw: Buffer) => Buffer;

interface DecompressorPick {
  decompress?: Decompress;
  error?: string;
}

/**
 * 纯函数选择器：把「用哪个解压器」与「怎么加载」分开，单测能钉住三种状态。
 * `native` 是惰性加载器——只有内置不可用时才调用它，避免无谓地碰原生绑定。
 */
export function pickDecompressor(
  builtin: ((raw: Buffer) => Buffer) | undefined,
  native: () => Decompress | undefined,
): DecompressorPick {
  if (typeof builtin === 'function') return { decompress: builtin };
  try {
    const decompress = native();
    if (decompress) return { decompress };
    return { error: 'no zstd decompressor available' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

let cached: DecompressorPick | undefined;

function loadDecompressor(): DecompressorPick {
  if (cached) return cached;
  // 访问缺失的导出要能兜住：CJS 命名空间通常返回 undefined，
  // 但某些宿主/桩在属性访问时就抛。两种都不该让启动失败。
  let builtin: Decompress | undefined;
  try {
    const fn = (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync;
    if (typeof fn === 'function') builtin = fn as Decompress;
  } catch {
    builtin = undefined;
  }
  cached = pickDecompressor(builtin, () => {
    // createRequire 在模块顶层调用是安全的：它只构造一个解析器，不加载任何模块。
    const require = createRequire(import.meta.url);
    const mod = require('@toondepauw/node-zstd') as {
      Decoder?: new () => { decodeSync(raw: Buffer): Buffer };
    };
    if (!mod?.Decoder) throw new Error('@toondepauw/node-zstd has no Decoder export');
    const decoder = new mod.Decoder();
    return (raw) => decoder.decodeSync(raw);
  });
  return cached;
}

/**
 * 采集器自检：undefined 表示可用，否则返回不可用原因。
 * CLI `omem doctor` 与 `omem sync` 的 notes 都靠它，而不是靠一次失败的解析猜。
 */
export function deepseekZstdError(): string | undefined {
  return loadDecompressor().error;
}

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
  const { decompress } = loadDecompressor();
  if (!decompress) return null; // 解压器不可用：由 preflight 上报，这里只跳过该文件
  let text: string;
  try {
    text = decompress(raw).toString('utf8');
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
