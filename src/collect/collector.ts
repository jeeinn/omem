// 采集器注册表（V0.1 仅 claude-code；V0.2 起按适配器接口扩张——规格 §1.2 非目标）。
// scanSessions：列文件 → 跳过未变化的会话（sessions 表 msg_count 对账）→ 解析。
import { existsSync } from 'node:fs';
import type { OmemIndex } from '../core/index.js';
import type { OmemConfig } from '../core/config.js';
import { listSessionFiles, parseSessionFile, defaultProjectsRoot } from './claude-code.js';
import type { SessionDigest } from './types.js';

export interface Collector {
  id: string;
  root(): string;
  list(): { path: string; sessionId: string; mtimeMs: number }[];
  parse(path: string): SessionDigest | null;
}

export function getCollector(id: string, config: OmemConfig): Collector {
  if (id !== 'claude-code') {
    throw new Error(`未知采集器: ${id}（V0.1 仅支持 claude-code）`);
  }
  const root = config.collect.claude_projects.startsWith('~')
    ? defaultProjectsRoot()
    : config.collect.claude_projects;
  return {
    id,
    root: () => root,
    list: () => listSessionFiles(root),
    parse: (path) => parseSessionFile(path),
  };
}

export interface ScanResult {
  digests: SessionDigest[];
  skipped: number; // 未变化的会话数
  root: string;
  rootExists: boolean;
}

export function scanSessions(
  index: OmemIndex,
  config: OmemConfig,
  opts: { since?: Date; sessionId?: string } = {},
): ScanResult {
  const collector = getCollector('claude-code', config);
  const root = collector.root();
  const rootExists = existsSync(root);
  const files = collector
    .list()
    .filter((f) => (opts.sessionId ? f.sessionId === opts.sessionId : true));
  const digests: SessionDigest[] = [];
  let skipped = 0;
  for (const f of files) {
    const digest = collector.parse(f.path);
    if (!digest) continue;
    if (opts.since && new Date(digest.ended_ts) < opts.since) continue;
    const rec = index.getSession(digest.session_id);
    if (!opts.sessionId && rec && rec.msg_count === digest.messages.length) {
      skipped++;
      continue;
    }
    digests.push(digest);
  }
  return { digests, skipped, root, rootExists };
}
