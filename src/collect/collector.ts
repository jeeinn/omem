// 采集器注册表。scanSessions 依次扫描已注册的采集器。
// 每个采集器只读自己的会话目录；某个目录不存在时记下提示，不挡住其余采集器。
import { existsSync } from 'node:fs';
import type { OmemIndex } from '../core/index.js';
import type { OmemConfig } from '../core/config.js';
import { expandHome } from '../core/paths.js';
import { listSessionFiles, parseSessionFile, defaultProjectsRoot } from './claude-code.js';
import type { SessionFile } from './claude-code.js';
import { listCursorTranscripts, parseCursorTranscript } from './cursor.js';
import { parseWorkbuddyFile } from './workbuddy.js';
import { parseQwenworkFile } from './qwenwork.js';
import { listDoubaoSessions, parseDoubaoFile, defaultDoubaoRoot } from './doubao.js';
import { listDeepSeekSessions, parseDeepSeekFile, defaultDeepSeekRoot } from './deepseek.js';
import { listQoderSessions, parseQoderFile, defaultQoderRoot, defaultQoderCnRoot } from './qoder.js';
import { listCatpawTranscripts, parseCatpawFile, defaultCatpawRoot } from './catpaw.js';
import { prepareDialogue, sessionKey } from './session-store.js';
import type { SessionDigest } from './types.js';
import { COLLECTOR_IDS, COLLECTOR_SPECS, type CollectorId } from './registry.js';

export { COLLECTOR_IDS, type CollectorId };
export { COLLECTOR_SPECS, allCollectorEnvKeys } from './registry.js';

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
    const root = rootFrom(config.collect.workbuddy_projects, COLLECTOR_SPECS.workbuddy.envKeys[0], env);
    return { id, root: () => root, list: () => listSessionFiles(root), parse: (path) => parseWorkbuddyFile(path) };
  }
  if (id === 'cursor') {
    const root = rootFrom(config.collect.cursor_projects, COLLECTOR_SPECS.cursor.envKeys[0], env);
    return { id, root: () => root, list: () => listCursorTranscripts(root), parse: (path) => parseCursorTranscript(path) };
  }
  if (id === 'qwenwork') {
    const root = rootFrom(config.collect.qwenwork_projects, COLLECTOR_SPECS.qwenwork.envKeys[0], env);
    return { id, root: () => root, list: () => listSessionFiles(root), parse: (path) => parseQwenworkFile(path) };
  }
  if (id === 'doubao') {
    // 豆包默认根在 %LOCALAPPDATA%（不在 home）：配置以 ~ 开头时走平台探测的默认路径，
    // env OMEM_DOUBAO_PROJECTS 优先；绝对路径（测试隔离）直接采用。
    const root = config.collect.doubao_projects.startsWith('~')
      ? defaultDoubaoRoot(env)
      : config.collect.doubao_projects;
    return { id, root: () => root, list: () => listDoubaoSessions(root), parse: (path) => parseDoubaoFile(path) };
  }
  if (id === 'deepseek') {
    const root = config.collect.deepseek_projects.startsWith('~')
      ? defaultDeepSeekRoot(env)
      : config.collect.deepseek_projects;
    return { id, root: () => root, list: () => listDeepSeekSessions(root), parse: (path) => parseDeepSeekFile(path) };
  }
  if (id === 'qoder') {
    const rootIntl = config.collect.qoder_projects.startsWith('~')
      ? defaultQoderRoot(env)
      : config.collect.qoder_projects;
    const rootCn = config.collect.qoder_cn_projects.startsWith('~')
      ? defaultQoderCnRoot(env)
      : config.collect.qoder_cn_projects;
    // Qoder 双根：国际版 + 中文版。root() 返回主根（国际版）用于展示。
    // list() 合并两边，parse() 按文件所属根选择（此处逻辑相同，统一用 parseQoderFile）。
    return {
      id,
      root: () => rootIntl,
      list: () => {
        const a = listQoderSessions(rootIntl);
        const b = listQoderSessions(rootCn);
        // 去重：同一 session_id 保留 mtime 最新那份
        const byId = new Map<string, SessionFile>();
        for (const f of [...a, ...b]) {
          const ex = byId.get(f.sessionId);
          if (!ex || f.mtimeMs > ex.mtimeMs) byId.set(f.sessionId, f);
        }
        return [...byId.values()].sort((x, y) => x.mtimeMs - y.mtimeMs);
      },
      parse: (path) => parseQoderFile(path),
    };
  }
  if (id === 'catpaw') {
    const root = rootFrom(config.collect.catpaw_projects, COLLECTOR_SPECS.catpaw.envKeys[0], env);
    return { id, root: () => root, list: () => listCatpawTranscripts(root), parse: (path) => parseCatpawFile(path) };
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
  opts: { since?: Date; sessionId?: string; collectors?: readonly string[]; onProgress?: (done: number, total: number) => void } = {},
): ScanResult {
  const digests: SessionDigest[] = [];
  const roots: ScanRoot[] = [];
  let skipped = 0;
  const work: { collector: Collector; path: string }[] = [];
  const ids = opts.collectors && opts.collectors.length > 0 ? opts.collectors : COLLECTOR_IDS;
  for (const id of ids) {
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
