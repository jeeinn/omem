// omem backup：拉取 + 推送一条命令（规格 §7；§5.5 冲突策略）。
// 子命令：status | use <git|webdav|dir> | remote <url> | pull | push；无子命令 = pull→push。
// 冲突是事件不是错误：退出码 0，stdout 列出冲突文件与 .conflict.md 位置。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  const ctx = openCtx();
  try {
    return await syncBody(args, ctx);
  } finally {
    // Windows 上 SQLite 句柄不释放的话，临时 OMEM_HOME 连删除都会 EBUSY。
    ctx.index.close();
  }
}

async function syncBody(args: ParsedArgs, ctx: ReturnType<typeof openCtx>): Promise<number> {
  const home = ctx.home;
  const config = ctx.config;
  // D9：任何 git 动作之前扫非空 [api].key——pull 的 autosave 也会 git add -A，
  // 等到 push 再拦，密钥已经进了 pull 的自动提交。只警告：不阻塞、不改文件、退出码不变。
  if (config.api.key) {
    console.log('config.toml contains a non-empty [api].key; it will be committed to the git data repo.');
    console.log('  → prefer OMEM_API_KEY in the environment, or add config.toml to .gitignore.');
  }
  const sub = args._[0];

  if (sub === 'status') {
    const backend = getBackend(config.sync.backend, home, config);
    const st = backend.status();
    console.log(`Backend: ${st.backend}${st.available ? '' : ' (not initialized)'}`);
    console.log(`Remote: ${st.remote ?? '(not configured: omem backup remote <url>)'}`);
    console.log(`Ahead: ${st.ahead} · Behind: ${st.behind} · Uncommitted: ${st.dirty}`);
    if (st.note) console.log(`Note: ${st.note}`);
    return 0;
  }

  if (sub === 'use') {
    const id = args._[1];
    if (!id || !['git', 'webdav', 'dir'].includes(id)) {
      throw new UsageError('Usage: omem backup use <git|webdav|dir> (only git is delivered in V0.1)');
    }
    config.sync.backend = id as 'git' | 'webdav' | 'dir';
    saveConfig(home, config);
    if (id !== 'git') {
      console.log(`Backend setting switched to ${id}. Note: this backend ships in V0.2 (webdav first); V0.1 still uses git.`);
      return 0;
    }
    console.log('Sync backend switched: git');
    return 0;
  }

  if (sub === 'remote') {
    const url = args._[1];
    if (!url) throw new UsageError('Usage: omem backup remote <url>');
    const backend = getBackend('git', home, config) as any;
    backend.setRemote(url);
    config.sync.git.remote = url;
    saveConfig(home, config);
    console.log(`Remote set: ${url}`);
    return 0;
  }

  const backend = getBackend(config.sync.backend, home, config);
  // 只在数据仓还没 git 初始化时才建仓：原来这里每次 sync 都调 init()，而 init() 会 add+commit，
  // 于是用 init 的提交信息抢在 push() 前把改动提交掉——历史全是同名提交，
  // push() 的变更检查也永远为空（误导性的 "No local changes; nothing to commit"）。
  if (!existsSync(join(home, '.git'))) backend.init();
  const report = newReport(backend.id);

  if (sub === 'pull') {
    backend.pull(report);
    return printReport(report, home);
  }
  if (sub === 'push') {
    assertExportAllowed('omem backup push', config); // work profile 禁导出
    backend.push(report);
    return printReport(report, home);
  }
  if (sub) {
    throw new UsageError(`Unknown subcommand: ${sub} (status / use / remote / pull / push)`);
  }

  // 默认：pull → push（规格 §5.5）
  backend.pull(report);
  assertExportAllowed('omem backup', config);
  backend.push(report);
  return printReport(report, home);
}

function printReport(report: SyncReport, home: string): number {
  for (const n of report.notes) console.log(`· ${n}`);
  if (report.conflicts.length > 0) {
    console.log(`\n${report.conflicts.length} conflict(s) (events, not errors; local versions kept):`);
    for (const f of report.conflicts) {
      console.log(`  - ${f}`);
      console.log(`    Remote version saved as: ${f}.conflict.md (compare manually and resolve)`);
    }
  }
  console.log(`\nbackup complete (pushed=${report.pushed})`);
  appendLog(home, 'sync', { pushed: report.pushed, conflicts: report.conflicts.length });
  return 0; // 冲突已处理 → 0（规格 §7 退出码语义）
}
