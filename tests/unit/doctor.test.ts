// omem doctor：只读体检，且不能因为可选来源缺失就失败。
//
// 回归的是真实排查路径：装机失败时用户只拿到一句启动报错，
// 真实原因分散在 Node 版本、原生绑定、config、git、采集器根目录五处。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { cmdDoctor, compareVersion, parseNodeFloor } from '../../src/commands/doctor.js';
import { saveConfig, defaultConfig } from '../../src/core/config.js';
import { makeHome, cleanupHome, isolateAllCollectors } from './helpers.js';

let home: string;
let logs: string[];
const orig = console.log;

beforeEach(() => {
  home = makeHome();
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  process.env.OMEM_HOME = home;
  const config = defaultConfig();
  // 采集器根全部指向不存在的目录：doctor 只做 existsSync，绝不读真实会话目录。
  isolateAllCollectors(config, join(home, 'absent-collector-roots'));
  saveConfig(home, config);
});
afterEach(() => {
  console.log = orig;
  delete process.env.OMEM_HOME;
  cleanupHome(home);
});

describe('omem doctor', () => {
  it('parses the engines floor and compares versions without guessing', () => {
    expect(parseNodeFloor('>=22.5.0')).toEqual([22, 5, 0]);
    expect(parseNodeFloor('nonsense')).toBeNull();
    expect(compareVersion([22, 5, 0], [22, 20, 0])).toBeLessThan(0);
    expect(compareVersion([22, 20, 0], [22, 5, 0])).toBeGreaterThan(0);
    expect(compareVersion([22, 5, 0], [22, 5, 0])).toBe(0);
  });

  it('reports store, counts, zstd and every collector without failing', async () => {
    const code = await cmdDoctor({ _: [], flags: {} });
    const text = logs.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('omem ');
    expect(text).toContain('Node');
    expect(text).toContain('Store');
    expect(text).toContain('Documents');
    expect(text).toContain('zstd');
    // 九个采集器各有一行，且缺失只算 warn。
    for (const id of ['claude-code', 'workbuddy', 'cursor', 'qwenwork', 'doubao', 'deepseek', 'qoder', 'catpaw', 'codebuddy']) {
      expect(text).toContain(id);
    }
    expect(text).toMatch(/warning\(s\)|All checks passed/);
    expect(code).toBe(0); // 缺可选来源不是错误
  });

  it('--strict still exits 0 when there is no error-level problem', async () => {
    const code = await cmdDoctor({ _: [], flags: { strict: true } });
    expect(code).toBe(0);
  });
});