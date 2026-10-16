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

  it('claude-code: INDEX verbatim', () => {
    const text = exportContext(home, index, 'claude-code');
    expect(text).toContain('MEMORY-INDEX');
    expect(text).toContain('手写 SQL 的约定');
  });

  it('cursor: .mdc frontmatter + alwaysApply', () => {
    const text = exportContext(home, index, 'cursor');
    expect(text.startsWith('---')).toBe(true);
    expect(text).toContain('alwaysApply: true');
    expect(text).toContain('手写 SQL 的约定');
  });

  it('codex: AGENTS.md marker section', () => {
    const text = exportContext(home, index, 'codex');
    expect(text).toContain('<!-- OMEM:START -->');
    expect(text).toContain('<!-- OMEM:END -->');
  });

  it('plain: system prompt text', () => {
    const text = exportContext(home, index, 'plain');
    expect(text).toContain('# omem personal memory index');
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
