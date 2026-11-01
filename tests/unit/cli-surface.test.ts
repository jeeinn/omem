// CLI 面收敛的守门测试（C 阶段）。
//
// 为什么值得单独钉住：命令表、README、AGENTS.md、`docs-consistency` 四处各写一遍，
// 删命令时最容易漏掉其中一处，而「文档里还写着已删命令」正是上一版产品的问题。
// 这里以**运行时 help 输出**为准绳，把两条断言写死：
//   1. 13 条命令一条不少；
//   2. 已删的命令（eval / api / audit / snapshot / gc / context / rebuild）一条不许出现。
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli.js';

/** 现行 13 条（D8：gc 并入 review；rebuild 改名 verify）。 */
const KEPT = [
  'init', 'install', 'sync', 'skip', 'add', 'search', 'review',
  'topics', 'verify', 'backup', 'profile', 'redact', 'serve',
];

/** 已删除的顶层命令：文档与帮助里都不许再出现。 */
const REMOVED = ['eval', 'api', 'audit', 'snapshot', 'gc', 'context', 'rebuild'];

async function helpText(): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  });
  try {
    await main([]);
  } finally {
    log.mockRestore();
  }
  return lines.join('\n');
}

describe('cli surface', () => {
  it('帮助里恰好是这 13 条命令', async () => {
    const text = await helpText();
    for (const name of KEPT) {
      expect(text, `missing command in help: ${name}`).toMatch(new RegExp(`^\\s*${name}\\b`, 'm'));
    }
  });

  it('已删命令不再出现在帮助里', async () => {
    const text = await helpText();
    for (const name of REMOVED) {
      expect(text, `removed command still advertised: ${name}`).not.toMatch(new RegExp(`^\\s*${name}\\b`, 'm'));
    }
  });

  it('README 的命令表与实现同步（不许再写已删命令）', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    for (const name of REMOVED) {
      expect(readme, `README still documents removed command: ${name}`)
        .not.toMatch(new RegExp(`\\| \`omem ${name}\\b`));
    }
    for (const name of KEPT) {
      expect(readme, `README is missing command: ${name}`)
        .toMatch(new RegExp(`\\| \`omem ${name}\\b`));
    }
  });
});
