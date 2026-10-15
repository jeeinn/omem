// CLI 参数解析测试（零依赖解析器）。
import { describe, it, expect } from 'vitest';
import { parseArgs, flagStr, flagBool } from '../../src/cli-args.js';

describe('cli-args', () => {
  it('--key=value 形式', () => {
    const a = parseArgs(['search', '--domain=coding']);
    expect(a._).toEqual(['search']);
    expect(flagStr(a.flags, 'domain')).toBe('coding');
  });

  it('--key value 形式', () => {
    const a = parseArgs(['review', '--confirm', '2026-10-15-a1b2c3']);
    expect(flagStr(a.flags, 'confirm')).toBe('2026-10-15-a1b2c3');
    expect(a._).toEqual(['review']);
  });

  it('--key 布尔与 -x 短旗', () => {
    const a = parseArgs(['search', 'q', '--detail', '--all', '-v']);
    expect(flagBool(a.flags, 'detail')).toBe(true);
    expect(flagBool(a.flags, 'all')).toBe(true);
    expect(flagBool(a.flags, 'v')).toBe(true);
    expect(a._).toEqual(['search', 'q']);
  });

  it('值以 -- 开头时不被吞为 flag 值', () => {
    const a = parseArgs(['sync', 'use', '--backend']);
    expect(a._).toEqual(['sync', 'use']);
    expect(a.flags.backend).toBe(true);
  });

  it('flagStr 对布尔旗返回 undefined', () => {
    const a = parseArgs(['gc', '--apply']);
    expect(flagStr(a.flags, 'apply')).toBeUndefined();
  });
});
