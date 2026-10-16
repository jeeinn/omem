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

// 行为指令段（beta.3：修复「规则文件只带索引、不带写回指令」的 P1 缺口，
// 让读/写两条链路都自动触发；marker 供未来工具定位替换）。
export const INSTRUCTIONS_START = '<!-- OMEM:INSTRUCTIONS:START -->';
export const INSTRUCTIONS_END = '<!-- OMEM:INSTRUCTIONS:END -->';

export const INSTRUCTIONS: string = [
  INSTRUCTIONS_START,
  '## omem usage instructions (auto-generated, do not edit)',
  '',
  '**Read:** the index above is this user\'s long-term memory (preferences / facts / decisions / experiences). When the user mentions past preferences, historical decisions, previous project experience, or environment configuration — or whenever you are unsure whether they told you something before — get details via MCP `search_memory` or `omem search "<keywords>"` before answering. If nothing matches, say so; do not invent.',
  '',
  '**Write:** when this session produces a stable preference / decision / environment configuration / pitfall lesson — and when wrapping up a substantive session — call MCP `save_memory` without waiting to be asked. One conclusion per entry, 3-10 sentences; keep conclusions, drop process. If the user asks you to organize memories, first read `~/.omem/PROCESS.md` (it lists up to 5 sessions without conclusions), then distill those sessions via `save_memory`; `evidence` must be at least 12 characters copied verbatim from that session\'s `## user` section.',
  '',
  'Never mark an entry verified yourself; `verified` comes only from `omem add` or `omem review --confirm`.',
  INSTRUCTIONS_END,
].join('\n');

export function exportContext(home: string, index: OmemIndex, target: string): string {
  if (!CONTEXT_TARGETS.includes(target as ContextTarget)) {
    throw new UsageError(`Unknown --for target: ${target} (supported: ${CONTEXT_TARGETS.join(' / ')})`);
  }
  // 保证派生视图最新（缺失或可疑时重生成）
  const indexPath = files.memoryIndex(home);
  if (!existsSync(indexPath)) generateMemoryIndex(home, index);
  const body = readFileSync(indexPath, 'utf8').trimEnd();

  switch (target as ContextTarget) {
    case 'claude-code':
      return body + '\n\n' + INSTRUCTIONS + '\n';
    case 'cursor':
      return ['---', 'description: omem personal memory index (auto-generated, do not edit)', 'alwaysApply: true', '---', '', body, '', INSTRUCTIONS, ''].join('\n');
    case 'codex':
      return ['<!-- OMEM:START -->', '## omem (personal memory)', '', body, '', INSTRUCTIONS, '', '<!-- OMEM:END -->', ''].join('\n');
    case 'plain':
      return ['# omem personal memory index', '', body, '', INSTRUCTIONS, ''].join('\n');
  }
}
