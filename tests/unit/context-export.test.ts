// 上下文导出测试（评估 4.2/4.5：omem context --for <agent> 四目标）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { exportContext, CONTEXT_TARGETS } from '../../src/context/export.js';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import { files } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  const e = {
    fm: newFrontmatter({ id: '2026-10-15-e1', type: 'fact', domain: 'coding' }),
    body: '手写 SQL 的约定',
  };
  const { path, content } = writeEntry(home, e);
  index.upsert(e, path, content);
});
afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('context: export four targets', () => {
  it('supported target list', () => {
    expect(CONTEXT_TARGETS).toEqual(['claude-code', 'cursor', 'codex', 'plain']);
  });

  it('claude-code: INDEX + instructions', () => {
    const text = exportContext(home, index, 'claude-code');
    expect(text).toContain('MEMORY-INDEX');
    expect(text).toContain('手写 SQL 的约定');
    expect(text).toContain('<!-- OMEM:INSTRUCTIONS:START -->');
    expect(text).toContain('## omem usage instructions');
  });

  it('cursor: .mdc frontmatter + alwaysApply + instructions', () => {
    const text = exportContext(home, index, 'cursor');
    expect(text.startsWith('---')).toBe(true);
    expect(text).toContain('alwaysApply: true');
    expect(text).toContain('手写 SQL 的约定');
    expect(text).toContain('<!-- OMEM:INSTRUCTIONS:START -->');
    expect(text).toContain('<!-- OMEM:INSTRUCTIONS:END -->');
    expect(text).toContain('save_memory');
    expect(text).toContain('PROCESS.md');
    expect(text).toContain('## user');
  });

  it('codex: AGENTS.md marker section with instructions inside', () => {
    const text = exportContext(home, index, 'codex');
    expect(text).toContain('<!-- OMEM:START -->');
    expect(text).toContain('<!-- OMEM:END -->');
    const start = text.indexOf('<!-- OMEM:START -->');
    const end = text.indexOf('<!-- OMEM:END -->');
    const inner = text.slice(start, end);
    expect(inner).toContain('<!-- OMEM:INSTRUCTIONS:START -->');
  });

  it('plain: system prompt text with instructions', () => {
    const text = exportContext(home, index, 'plain');
    expect(text).toContain('# omem personal memory index');
    expect(text).toContain('<!-- OMEM:INSTRUCTIONS:START -->');
  });

  it('auto-regenerates when INDEX is missing', () => {
    rmSync(files.memoryIndex(home), { force: true });
    const text = exportContext(home, index, 'claude-code');
    expect(text).toContain('手写 SQL 的约定');
  });

  it('unknown target throws UsageError', () => {
    expect(() => exportContext(home, index, 'vim')).toThrow(/Unknown --for target/);
  });
});
