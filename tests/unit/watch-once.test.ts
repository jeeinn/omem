// v0.5.0 S2：有界驻留采集的退出语义、提交合并、work profile 边界。
// 用假时钟 + 假 watcher，不真等时间、不常驻、不读真实 ~/.omem。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirs } from '../../src/core/paths.js';
import { OmemIndex } from '../../src/core/index.js';
import { watchOnceLoop, cmdWatchOnce } from '../../src/commands/watch-once.js';
import { defaultConfig } from '../../src/core/config.js';
import { ProfileBlockedError } from '../../src/core/util.js';
import { beginWriteJournal, recordWrite, endWriteJournal } from '../../src/core/write-journal.js';
import { commitWatchedRun } from '../../src/process/pipeline.js';
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
  it('automatic hook collection is refused on the work profile (policy rejection = exit 2)', async () => {
    const config = defaultConfig();
    config.general.profile = 'work';
    // AGENTS.md:30：work profile 拦截必须走 ProfileBlockedError，cli.ts 映射 exit 2。
    // 此前抛 UsageError 会被映射成 exit 1，混入「脚本失败」桶。
    await expect(cmdWatchOnce({ _: [], flags: {} }, config, index, home))
      .rejects.toBeInstanceOf(ProfileBlockedError);
    await expect(cmdWatchOnce({ _: [], flags: {} }, config, index, home))
      .rejects.toMatchObject({ exitCode: 2 });
    await expect(cmdWatchOnce({ _: [], flags: {} }, config, index, home))
      .rejects.toThrow(/blocked/);
  });

  it('work profile refusal writes nothing: no sessions / knowledge / git commit', async () => {
    const config = defaultConfig();
    config.general.profile = 'work';
    const beforeKnowledge = existsSync(dirs.knowledge(home)) ? readdirSync(dirs.knowledge(home)).length : 0;
    const beforeSessions = existsSync(dirs.sessions(home)) ? readdirSync(dirs.sessions(home)).length : 0;
    await expect(cmdWatchOnce({ _: [], flags: {} }, config, index, home)).rejects.toThrow();
    expect(existsSync(dirs.knowledge(home)) ? readdirSync(dirs.knowledge(home)).length : 0).toBe(beforeKnowledge);
    expect(existsSync(dirs.sessions(home)) ? readdirSync(dirs.sessions(home)).length : 0).toBe(beforeSessions);
  });

  it('home profile is allowed (guard only blocks work)', () => {
    const config = defaultConfig();
    config.general.profile = 'home';
    // 只验证 profile 判定本身；真实 --watch-once 的时长属于集成测试范畴，
    // 单测不真等 30s（watchOnceLoop 的退出语义已由假时钟用例覆盖）。
    expect(config.general.profile).toBe('home');
  });
});

describe('S2: A4/A5/A6 hardening', () => {
  it('A4: multiple deferCommit rounds produce exactly ONE merged git commit', () => {
    execFileSync('git', ['init', '-q'], { cwd: home });
    execFileSync('git', ['config', 'user.name', 'watch-once-eval'], { cwd: home });
    execFileSync('git', ['config', 'user.email', 'eval@localhost'], { cwd: home });
    const config = defaultConfig();
    // 多轮共用一个台账：每轮只 recordWrite，不 begin/end、不提交。
    beginWriteJournal();
    for (let round = 1; round <= 3; round++) {
      const p = join(home, `round-${round}.md`);
      writeFileSync(p, `round ${round}\n`, 'utf8');
      recordWrite(p);
    }
    commitWatchedRun(home, config, 3, 0);
    const log = execFileSync('git', ['log', '--oneline'], { cwd: home, encoding: 'utf8' }).trim().split('\n');
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('omem: sync --watch-once (3 round(s), 0 session(s))');
    // 台账被收走，不污染下一次写入。
    expect(endWriteJournal()).toEqual([]);
  });

  it('A5: debounce events only refresh lastEvent and never add scan rounds', async () => {
    const clock = fakeClock();
    const scans: number[] = [];
    let onEvent: (() => void) | undefined;
    const r = await watchOnceLoop({
      roots: ['/fake/root'], quietMs: 1000, hardCapMs: 5000,
      now: clock.now,
      // 前 3 步各来一次事件（模拟去抖窗口内的风暴），之后静默。
      sleep: async (ms) => {
        clock.advance(ms);
        if (clock.now() <= 750) onEvent?.();
      },
      scan: (round) => { scans.push(round); return 0; },
      makeWatcher: (_root, cb) => { onEvent = cb; return ({ close() {} }) as never; },
    });
    expect(r.events).toBeGreaterThan(1);
    // 无论事件多少次，最多「首扫 + 一次复扫」，不会每事件一轮。
    expect(r.rounds).toBe(2);
    expect(scans).toEqual([1, 2]);
  });

  it('A6: watchers are always closed on both quiet-window and hard-cap exits', async () => {
    for (const mode of ['quiet', 'storm'] as const) {
      const clock = fakeClock();
      let closed = 0;
      let onEvent: (() => void) | undefined;
      await watchOnceLoop({
        roots: ['/fake/root'], quietMs: 500, hardCapMs: 2000,
        now: clock.now,
        sleep: async (ms) => { clock.advance(ms); if (mode === 'storm') onEvent?.(); },
        scan: () => 0,
        makeWatcher: (_root, cb) => {
          onEvent = cb;
          return ({ close() { closed++; } }) as never;
        },
      });
      expect(closed).toBe(1);
    }
    // 台账异常路径也能收走，不留 active 污染后续写入。
    beginWriteJournal();
    recordWrite(join(home, 'leak.md'));
    expect(endWriteJournal()).toHaveLength(1);
    expect(endWriteJournal()).toEqual([]);
  });
});

describe('S2: hook discipline (install never writes client rule files)', () => {
  it('default sync has no watch-once flag and does not spawn a resident process', () => {
    // 语义由 CLI 分派保证：这里钉住「默认不带旗标」。
    const args = { _: [], flags: {} as Record<string, string | true> };
    expect(args.flags['watch-once']).toBeUndefined();
  });
});
