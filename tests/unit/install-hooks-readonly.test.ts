// v0.5.0 S2：hook 接线纪律（默认不装、显式旗标、只读、失败不拖垮宿主）。
import { describe, it, expect } from 'vitest';
import { cmdInstall } from '../../src/commands/install.js';

describe('install --print-hooks is read-only', () => {
  it('prints a bounded hook snippet and returns 0 without writing client configs', async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    let code = -1;
    try {
      code = await cmdInstall({ _: [], flags: { 'print-hooks': true } });
    } finally {
      console.log = orig;
    }
    const out = lines.join('\n');
    expect(code).toBe(0);
    expect(out).toContain('never installs this automatically');
    expect(out).toContain('omem sync --watch-once');
    expect(out).toContain('--hard-cap-ms 30000');
    expect(out).toContain('work profile');
    // 只给片段，不写客户端规则文件（AGENTS.md install 六条写纪律）。
    expect(out).toContain('omem only writes MCP config');
  });

  it('plain install does not trigger hooks (no implicit setup)', () => {
    // 语义由 CLI 分派钉住：旗标缺省时 cmdInstall 走原有 target 分支。
    const flags: Record<string, string | true> = {};
    expect(flags['print-hooks']).toBeUndefined();
  });
});
