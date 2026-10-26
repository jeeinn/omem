// CatPaw 会话只读采集器。
// 路径：~/.catpaw/projects/<project-slug>/<session-uuid>/agent-transcripts/transcript.txt
// 行格式是纯文本：user: + <user_query>...</user_query> 块，后接 assistant: 回复；
// 中间穿插 [Thinking] / [Tool call] / [Tool result] 脚手架块。
// 只保留 <user_query> 内的 user 正文和 assistant: 后的回复；跳过全部脚手架。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expandHome } from '../core/paths.js';
import { sha256hex } from '../core/util.js';
import { stripHarness } from './dialogue.js';
import type { SessionFile } from './claude-code.js';
import type { SessionDigest, UnifiedMessage } from './types.js';

/** 默认扫描根：~/.catpaw/projects/。 */
export function defaultCatpawRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMEM_CATPAW_PROJECTS ?? expandHome('~/.catpaw/projects');
}

/** 列出 CatPaw 会话：<root>/<project>/<session>/agent-transcripts/transcript.txt。 */
export function listCatpawTranscripts(root: string, opts: { since?: Date } = {}): SessionFile[] {
  if (!existsSync(root)) return [];
  const out: SessionFile[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  for (const proj of projects) {
    const projDir = join(root, proj);
    let sessions: string[];
    try {
      sessions = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const sid of sessions) {
      const transPath = join(projDir, sid, 'agent-transcripts', 'transcript.txt');
      let st;
      try {
        st = statSync(transPath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (opts.since && st.mtimeMs < opts.since.getTime()) continue;
      out.push({ path: transPath, sessionId: `${proj}/${sid}`, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** 解析单个 CatPaw transcript.txt → SessionDigest（null = 无有效消息）。 */
export function parseCatpawFile(path: string): SessionDigest | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  // transcript.txt 路径: <root>/<project-slug>/<session-uuid>/agent-transcripts/transcript.txt
  // dirname 一级 → agent-transcripts；两级 → <session-uuid>；三级 → <project-slug>
  const sessionDir = basename(dirname(dirname(path))); // <session-uuid>
  const projDir = basename(dirname(dirname(dirname(path)))); // <project-slug>
  const fp = `local:${sha256hex(projDir).slice(0, 8)}`;
  const sessionId = `${projDir}/${sessionDir}`;

  const messages: UnifiedMessage[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // 检测 user: 块
    if (/^user:\s*$/.test(line)) {
      i++;
      let content: string | null = null;
      while (i < lines.length) {
        const l = lines[i];
        if (/^<user_query>\s*$/.test(l)) {
          // 收集直到 </user_query>
          const parts: string[] = [];
          i++;
          while (i < lines.length && !/^<\/user_query>\s*$/.test(lines[i])) {
            parts.push(lines[i]);
            i++;
          }
          if (i < lines.length) i++; // 跳过闭合标签
          content = stripHarness(parts.join('\n')).trim();
          break;
        }
        if (/^<\/user_query>\s*$/.test(l)) {
          i++;
          continue;
        }
        if (/^assistant:\s*$/.test(l)) break;
        i++;
      }
      if (content) {
        messages.push(makeMessage(sessionId, 'user', content, messages.length, fp));
      }
      continue;
    }

    // 检测 assistant: 块
    if (/^assistant:\s*$/.test(line)) {
      i++;
      const parts: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (/^user:\s*$/.test(l)) break;
        // 跳过 [Thinking] / [Tool call] / [Tool result] 整块
        if (/^\[(Thinking|Tool call|Tool result)\]\s*$/.test(l)) {
          i++;
          // 跳过块内容直到下一个标记或段首
          while (
            i < lines.length &&
            !/^\[.*\]\s*$/.test(lines[i]) &&
            !/^user:\s*$/.test(lines[i]) &&
            !/^assistant:\s*$/.test(lines[i])
          ) {
            i++;
          }
          continue;
        }
        parts.push(l);
        i++;
      }
      const content = stripHarness(parts.join('\n')).trim();
      if (content) {
        messages.push(makeMessage(sessionId, 'assistant', content, messages.length, fp));
      }
      continue;
    }

    i++;
  }

  if (messages.length === 0) return null;
  return {
    session_id: sessionId,
    agent: 'catpaw',
    project_fp: fp,
    started_ts: messages[0].ts,
    ended_ts: messages[messages.length - 1].ts,
    messages,
  };
}

function makeMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  seq: number,
  fp: string,
): UnifiedMessage {
  return {
    session_id: sessionId,
    agent: 'catpaw',
    ts: new Date(0).toISOString(), // catpaw 消息无独立时间戳：占位，稳定
    project_fp: fp,
    role,
    content,
    msg_uuid: `${sessionId}#${seq}`,
  };
}
