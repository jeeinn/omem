// omem sync：拉取 + 推送一条命令（规格 §7；§5.5 冲突策略）。
// 子命令：status | use <git|webdav|dir> | remote <url> | pull | push；无子命令 = pull→push。
// 冲突是事件不是错误：退出码 0，stdout 列出冲突文件与 .conflict.md 位置。
import { openCtx } from '../core/ctx.js';
import { getBackend } from '../sync/backend.js';
import type { SyncReport } from '../sync/backend.js';
import { assertExportAllowed } from '../core/profile.js';
import { saveConfig } from '../core/config.js';
import { appendLog } from '../core/log.js';
import { UsageError } from '../core/util.js';
import type { ParsedArgs } from '../cli-args.js';

function newReport(backend: string): SyncReport {
  return { backend, pushed: false, conflicts: [], notes: [] };
}

export async function cmdSync(args: ParsedArgs): Promise<number> {
  const { home, config, index } = openCtx();
  const sub = args._[0];

  if (sub === 'status') {
    const backend = getBackend(config.sync.backend, home, config);
    const st = backend.status();
    console.log(`后端: ${st.backend}${st.available ? '' : '（未初始化）'}`);
    console.log(`远端: ${st.remote ?? '（未配置：omem sync remote <url>）'}`);
    console.log(`待推送: ${st.ahead} · 待拉取: ${st.behind} · 未提交改动: ${st.dirty}`);
    if (st.note) console.log(`备注: ${st.note}`);
    return 0;
  }

  if (sub === 'use') {
    const id = args._[1];
    if (!id || !['git', 'webdav', 'dir'].includes(id)) {
      throw new UsageError('用法: omem sync use <git|webdav|dir>（V0.1 仅 git 已交付）');
    }
    config.sync.backend = id as 'git' | 'webdav' | 'dir';
    saveConfig(home, config);
    if (id !== 'git') {
      console.log(`已切换后端设置为 ${id}。注意：该后端 V0.2 交付（webdav 优先）；V0.1 实际仍走 git。`);
      return 0;
    }
    console.log('已切换同步后端: git');
    return 0;
  }

  if (sub === 'remote') {
    const url = args._[1];
    if (!url) throw new UsageError('用法: omem sync remote <url>');
    const backend = getBackend('git', home, config) as any;
    backend.setRemote(url);
    config.sync.git.remote = url;
    saveConfig(home, config);
    console.log(`已设置远端: ${url}`);
    return 0;
  }

  const backend = getBackend(config.sync.backend, home, config);
  backend.init();
  const report = newReport(backend.id);

  if (sub === 'pull') {
    backend.pull(report);
    return printReport(report, home);
  }
  if (sub === 'push') {
    assertExportAllowed('omem sync push', config); // work profile 禁导出
    backend.push(report);
    return printReport(report, home);
  }
  if (sub) {
    throw new UsageError(`未知子命令: ${sub}（status / use / remote / pull / push）`);
  }

  // 默认：pull → push（规格 §5.5）
  backend.pull(report);
  assertExportAllowed('omem sync', config);
  backend.push(report);
  return printReport(report, home);
}

function printReport(report: SyncReport, home: string): number {
  for (const n of report.notes) console.log(`· ${n}`);
  if (report.conflicts.length > 0) {
    console.log(`\n冲突 ${report.conflicts.length} 个（事件不是错误，本地版本已保留）：`);
    for (const f of report.conflicts) {
      console.log(`  - ${f}`);
      console.log(`    远端版本另存: ${f}.conflict.md（请人工比对后处理）`);
    }
  }
  console.log(`\nsync 完成（pushed=${report.pushed}）`);
  appendLog(home, 'sync', { pushed: report.pushed, conflicts: report.conflicts.length });
  return 0; // 冲突已处理 → 0（规格 §7 退出码语义）
}
