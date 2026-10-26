// 单元测试共享辅助：隔离的临时 OMEM_HOME。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHome } from '../../src/core/paths.js';
import { saveConfig, defaultConfig } from '../../src/core/config.js';
import type { OmemConfig } from '../../src/core/config.js';
import { COLLECTOR_IDS, COLLECTOR_SPECS } from '../../src/collect/registry.js';

export function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omem-test-'));
  ensureHome(dir);
  saveConfig(dir, defaultConfig());
  return dir;
}

export function cleanupHome(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function withConfig(home: string, mutate: (c: OmemConfig) => void): OmemConfig {
  const config = defaultConfig();
  mutate(config);
  saveConfig(home, config);
  return config;
}

/** 一个保证不存在的路径。用作采集根目录时，scanSessions 会跳过它。 */
export const ABSENT_ROOT = join(tmpdir(), 'omem-absent-root-that-does-not-exist');

/**
 * 把所有采集器的会话根目录指向不存在的路径，切断测试对本机真实会话的读取。
 *
 * 为什么需要这个 helper：每个采集器的根目录默认值都指向开发者本机的真实目录
 * （~/.claude、~/.catpaw、~/.qoder……）。测试里忘了隔离某一个，测试就会扫到
 * 本机真实会话——2026-10-26 的端到端冒烟就是这么把真实 ~/.catpaw 的对话
 * 写进了测试产物。
 *
 * 为什么用注册表驱动：手写清单必然漏。COLLECTOR_IDS 每加一个成员，
 * 这里自动覆盖；tests/unit/collector-isolation.test.ts 另有一条断言，
 * 确认所有采集器的配置键都被本 helper 覆盖（新增采集器却忘了隔离 → 测试红）。
 *
 * except：保留这些配置键的现值（不覆盖）。需要真实数据的采集器先设好路径，
 * 再调用本函数并把它的键列进 except；或者反过来——先调用本函数，再单独改回来。
 * 两种顺序都可以，但 except 更不容易出错。
 *
 * 用法：
 *   const config = defaultConfig();
 *   isolateAllCollectors(config);                          // 全部指向不存在路径
 *   config.collect.claude_projects = FIXTURE;             // 需要真实数据的再改回来
 *   isolateAllCollectors(config, undefined, ['claude_projects']); // 或用 except
 */
export function isolateAllCollectors(
  config: OmemConfig,
  absent: string = ABSENT_ROOT,
  except: readonly string[] = [],
): OmemConfig {
  const collect = config.collect as unknown as Record<string, unknown>;
  const keep = new Set(except);
  for (const id of COLLECTOR_IDS) {
    for (const key of COLLECTOR_SPECS[id].configKeys) {
      if (keep.has(key)) continue;
      collect[key] = absent;
    }
  }
  return config;
}

/** 注册表里声明的全部采集根配置键（去重）。用于「有没有漏隔离」的断言。 */
export function allCollectorConfigKeys(): string[] {
  const seen = new Set<string>();
  for (const id of COLLECTOR_IDS) {
    for (const key of COLLECTOR_SPECS[id].configKeys) seen.add(key);
  }
  return [...seen];
}
