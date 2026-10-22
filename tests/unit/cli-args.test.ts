// CLI 参数解析测试（零依赖解析器）。
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, flagStr, flagBool, VALUE_FLAGS } from '../../src/cli-args.js';

describe('cli-args', () => {
  it('--key=value form', () => {
    const a = parseArgs(['search', '--domain=coding']);
    expect(a._).toEqual(['search']);
    expect(flagStr(a.flags, 'domain')).toBe('coding');
  });

  it('--key value form', () => {
    const a = parseArgs(['review', '--confirm', '2026-10-15-a1b2c3']);
    expect(flagStr(a.flags, 'confirm')).toBe('2026-10-15-a1b2c3');
    expect(a._).toEqual(['review']);
  });

  it('--key boolean and -x short flag', () => {
    const a = parseArgs(['search', 'q', '--detail', '--all', '-v']);
    expect(flagBool(a.flags, 'detail')).toBe(true);
    expect(flagBool(a.flags, 'all')).toBe(true);
    expect(flagBool(a.flags, 'v')).toBe(true);
    expect(a._).toEqual(['search', 'q']);
  });

  it('values starting with -- are not swallowed as flag values', () => {
    const a = parseArgs(['sync', 'use', '--backend']);
    expect(a._).toEqual(['sync', 'use']);
    expect(a.flags.backend).toBe(true);
  });

  it('flagStr returns undefined for boolean flags', () => {
    const a = parseArgs(['gc', '--apply']);
    expect(flagStr(a.flags, 'apply')).toBeUndefined();
  });
});

describe('cli-args: boolean flags never swallow the following positional (defect: --sessions before query)', () => {
  it('--sessions before the query keeps the query in positionals', () => {
    const a = parseArgs(['search', '--sessions', '手写 SQL']);
    expect(a._).toEqual(['search', '手写 SQL']);
    expect(flagBool(a.flags, 'sessions')).toBe(true);
  });

  it('--all before the query keeps the query in positionals', () => {
    const a = parseArgs(['search', '--all', '部署']);
    expect(a._).toEqual(['search', '部署']);
    expect(flagBool(a.flags, 'all')).toBe(true);
  });

  it('--detail and short flags likewise stay boolean', () => {
    const a = parseArgs(['search', '--detail', '连接池']);
    expect(a._).toEqual(['search', '连接池']);
    expect(flagBool(a.flags, 'detail')).toBe(true);
  });

  it('query-first ordering still works (backward compatible)', () => {
    const a = parseArgs(['search', '部署', '--domain', 'ops', '--all']);
    expect(a._).toEqual(['search', '部署']);
    expect(flagStr(a.flags, 'domain')).toBe('ops');
    expect(flagBool(a.flags, 'all')).toBe(true);
  });
});

describe('cli-args: registered value flags', () => {
  it('value flag swallows its value in either position', () => {
    expect(flagStr(parseArgs(['add', '内容', '--type', 'fact']).flags, 'type')).toBe('fact');
    expect(flagStr(parseArgs(['add', '--type', 'fact', '内容']).flags, 'type')).toBe('fact');
    expect(parseArgs(['add', '--type', 'fact', '内容'])._).toEqual(['add', '内容']);
  });

  it('numeric flag (--limit) keeps its value', () => {
    const a = parseArgs(['run', '--tier', 'api', '--limit', '5']);
    expect(flagStr(a.flags, 'limit')).toBe('5');
    expect(flagStr(a.flags, 'tier')).toBe('api');
    expect(a._).toEqual(['run']);
  });

  it('--key=value works even for keys not in VALUE_FLAGS (explicit form always wins)', () => {
    const a = parseArgs(['x', '--future-flag=1']);
    expect(a.flags['future-flag']).toBe('1');
  });

  it('anti-drift: every flagStr/flagNum key used in src/ is registered in VALUE_FLAGS', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, name.name);
        if (name.isDirectory()) walk(p);
        else if (name.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(srcDir);
    const used = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/flag(?:Str|Num)\(\s*(?:args\.)?flags\s*,\s*'([^']+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(10); // 确认扫描到了全部命令
    for (const key of used) {
      expect(VALUE_FLAGS.has(key), `flag "${key}" is used via flagStr/flagNum but not registered in VALUE_FLAGS`).toBe(true);
    }
  });
});
