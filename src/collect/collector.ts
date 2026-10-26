// 采集器注册表。scanSessions 依次扫描已注册的采集器。
// 每个采集器只读自己的会话目录；某个目录不存在时记下提示，不挡住其余采集器。
import { existsSync } from 'node:fs';
import type { OmemIndex } from '../core/index.js';
import type { OmemConfig } from '../core/config.js';
import { expandHome } from '../core/paths.js';
import { listSessionFiles, parseSessionFile, defaultProjectsRoot } from './claude-code.js';
import { listCursorTranscripts, parseCursorTranscript } from './cursor.js';
import { parseWorkbuddyFile } from './workbuddy.js';
import { parseQwenworkFile } from './qwenwork.js';
import { prepareDialogue, sessionKey } from './session-store.js';
import type { SessionDigest } from './types.js';

export const COLLECTOR_IDS = ['claude-code', 'workbuddy', 'cursor', 'qwenwork'] as const;
export type CollectorId = (typeof COLLECTOR_IDS)[number];

export interface Collector {
  id: string;
  root(): string;
  list(): { path: string; sessionId: string; mtimeMs: number }[];
  parse(path: string): SessionDigest | null;
}

/** 配置以 ~ 开头时允许环境变量覆盖；绝对路径以配置为准（测试隔离）。 */
function rootFrom(configured: string, envKey: string, env: NodeJS.ProcessEnv = process.env): string {
  if (configured.startsWith('~')) return expandHome(env[envKey] || configured);
  return configured;
}

export function getCollector(id: string, config: OmemConfig, env: NodeJS.ProcessEnv = process.env): Collector {
  if (id === 'claude-code') {
    const root = config.collect.claude_projects.startsWith('~')
      ? defaultProjectsRoot(env)
      : config.collect.claude_projects;
    return { id, root: () => root, list: () => listSessionFiles(root), parse: (path) => parseSessionFile(path) };
  }
  if (id === 'workbuddy') {
    const root = rootFrom(config.collect.workbuddy_projects, 'OMEM_WORKBUDDY_PROJECTS', env);
    return { id, root: () => root, list: () => listSessionFiles(root), parse: (path) => parseWorkbuddyFile(path) };
  }
  if (id === 'cursor') {
    const root = rootFrom(config.collect.cursor_projects, 'OMEM_CURSOR_PROJECTS', env);
    return { id, root: () => root, list: () => listCursorTranscripts(root), parse: (path) => parseCursorTranscript(path) };
  }
  if (id === 'qwenwork') {
    const root = rootFrom(config.collect.qwenwork_projects, 'OMEM_QWENWORK_PROJECTS', env);
    return { id, root: () => root, list: () => listSessionFiles(root), parse: (path) => parseQwenworkFile(path) };
  }
  throw new Error(`Unknown collector: ${id} (supported: ${COLLECTOR_IDS.join(' / ')})`);
}

export interface ScanRoot {
  id: string;
  root: string;
  exists: boolean;
}

export interface ScanResult {
  digests: SessionDigest[];
  skipped: number;
  roots: ScanRoot[];
}

export function scanSessions(
  index: OmemIndex,
  config: OmemConfig,
  opts: { since?: Date; sessionId?: string; onProgress?: (done: number, total: number) => void } = {},
): ScanResult {
  const digests: SessionDigest[] = [];
  const roots: ScanRoot[] = [];
  let skipped = 0;
  const work: { collector: Collector; path: string }[] = [];
  for (const id of COLLECTOR_IDS) {
    const collector = getCollector(id, config);
    const root = collector.root();
    const rootExists = existsSync(root);
    roots.push({ id, root, exists: rootExists });
    if (!rootExists) continue;
    const files = collector.list().filter((f) => (opts.sessionId ? f.sessionId === opts.sessionId : true));
    for (const f of files) work.push({ collector, path: f.path });
  }
  const total = work.length;
  opts.onProgress?.(0, total);
  for (let i = 0; i < work.length; i++) {
    opts.onProgress?.(i + 1, total);
    const { collector, path } = work[i];
    const digest = collector.parse(path);
    if (!digest) continue;
    if (opts.since && new Date(digest.ended_ts) < opts.since) continue;
    const rec = index.getSession(sessionKey(digest.agent, digest.session_id));
    const { hash } = prepareDialogue(digest);
    if (!opts.sessionId && rec?.content_hash && rec.content_hash === hash) {
      skipped++;
      continue;
    }
    digests.push(digest);
  }
  return { digests, skipped, roots };
}
