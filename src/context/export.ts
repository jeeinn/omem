// omem context --for <agent>（评估 4.2/4.5：非 MCP 原生 Agent 的接入路径）。
// 生成 MEMORY-INDEX.md 的客户端形态：claude-code（原文）/ cursor（.mdc rule）/ codex（AGENTS.md 段）/ plain（系统提示）。
// work profile 下默认禁止导出（core/profile 守卫，在命令层执行）。
import { existsSync, readFileSync } from 'node:fs';
import { files } from '../core/paths.js';
import type { OmemIndex } from '../core/index.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { UsageError } from '../core/util.js';

export type ContextTarget = 'claude-code' | 'cursor' | 'codex' | 'plain';

export const CONTEXT_TARGETS: ContextTarget[] = ['claude-code', 'cursor', 'codex', 'plain'];

export function exportContext(home: string, index: OmemIndex, target: string): string {
  if (!CONTEXT_TARGETS.includes(target as ContextTarget)) {
    throw new UsageError(`未知 --for 目标: ${target}（支持: ${CONTEXT_TARGETS.join(' / ')}）`);
  }
  // 保证派生视图最新（缺失或可疑时重生成）
  const indexPath = files.memoryIndex(home);
  if (!existsSync(indexPath)) generateMemoryIndex(home, index);
  const body = readFileSync(indexPath, 'utf8').trimEnd();

  switch (target as ContextTarget) {
    case 'claude-code':
      return body + '\n';
    case 'cursor':
      return ['---', 'description: omem 个人记忆索引（自动生成，勿手改）', 'alwaysApply: true', '---', '', body, ''].join('\n');
    case 'codex':
      return ['<!-- OMEM:START -->', '## omem（个人记忆）', '', body, '', '<!-- OMEM:END -->', ''].join('\n');
    case 'plain':
      return ['# omem 个人记忆索引', '', body, ''].join('\n');
  }
}
