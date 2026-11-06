// CLI 面收敛的守门测试（C 阶段）。
//
// 为什么值得单独钉住：命令表、README、AGENTS.md、`docs-consistency` 四处各写一遍，
// 删命令时最容易漏掉其中一处，而「文档里还写着已删命令」正是上一版产品的问题。
// 这里以**运行时 help 输出**为准绳，把三条断言写死：
//   1. 14 条命令一条不少（含独立的 process）；
//   2. 已删的命令（eval / api / audit / snapshot / gc / context / rebuild）一条不许出现
//      ——help、README，以及 src 里运行期会打出来的文案；
//   3. 指向命令的提示必须落在现行命令上（诊断入口是 `omem process --dry-run`）。
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { main } from '../../src/cli.js';
import { endpointUnavailableError } from '../../src/process/api.js';
import { processSummaryLines } from '../../src/commands/process.js';
import type { RunReport } from '../../src/process/pipeline.js';

/** 现行 14 条（process 从 sync --tier api 拆出）。 */
const KEPT = [
  'init', 'install', 'sync', 'process', 'skip', 'add', 'search', 'review',
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
  it('帮助里恰好是这 14 条命令', async () => {
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

  /**
   * 回执里的 `omem …` 也是产品面：用户会把 Next 段和错误 hint 当成可执行的下一步。
   * 帮助与 README 已经有守门，运行期文案却没有——2026-11-03 发现两处仍在教用户
   * 跑 `omem api status`（C 阶段已删），另一处还在说 `omem context` 被 work profile 挡住。
   */
  it('src 的用户可见文案不指向已删命令（注释里允许讲历史）', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, i) => {
        const t = raw.trim();
        // 注释允许提到已删命令（那是在记录「为什么删」）：行注释与块注释续行。
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        for (const name of REMOVED) {
          if (new RegExp(`omem ${name}\\b`).test(raw)) {
            hits.push(`${relative(process.cwd(), file)}:${i + 1} → omem ${name}`);
          }
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('API 档的诊断入口是 omem process --dry-run（不是已删的 omem api status）', () => {
    // 中止时的 hint：必须给一条现在真的能跑的命令。
    expect(endpointUnavailableError(3).hint).toContain('omem process --dry-run');

    // 队列还有存量时打印的 Next 段，同理。
    const report: RunReport = {
      tier: 'api',
      sessions: 3,
      skipped: 0,
      messages: 9,
      candidates: 0,
      written: [],
      deduped: 0,
      redacted: 0,
      excluded: 0,
      notes: [],
      failed: 0,
      parseFailed: 0,
      quarantined: 0,
      queuePending: 2,
      elapsedMs: 1200,
    };
    const next = processSummaryLines(report, false).join('\n');
    expect(next).toContain('omem process --dry-run');
    expect(next).toContain('omem process');
    expect(next).not.toContain('omem sync --tier api');
  });
});

/** src/ 下的 .ts 文件（递归）。 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (name.endsWith('.ts')) acc.push(path);
  }
  return acc;
}
