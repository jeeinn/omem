// profile 守卫测试（评估 4.4 决策 9：公司设备合规）。
import { describe, it, expect } from 'vitest';
import { currentProfile, profileLocked, assertExportAllowed, isCodeHeavy } from '../../src/core/profile.js';
import { ProfileBlockedError } from '../../src/core/util.js';
import { defaultConfig } from '../../src/core/config.js';
import type { OmemConfig } from '../../src/core/config.js';

function cfg(mutate: (c: OmemConfig) => void = () => {}): OmemConfig {
  const c = defaultConfig();
  mutate(c);
  return c;
}

describe('profile: work/home guards', () => {
  it('defaults to home; env overrides', () => {
    expect(currentProfile(cfg(), {})).toBe('home');
    expect(currentProfile(cfg((c) => (c.general.profile = 'work')), {})).toBe('work');
    expect(currentProfile(cfg(), { OMEM_PROFILE: 'work' })).toBe('work');
  });

  it('home profile allows export', () => {
    expect(() => assertExportAllowed('omem context', cfg(), {})).not.toThrow();
  });

  it('work profile rejects export with an actionable hint', () => {
    const c = cfg((x) => (x.general.profile = 'work'));
    try {
      assertExportAllowed('omem backup', c, {});
      throw new Error('应当拒绝');
    } catch (e) {
      expect(e).toBeInstanceOf(ProfileBlockedError);
      expect((e as Error).message).toContain('OMEM_ALLOW_WORK_EXPORT');
      expect((e as Error).message).toContain('omem profile use home');
    }
  });

  it('OMEM_ALLOW_WORK_EXPORT=1 temporarily allows', () => {
    const c = cfg((x) => (x.general.profile = 'work'));
    expect(() => assertExportAllowed('omem backup', c, { OMEM_ALLOW_WORK_EXPORT: '1' })).not.toThrow();
  });

  it('locking: env and config paths', () => {
    const c = cfg((x) => {
      x.general.profile = 'work';
      x.profile_work.locked = true;
    });
    expect(profileLocked(c, {})).toBe(true);
    expect(profileLocked(cfg(), { OMEM_PROFILE_LOCKED: '1' })).toBe(true);
    expect(profileLocked(cfg(), {})).toBe(false);
  });

  it('code-density heuristic', () => {
    expect(isCodeHeavy('function foo() {\n  return 1;\n}')).toBe(true);
    expect(isCodeHeavy('用户喜欢在早上喝咖啡\n周末去公园跑步\n偶尔爬山')).toBe(false);
  });
});
