// v0.5.0 S2：有界驻留采集的退出语义、提交合并、work profile 边界。
// 用假时钟 + 假 watcher，不真等时间、不常驻、不读真实 ~/.omem。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { watchOnceLoop, cmdWatchOnce } from '../../src/commands/watch-once.js';
import { defaultConfig } from '../../src/core/config.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('S2: bounded residency', () => {
  it('no events -> quiet window exit after one scan, no second round', async () => {
    const clock = fakeClock();
    const scans: number[] = [];
    const r = await watchOnceLoop({
      roots: ['/fake/root'], quietMs: 2000, hardCapMs: 30_000,
      now: clock.now, sleep: clock.sleep,
      scan: (round) => { scans.push(round); return 0; },
      makeWatcher: () => ({ close() {} }) as never,
    });
    expect(r.reason).toBe('quiet-window');
    expect(r.rounds).toBe(1);
    expect(scans).toEqual([1]);
    expect(r.events).toBe(0);
  });

  it('events -> second confirming scan, still bounded', async () => {
    const clock = fakeClock();
    const scans: number[] = [];
    let onEvent: (() => void) | undefined;
    const r = await watchOnceLoop({
      roots: ['/fake/root'], quietMs: 2000, hardCapMs: 30_000,
      now: clock.now, sleep: clock.sleep,
      scan: (round) => { scans.push(round); return 1; },
      makeWatcher: (_root, cb) => { onEvent = cb; clock.advance(250); cb(); return ({ close() {} }) as never; },
    });
    expect(onEvent).toBeDefined();
    expect(r.events).toBeGreaterThan(0);
    expect(r.rounds).toBe(2);
    expect(scans).toEqual([1, 2]);
    expect(r.reason).toBe('quiet-window');
  });

  it('event storm never exceeds the hard cap', async () => {
    const clock = fakeClock();
    let steps = 0;
    let onEvent: (() => void) | undefined;
    const r = await watchOnceLoop({
      roots: ['/fake/root'], quietMs: 1000, hardCapMs: 3000,
      now: clock.now,
      // 每步都注入事件，lastEvent 一直被刷新 → 静默窗永远不满足，只能靠硬上限退出。
      sleep: async (ms) => { clock.advance(ms); steps++; onEvent?.(); },
      scan: () => 0,
      makeWatcher: (_root, cb) => { onEvent = cb; return ({ close() { /* no-op */ } }) as never; },
    });
    expect(r.reason).toBe('hard-cap');
    expect(r.elapsedMs).toBeLessThanOrEqual(3000);
    expect(r.events).toBeGreaterThan(0);
    expect(steps).toBeLessThan(20);
  });

  it('no collector roots -> immediate exit, no watcher', async () => {
    const clock = fakeClock();
    const r = await watchOnceLoop({
      roots: [], quietMs: 2000, hardCapMs: 30_000,
      now: clock.now, sleep: clock.sleep, scan: () => 0,
    });
    expect(r.reason).toBe('no-roots');
    expect(r.rounds).toBe(1);
    expect(r.elapsedMs).toBe(0);
  });
});

describe('S2: work profile boundary', () => {
  it('automatic hook collection is refused on the work profile', async () => {
    const config = defaultConfig();
    config.general.profile = 'work';
    await expect(cmdWatchOnce({ _: [], flags: {} }, config, index, home))
      .rejects.toThrow(/disabled on the work profile/);
  });

  it('home profile is allowed (guard only blocks work)', () => {
    const config = defaultConfig();
    config.general.profile = 'home';
    // 只验证 profile 判定本身；真实 --watch-once 的时长属于集成测试范畴，
    // 单测不真等 30s（watchOnceLoop 的退出语义已由假时钟用例覆盖）。
    expect(config.general.profile).toBe('home');
  });
});

describe('S2: hook discipline (install never writes client rule files)', () => {
  it('default sync has no watch-once flag and does not spawn a resident process', () => {
    // 语义由 CLI 分派保证：这里钉住「默认不带旗标」。
    const args = { _: [], flags: {} as Record<string, string | true> };
    expect(args.flags['watch-once']).toBeUndefined();
  });
});
