// omem profile：work/home 切换与状态（规格 §7；评估 4.4 决策 9）。
// work 默认禁导出/同步；OMEM_PROFILE_LOCKED=1 或 config profile.work.locked 可强制锁定。
import { openCtx } from '../core/ctx.js';
import { saveConfig } from '../core/config.js';
import { currentProfile, profileLocked } from '../core/profile.js';
import { listEntries } from '../core/store.js';
import { UsageError } from '../core/util.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdProfile(args: ParsedArgs): Promise<number> {
  const { home, config, index } = openCtx();
  const sub = args._[0];

  if (sub === 'use') {
    const next = args._[1];
    if (next !== 'work' && next !== 'home') {
      throw new UsageError('Usage: omem profile use <work|home>');
    }
    const current = currentProfile(config);
    if (next === current) {
      console.log(`Already on the ${next} profile`);
      return 0;
    }
    if (profileLocked(config)) {
      throw new UsageError(
        `Currently on the ${current} profile, which is locked (OMEM_PROFILE_LOCKED=1 or config profile.work.locked); cannot switch.`,
      );
    }
    config.general.profile = next;
    saveConfig(home, config);
    console.log(`Switched to the ${next} profile${next === 'work' ? ' (export/sync blocked by default)' : ''}`);
    return 0;
  }

  // status（默认）
  const current = currentProfile(config);
  const locked = profileLocked(config);
  const all = listEntries(home);
  const work = all.filter((l) => l.entry.fm.profile === 'work').length;
  const homeCount = all.length - work;
  console.log(`Current profile: ${current}${locked ? ' (locked)' : ''}`);
  console.log(`Entry distribution: work ${work} · home ${homeCount}`);
  if (current === 'work') {
    console.log('work profile: omem sync / omem context are blocked by default (OMEM_ALLOW_WORK_EXPORT=1 temporarily allows)');
  }
  void index;
  return 0;
}
