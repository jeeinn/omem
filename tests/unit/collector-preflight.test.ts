// 采集器隔离：一个采集器自检或枚举失败，只能让它自己缺席。
//
// 回归的事故：DeepSeek 采集器在模块顶层构造原生 zstd 解压器，原生绑定缺失时
// import 期就抛，把 `omem --version` 和另外八个采集器一起拖下水。
// 这里用模块级 mock 让 deepseek 失败，断言 scanSessions 不抛、其他采集器照常，
// 且失败原因进入 ScanRoot.error（而不是被静默吞掉）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/core/config.js';
import { OmemIndex } from '../../src/core/index.js';
import { makeHome, cleanupHome, isolateAllCollectors } from './helpers.js';

const state = vi.hoisted(() => ({ mode: 'preflight' as 'preflight' | 'list-throw' | 'healthy' }));

vi.mock('../../src/collect/deepseek.js', () => ({
  defaultDeepSeekRoot: () => '/nonexistent',
  listDeepSeekSessions: () => {
    if (state.mode === 'list-throw') throw new Error('list exploded');
    return [];
  },
  parseDeepSeekFile: () => null,
  deepseekZstdError: () => (state.mode === 'preflight' ? 'Cannot find native binding' : undefined),
}));

const { scanSessions } = await import('../../src/collect/collector.js');

let home: string;
let index: OmemIndex;
let dsRoot: string;
let ccRoot: string;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  dsRoot = mkdtempSync(join(tmpdir(), 'omem-ds-'));
  ccRoot = mkdtempSync(join(tmpdir(), 'omem-cc-'));
});

afterEach(() => {
  index.close();
  cleanupHome(home);
  rmSync(dsRoot, { recursive: true, force: true });
  rmSync(ccRoot, { recursive: true, force: true });
});

function isolatedConfig() {
  const config = defaultConfig();
  // 其余采集器统一指向空目录（结构性隔离，不手写清单）；
  // 只有被测的 deepseek 换成自己的临时根。绝对路径不会被 OMEM_* 覆盖。
  isolateAllCollectors(config, ccRoot, ['deepseek_projects']);
  config.collect.deepseek_projects = dsRoot;
  return config;
}

describe('collector isolation: one failing source must not stop the scan', () => {
  it('preflight failure is reported on ScanRoot and the sibling collector still scans', () => {
    state.mode = 'preflight';
    const scan = scanSessions(index, isolatedConfig(), { collectors: ['deepseek', 'claude-code'] });

    const ds = scan.roots.find((r) => r.id === 'deepseek')!;
    expect(ds.exists).toBe(true);
    expect(ds.error).toContain('Cannot find native binding');

    const cc = scan.roots.find((r) => r.id === 'claude-code')!;
    expect(cc.exists).toBe(true);
    expect(cc.error).toBeUndefined();
    // 没有抛错，digests 是空数组而不是异常。
    expect(Array.isArray(scan.digests)).toBe(true);
  });

  it('a throwing list() is captured as an error instead of escaping', () => {
    state.mode = 'list-throw';
    const scan = scanSessions(index, isolatedConfig(), { collectors: ['deepseek', 'claude-code'] });
    const ds = scan.roots.find((r) => r.id === 'deepseek')!;
    expect(ds.error).toContain('list exploded');
    const cc = scan.roots.find((r) => r.id === 'claude-code')!;
    expect(cc.error).toBeUndefined();
  });

  it('a healthy collector carries no error field at all', () => {
    state.mode = 'healthy';
    const scan = scanSessions(index, isolatedConfig(), { collectors: ['deepseek'] });
    const ds = scan.roots.find((r) => r.id === 'deepseek')!;
    expect(ds.error).toBeUndefined();
  });
});