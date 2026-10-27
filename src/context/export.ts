// omem context --for <agent>（评估 4.2/4.5：非 MCP 原生 Agent 的接入路径）。
// 生成 MEMORY-INDEX.md 的客户端形态：claude-code（原文）/ cursor（.mdc rule）/ codex（AGENTS.md 段）/ plain（系统提示）。
// work profile 下默认禁止导出（core/profile 守卫，在命令层执行）。
import { existsSync, readFileSync } from 'node:fs';
import { files } from '../core/paths.js';
import type { OmemIndex } from '../core/index.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { UsageError } from '../core/util.js';
// evidence 门槛与 verified 来源这两条规则同时出现在 MCP instructions 里（context/instructions.ts），
// 改一处必须改另一处，所以抽成常量，两边共用同一句话。
import { RULE_EVIDENCE, RULE_VERIFIED } from './instructions.js';

export type ContextTarget = 'claude-code' | 'cursor' | 'codex' | 'plain';

export const CONTEXT_TARGETS: ContextTarget[] = ['claude-code', 'cursor', 'codex', 'plain'];

// 行为指令段（beta.3：修复「规则文件只带索引、不带写回指令」的 P1 缺口，
// 让读/写两条链路都自动触发；marker 供未来工具定位替换）。
export const INSTRUCTIONS_START = '<!-- OMEM:INSTRUCTIONS:START -->';
export const INSTRUCTIONS_END = '<!-- OMEM:INSTRUCTIONS:END -->';

export function instructionsFor(home: string): string {
  const guide = files.processGuide(home);
  return [
    INSTRUCTIONS_START,
    '## omem usage instructions (auto-generated, do not edit)',
    '',
    '**Read:** the index above is this user\'s long-term memory. Search living documents first via MCP `search_memory` or `omem search "<keywords>"`. Pass `scope=sessions` or `omem search --sessions` only when the original wording is needed. If nothing matches, say so; do not invent.',
    '',
    `**Write:** when this session produces a stable preference, decision, configuration, or lesson, call MCP \`save_memory\` with a \`topic\`. One living document per topic. If that topic already has an active document, get its id with \`search_memory(topic="…")\` and pass it in \`supersedes\`. To absorb new transcripts, read \`${guide}\` (groups by project fingerprint plus sessions not yet in the document; a group is not a topic name — pass your own \`topic\`), and pass \`session_id\` as the bare id shown there.`,
    '',
    `**Ground:** ${RULE_EVIDENCE}.`,
    '',
    `**Trust:** do not save the chat that organizes PROCESS.md as a new topic. Never mark an entry verified yourself; ${RULE_VERIFIED}.`,
    INSTRUCTIONS_END,
  ].join('\n');
}

export function exportContext(home: string, index: OmemIndex, target: string): string {
  if (!CONTEXT_TARGETS.includes(target as ContextTarget)) {
    throw new UsageError(`Unknown --for target: ${target} (supported: ${CONTEXT_TARGETS.join(' / ')})`);
  }
  // 保证派生视图最新（缺失或可疑时重生成）
  const indexPath = files.memoryIndex(home);
  if (!existsSync(indexPath)) generateMemoryIndex(home, index);
  const body = readFileSync(indexPath, 'utf8').trimEnd();

  const instructions = instructionsFor(home);
  switch (target as ContextTarget) {
    case 'claude-code':
      return body + '\n\n' + instructions + '\n';
    case 'cursor':
      return ['---', 'description: omem personal memory index (auto-generated, do not edit)', 'alwaysApply: true', '---', '', body, '', instructions, ''].join('\n');
    case 'codex':
      return ['<!-- OMEM:START -->', '## omem (personal memory)', '', body, '', instructions, '', '<!-- OMEM:END -->', ''].join('\n');
    case 'plain':
      return ['# omem personal memory index', '', body, '', instructions, ''].join('\n');
  }
}
