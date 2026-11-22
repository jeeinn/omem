// I-3：initialize.instructions 长度约定（软约束，源码注释 instructions.ts:23）。
// 取最长非 ASCII home 路径的最坏口径；按字符计量（mcp-probe.mjs 的 instr.length 同口径）。
// 同时守住契约：PROCESS.md 路径与六步工作循环必须在场（AGENTS.md:27 与 save_memory description 同源）。
import { describe, it, expect } from 'vitest';
import { mcpInstructions, RULE_EVIDENCE, RULE_CONFIDENCE, RULE_MULTIHOP } from '../../src/context/instructions.js';
import { join } from 'node:path';

const WORST_HOME = join('C:', 'Users', '测试用户', '非常长的项目路径', 'omem-data-store');

describe('initialize.instructions budget', () => {
  it('stays within 2048 chars even on the longest non-ASCII home path', () => {
    const text = mcpInstructions(WORST_HOME);
    expect(text.length).toBeLessThanOrEqual(2048);
  });

  it('keeps the contract pieces: PROCESS.md path, six-step loop, all three rules', () => {
    const text = mcpInstructions(WORST_HOME);
    expect(text).toContain('PROCESS.md');
    for (const step of ['1.', '2.', '3.', '4.', '5.', '6.']) expect(text).toContain(step);
    expect(text).toContain(RULE_EVIDENCE);
    expect(text).toContain(RULE_CONFIDENCE);
    expect(text).toContain(RULE_MULTIHOP);
    for (const phrase of ['never delete', 'no near-duplicates', 'omem review', 'git-native']) {
      expect(text).toContain(phrase);
    }
  });

  it('the rule constants themselves stay intact (shared with context/export.ts markers)', () => {
    // 这些常量同时出现在 omem context --for 的导出标记段，缩短它们会改写导出产物。
    expect(RULE_EVIDENCE).toContain('12 consecutive characters');
    expect(RULE_EVIDENCE).toContain('## user');
    expect(RULE_CONFIDENCE).toContain('0.35');
    expect(RULE_CONFIDENCE).toContain('0.90');
    expect(RULE_MULTIHOP).toContain('AND-matched');
    expect(RULE_MULTIHOP).toContain('as_of');
  });
});
