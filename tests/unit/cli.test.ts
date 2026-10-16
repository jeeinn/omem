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

describe('cli: top-level dispatch', () => {
  it('omem --help exits 0 (explicit help is not a usage error)', async () => {
    const { out } = capture();
    expect(await main(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
    expect(out.join('\n')).toContain('search');
  });

  it('omem -h exits 0', async () => {
    capture();
    expect(await main(['-h'])).toBe(0);
  });

  it('omem help exits 0', async () => {
    capture();
    expect(await main(['help'])).toBe(0);
  });

  it('bare omem (no args) exits 1', async () => {
    capture();
    expect(await main([])).toBe(1);
  });

  it('unknown command exits 1 with a hint', async () => {
    const { err } = capture();
    expect(await main(['nonsense'])).toBe(1);
    expect(err.join('\n')).toContain('Unknown command');
  });

  it('version / --version / -v all exit 0 and print the version', async () => {
    for (const argv of [['version'], ['--version'], ['-v']]) {
      const { out } = capture();
      expect(await main(argv)).toBe(0);
      // 版本号允许 semver prerelease（如 0.1.0-beta.1），公开测试期会用到
      expect(out.join('')).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    }
  });

  it('per-command --help exits 0 and prints that command usage', async () => {
    const { out } = capture();
    expect(await main(['search', '--help'])).toBe(0);
    expect(out.join('\n')).toContain('omem search <query>');
  });

  it('sync --help shows subcommand usage', async () => {
    const { out } = capture();
    expect(await main(['sync', '--help'])).toBe(0);
    expect(out.join('\n')).toContain('remote <url>');
  });
});
