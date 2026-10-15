// cli.ts 分发器测试：帮助/版本/未知命令的退出码契约（规格 §7：0 成功 / 1 用法错误 / 2 后端或策略）。
// 注意：import cli.js 不得触发自动执行——由 isProcessEntry() 护栏保证（OMEM_CLI_ENTRY / argv[1] 均不匹配）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { main } from '../../src/cli.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.join(' '));
  });
  return { out, err };
}

describe('cli: 顶层分发', () => {
  it('omem --help 退出 0（显式求助不是用法错误）', async () => {
    const { out } = capture();
    expect(await main(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('用法');
    expect(out.join('\n')).toContain('search');
  });

  it('omem -h 退出 0', async () => {
    capture();
    expect(await main(['-h'])).toBe(0);
  });

  it('omem help 退出 0', async () => {
    capture();
    expect(await main(['help'])).toBe(0);
  });

  it('裸 omem（无参数）退出 1', async () => {
    capture();
    expect(await main([])).toBe(1);
  });

  it('未知命令退出 1 且提示', async () => {
    const { err } = capture();
    expect(await main(['nonsense'])).toBe(1);
    expect(err.join('\n')).toContain('未知命令');
  });

  it('version / --version / -v 均退出 0 且输出版本号', async () => {
    for (const argv of [['version'], ['--version'], ['-v']]) {
      const { out } = capture();
      expect(await main(argv)).toBe(0);
      expect(out.join('')).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('单命令 --help 退出 0 并打印该命令用法', async () => {
    const { out } = capture();
    expect(await main(['search', '--help'])).toBe(0);
    expect(out.join('\n')).toContain('omem search <查询词>');
  });

  it('sync --help 展示子命令用法', async () => {
    const { out } = capture();
    expect(await main(['sync', '--help'])).toBe(0);
    expect(out.join('\n')).toContain('remote <url>');
  });
});
