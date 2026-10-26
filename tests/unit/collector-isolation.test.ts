// 采集器隔离守护测试。
//
// 为什么需要这个文件：每加一个采集器，都要在「采集器注册表 / config 字段 / pipeline 的
// 缺目录提示 / 冒烟脚本的隔离 env」四处登记同一个 id。任何一处漏登记，隔离就破——
// 漏掉冒烟那处时，端到端冒烟会把开发者本机的真实会话目录扫进测试产物
//（2026-10-26 实测：catpaw 采集器漏配，冒烟读到了真实 ~/.catpaw，把真实对话写进了
// .omem-test/home/sessions/）。
//
// 这个文件把「隔离不能破」变成测试期就会红的断言，而不是靠人记得。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTOR_IDS, COLLECTOR_SPECS, allCollectorEnvKeys } from '../../src/collect/registry.js';
import { getCollector } from '../../src/collect/collector.js';
import { defaultQoderCnRoot } from '../../src/collect/qoder.js';
import { defaultConfig } from '../../src/core/config.js';

const ROOT = process.cwd();
const SMOKE = readFileSync(join(ROOT, 'tests', 'smoke.sh'), 'utf8');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('collector isolation: registry is the single source of truth', () => {
  it('every collector id has a registry entry, and every entry id is known', () => {
    expect(Object.keys(COLLECTOR_SPECS).sort()).toEqual([...COLLECTOR_IDS].sort());
  });

  it('every collector declares at least one config key and env key', () => {
    for (const id of COLLECTOR_IDS) {
      const spec = COLLECTOR_SPECS[id];
      expect(spec.configKeys.length, `${id} needs a config key`).toBeGreaterThan(0);
      expect(spec.envKeys.length, `${id} needs an env key`).toBeGreaterThan(0);
      // config 与 env 一一对应：envKeys[i] 覆盖 configKeys[i]。
      expect(spec.envKeys.length, `${id} config/env count mismatch`).toBe(spec.configKeys.length);
    }
  });

  it('every declared config key exists in OmemConfig.collect and defaults to a ~ path', () => {
    // 默认值必须以 ~ 开头：rootFrom 只在 ~ 前缀时允许 env 覆盖。
    // 绝对路径默认值意味着 env 覆盖不了，隔离在原理上就不可能。
    const config = defaultConfig();
    for (const id of COLLECTOR_IDS) {
      for (const key of COLLECTOR_SPECS[id].configKeys) {
        const value = (config.collect as unknown as Record<string, string>)[key];
        expect(value, `${id} config key ${key} is missing from OmemConfig.collect`).toBeDefined();
        expect(value, `${id} config key ${key} must default to a ~ path so env can override it`).toMatch(/^~/);
      }
    }
  });

  it('every declared env key actually overrides the collector root', () => {
    // 实测而不是读源码：给每个 env 一个独立目录，getCollector().root() 必须落在里面。
    // 这条能抓住「注册表写了 envKey，但采集器实现里用的是另一个名字」这类漂移。
    const config = defaultConfig();
    for (const id of COLLECTOR_IDS) {
      const spec = COLLECTOR_SPECS[id];
      const env: NodeJS.ProcessEnv = {};
      spec.envKeys.forEach((k, i) => {
        env[k] = `/isolation-probe/${id}/${i}`;
      });
      const collector = getCollector(id, config, env);
      expect(collector.root(), `${id} root() must honor ${spec.envKeys[0]}`).toBe(`/isolation-probe/${id}/0`);
    }
  });

  it('env keys are unique across collectors (no two collectors share one override)', () => {
    const keys = allCollectorEnvKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('multi-root collectors also override their secondary root', () => {
    // Qoder 有国际版 + 中文版两个根。root() 只返回主根（用于展示），
    // 但 list() 会同时扫两个根——第二根的 env 覆盖不到就会读到真实目录。
    const config = defaultConfig();
    const env: NodeJS.ProcessEnv = {
      OMEM_QODER_PROJECTS: '/isolation-probe/qoder/intl',
      OMEM_QODER_CN_PROJECTS: '/isolation-probe/qoder/cn',
    };
    const collector = getCollector('qoder', config, env);
    expect(collector.root()).toBe('/isolation-probe/qoder/intl');
    expect(() => collector.list()).not.toThrow();
    expect(defaultQoderCnRoot(env)).toBe('/isolation-probe/qoder/cn');
  });
});

describe('collector isolation: the smoke script cannot drift from the registry', () => {
  it('smoke.sh derives the isolation list from the registry instead of hard-coding it', () => {
    // 手写清单是这个 bug 的根源：每加一个采集器就要记得补一行，漏了不会报错。
    // 派生之后新增采集器自动纳入隔离，不可能漏。
    expect(SMOKE).toContain('print-collector-envs.mjs');
    expect(SMOKE).toMatch(/for KEY in \$COLLECTOR_ENV_KEYS/);
  });

  it('smoke.sh hand-writes no collector env other than the Claude Code fixture', () => {
    // 只允许 OMEM_CLAUDE_PROJECTS 手写（它指向合成 fixture，不是空目录）。
    // 其余采集器一律由注册表派生。
    const handWritten = SMOKE.match(/^export OMEM_[A-Z_]*_PROJECTS=.*$/gm) ?? [];
    const names = [...new Set(handWritten.map((l) => l.match(/^export ([A-Z_]+)=/)![1]))];
    expect(names.sort()).toEqual(['OMEM_CLAUDE_PROJECTS']);
  });

  it('smoke.sh guards that every collector root stays inside the repository', () => {
    // 漏配 env 时采集器会退回 ~/.xxx 的真实目录，这里当场失败，
    // 而不是等到产物里混进真实会话才被发现。
    expect(SMOKE).toContain('is outside the repository');
    expect(SMOKE).toContain('must never read real session directories');
  });

  it('smoke.sh asserts no stray agent directory was produced', () => {
    // 行为层双保险：即使 env 全配了，也检查产物里没有非 fixture 的 agent 目录。
    expect(SMOKE).toContain('no stray agent directories in sessions/');
  });

  it('npm run smoke builds first, so the derived list cannot be stale', () => {
    // 隔离清单从 dist/ 读取。dist 过期 = 新采集器不在清单里 = 隔离破。
    // 所以 smoke 必须先构建，杜绝「改了 src 忘了 build」。
    expect(PKG.scripts.smoke).toMatch(/npm run build/);
  });
});
