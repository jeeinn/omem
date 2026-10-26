// 文档与实现的一致性守护。
//
// 为什么需要：2026-10-26 的审计发现，c8da44b 引入了第一个原生运行时依赖
// （@toondepauw/node-zstd，DeepSeek 会话需要解压），但 AGENTS.md 里
// 「The only runtime dependency is @modelcontextprotocol/sdk」那句原封不动——
// 文档说的和代码做的不一致，而 AGENTS.md 是下一个改代码的人（人或 Agent）读的依据。
// 同样地，采集器从 3 个加到 8 个，ARCHITECTURE.md 还写着「只读扫描 Claude Code、
// WorkBuddy、Cursor」。
//
// 这些断言把文档钉在实现上：改了 package.json 的依赖、或增删采集器，
// 对应文档没跟着改就会红。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTOR_IDS } from '../../src/collect/registry.js';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const PKG = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const AGENTS = read('AGENTS.md');
const ARCH = read('ARCHITECTURE.md');
const README = read('README.md');
const MANUAL = read('docs/手动测试指南.md');

describe('docs: runtime dependencies are stated accurately', () => {
  const runtimeDeps = Object.keys(PKG.dependencies ?? {});

  it('AGENTS.md names every runtime dependency', () => {
    for (const dep of runtimeDeps) {
      expect(AGENTS, `AGENTS.md must mention the runtime dependency ${dep}`).toContain(dep);
    }
  });

  it('AGENTS.md does not claim there is only one runtime dependency', () => {
    // 旧文本：「The only runtime dependency is @modelcontextprotocol/sdk」
    expect(AGENTS).not.toMatch(/only runtime dependency/i);
  });

  it('README explains the native dependency and its prebuilt availability', () => {
    expect(README).toContain('@toondepauw/node-zstd');
    expect(README).toContain('预编译');
  });

  it('ARCHITECTURE.md explains why a native dependency exists', () => {
    expect(ARCH).toContain('@toondepauw/node-zstd');
    expect(ARCH).toContain('zstd');
  });

  it('no native module other than the declared ones is pulled in at runtime', () => {
    // node:sqlite 是内建的，不进 dependencies。SQLite 类原生包（如 better-sqlite3）
    // 不允许出现在运行时依赖里。
    expect(runtimeDeps).not.toContain('better-sqlite3');
    for (const dep of runtimeDeps) {
      if (dep === '@toondepauw/node-zstd') continue;
      expect(dep, `${dep} must not be a native module`).not.toMatch(/sqlite|zstd|sharp|canvas/);
    }
  });
});

describe('docs: the collector list matches the registry', () => {
  it('ARCHITECTURE.md lists every collector', () => {
    for (const id of COLLECTOR_IDS) {
      expect(ARCH, `ARCHITECTURE.md must list the collector ${id}`).toContain(`\`${id}\``);
    }
  });

  it('README lists every collector in its support table', () => {
    for (const id of COLLECTOR_IDS) {
      expect(README, `README.md must list the collector ${id}`).toContain(`\`${id}\``);
    }
  });

  it('the manual test guide lists every collector isolation env var', () => {
    for (const id of COLLECTOR_IDS) {
      // env 名形如 OMEM_CATPAW_PROJECTS；用 id 推出的形式做粗校验，
      // 精确清单由 collector-isolation.test.ts 负责。
      const guess = `OMEM_${id.toUpperCase().replace(/-/g, '_')}_PROJECTS`;
      if (id === 'claude-code') continue; // OMEM_CLAUDE_PROJECTS 是历史名
      expect(MANUAL, `the manual guide must mention ${guess}`).toContain(guess);
    }
  });

  it('the manual test guide does not tell users to run the removed `omem run`', () => {
    // c1c9df8 把采集命令改名为 omem sync，omem run 已删除。
    // 匹配的是「把 omem run 当命令用」的写法；「omem run 已删除」这类迁移说明不算。
    expect(MANUAL).not.toMatch(/omem(\.js)?\s+run\s/);
  });

  it('README does not tell users to run the removed `omem run`', () => {
    expect(README).not.toMatch(/omem run\s+--/);
    expect(README).not.toMatch(/^\s*omem run\b/m);
  });
});
