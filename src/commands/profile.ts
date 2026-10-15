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
      throw new UsageError('用法: omem profile use <work|home>');
    }
    const current = currentProfile(config);
    if (next === current) {
      console.log(`当前已是 ${next} profile`);
      return 0;
    }
    if (profileLocked(config)) {
      throw new UsageError(
        `当前为 ${current} profile 且已锁定（OMEM_PROFILE_LOCKED=1 或 config profile.work.locked），无法切换。`,
      );
    }
    config.general.profile = next;
    saveConfig(home, config);
    console.log(`已切换到 ${next} profile${next === 'work' ? '（导出/同步默认禁止）' : ''}`);
    return 0;
  }

  // status（默认）
  const current = currentProfile(config);
  const locked = profileLocked(config);
  const all = listEntries(home);
  const work = all.filter((l) => l.entry.fm.profile === 'work').length;
  const homeCount = all.length - work;
  console.log(`当前 profile: ${current}${locked ? '（已锁定）' : ''}`);
  console.log(`条目分布: work ${work} · home ${homeCount}`);
  if (current === 'work') {
    console.log('work profile：omem sync / omem context 默认禁止（OMEM_ALLOW_WORK_EXPORT=1 可临时放行）');
  }
  void index;
  return 0;
}
