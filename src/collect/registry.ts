// 采集器注册表：采集器 id、配置字段、隔离环境变量名的唯一真相源。
//
// 为什么需要它：每加一个采集器都要在四处登记同一个 id（COLLECTOR_IDS、config 字段、
// pipeline 的 ROOT_ENV、冒烟脚本的隔离 env）。任何一处漏登记，隔离就破——漏掉冒烟那处时，
// 端到端冒烟会把开发者本机的真实会话目录扫进测试产物（2026-10-26 实测：catpaw 采集器
// 漏配导致冒烟读到了真实 ~/.catpaw）。
//
// 所以这里把三项绑定在一起，由 tests/unit/collector-isolation.test.ts 强制校验：
//  1. configKey 在 OmemConfig.collect 中真实存在，且默认值以 ~ 开头（否则 env 覆盖不了，隔离不可能）；
//  2. envKey 确实被采集器读取（用隔离目录实测 root() 是否落进去）；
//  3. tests/smoke.sh 显式导出了每一个 envKey。
// 三条任一不满足，单测立刻红——不是等 CI 或等用户发现隐私泄漏。

export const COLLECTOR_IDS = [
  'claude-code',
  'workbuddy',
  'cursor',
  'qwenwork',
  'doubao',
  'deepseek',
  'qoder',
  'catpaw',
] as const;

export type CollectorId = (typeof COLLECTOR_IDS)[number];

export interface CollectorSpec {
  /** OmemConfig.collect 中对应的字段名。一个采集器可能有多个根（Qoder 国际版 + 中文版）。 */
  configKeys: readonly string[];
  /** 覆盖对应根目录的环境变量名，与 configKeys 一一对应。测试与冒烟靠它做隔离。 */
  envKeys: readonly string[];
}

/**
 * 注册表本体。新增采集器时只在这里加一行，其余地方由本文件派生或由守护测试校验。
 * configKeys 与 envKeys 一一对应：第 i 个 configKey 的默认值若以 ~ 开头，
 * 则第 i 个 envKey 的值会覆盖它（rootFrom 语义）。
 */
export const COLLECTOR_SPECS: Record<CollectorId, CollectorSpec> = {
  'claude-code': { configKeys: ['claude_projects'], envKeys: ['OMEM_CLAUDE_PROJECTS'] },
  workbuddy: { configKeys: ['workbuddy_projects'], envKeys: ['OMEM_WORKBUDDY_PROJECTS'] },
  cursor: { configKeys: ['cursor_projects'], envKeys: ['OMEM_CURSOR_PROJECTS'] },
  qwenwork: { configKeys: ['qwenwork_projects'], envKeys: ['OMEM_QWENWORK_PROJECTS'] },
  doubao: { configKeys: ['doubao_projects'], envKeys: ['OMEM_DOUBAO_PROJECTS'] },
  deepseek: { configKeys: ['deepseek_projects'], envKeys: ['OMEM_DEEPSEEK_PROJECTS'] },
  qoder: {
    configKeys: ['qoder_projects', 'qoder_cn_projects'],
    envKeys: ['OMEM_QODER_PROJECTS', 'OMEM_QODER_CN_PROJECTS'],
  },
  catpaw: { configKeys: ['catpaw_projects'], envKeys: ['OMEM_CATPAW_PROJECTS'] },
};

/** 注册表里出现过的全部环境变量名（去重，保持注册顺序）。 */
export function allCollectorEnvKeys(): string[] {
  const seen = new Set<string>();
  for (const id of COLLECTOR_IDS) {
    for (const k of COLLECTOR_SPECS[id].envKeys) seen.add(k);
  }
  return [...seen];
}
