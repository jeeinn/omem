// work/home profile 守卫（评估 4.4 决策 9 / 第 8 章 P0 公司设备合规）。
// work profile：默认禁止导出/同步（push、context export）；可被 OMEM_PROFILE_LOCKED=1 强制锁定。
import type { OmemConfig } from './config.js';
import type { Profile } from './config.js';
import { ProfileBlockedError } from './util.js';

export function currentProfile(config: OmemConfig, env: NodeJS.ProcessEnv = process.env): Profile {
  if (env.OMEM_PROFILE === 'work') return 'work';
  if (env.OMEM_PROFILE === 'home') return 'home';
  return config.general.profile;
}

export function profileLocked(config: OmemConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OMEM_PROFILE_LOCKED === '1') return true;
  return currentProfile(config, env) === 'work' && config.profile_work.locked;
}

/** 导出/同步前的守卫。work 且未显式放行 → 拒绝（退出码 2）。 */
export function assertExportAllowed(cmd: string, config: OmemConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (currentProfile(config, env) !== 'work') return;
  if (env.OMEM_ALLOW_WORK_EXPORT === '1') return;
  throw new ProfileBlockedError(
    `Currently on the work profile: ${cmd} is blocked (corporate-device compliance: prevents company assets from syncing off the intranet).\n` +
    '  To proceed anyway: OMEM_ALLOW_WORK_EXPORT=1 ' + cmd + '\n' +
    '  Or switch profile: omem profile use home',
  );
}

/** 代码密度启发式：work profile 下默认排除代码类条目（评估 4.4 决策 9）。 */
export function isCodeHeavy(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;
  const codeish = lines.filter((l) =>
    /[;{}()]|=>|\b(?:function|const|let|var|class|def|import|from|SELECT|INSERT|UPDATE|DELETE|return|if|for|while)\b/.test(l),
  ).length;
  return codeish / lines.length >= 0.4;
}
