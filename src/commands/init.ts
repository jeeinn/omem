// omem init：建库 + git 数据仓（规格 §7）。不扫描会话；采集用 omem sync。
// --no-scan 仍接受，无操作（旧脚本兼容）。--no-git 跳过数据仓初始化。
// --force 强制重置已初始化的 git 数据仓。--clone <url> 从远端克隆（多机正确姿势）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureHome, files } from '../core/paths.js';
import { loadConfig, saveConfig, findRemovedConfigKeys, appendMissingConfigKeys } from '../core/config.js';
import { OmemIndex } from '../core/index.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { getBackend } from '../sync/backend.js';
import { GitBackend } from '../sync/git.js';
import { omemHome } from '../core/paths.js';
import { flagBool, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

function gitTry(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, out, err: '' };
  } catch (e: any) {
    return { ok: false, out: '', err: String(e.stderr ?? e.message ?? e) };
  }
}

/**
 * 多机工作流：从远端克隆而不是本地 git init。
 * 避免每台机器各自 init 产生不相干历史，后续 pull 报 unrelated histories。
 */
function cmdInitClone(home: string, url: string, force: boolean): number {
  if (!GitBackend.available()) {
    console.error('git command not found.');
    console.error('  → Please install git first: https://git-scm.com/downloads');
    return 2;
  }
  if (existsSync(home)) {
    if (!force) {
      console.log(`Data directory already exists: ${home}`);
      console.log('  → use --force to overwrite (deletes the directory and clones from remote).');
      return 1;
    }
    rmSync(home, { recursive: true, force: true });
  }
  // git clone 要求目标不存在，父目录必须存在。
  const parent = dirname(home);
  mkdirSync(parent, { recursive: true });
  const r = gitTry(['clone', url, home], parent);
  if (!r.ok) {
    console.error(`Clone failed: ${r.err.trim().split('\n')[0]}`);
    console.error('  → check the URL and your network/SSH key, then retry.');
    return 1;
  }
  console.log(`Cloned from ${url}`);
  const config = loadConfig(home);
  // config.toml 里残留的已移除键：不自动改文件（会丢掉用户手写的未知键），只点名让他删
  for (const removed of findRemovedConfigKeys(home)) {
    console.log(`config.toml: ignoring removed key ${removed}`);
    console.log(`  → delete that line from ${files.config(home)} to avoid confusion.`);
  }
  // 缺失的新键（新采集器等）：补写进去，让用户看得见、改得动。
  const added = appendMissingConfigKeys(home);
  if (added.length > 0) {
    console.log(`config.toml: added ${added.length} missing key(s): ${added.join(', ')}`);
  }
  const index = new OmemIndex(home);
  try {
    generateMemoryIndex(home, index);
  } finally {
    index.close();
  }
  console.log('\nNext\n  omem sync\n  omem backup');
  return 0;
}

export async function cmdInit(args: ParsedArgs): Promise<number> {
  const home = omemHome();
  const cloneUrl = flagStr(args.flags, 'clone');
  if (cloneUrl) {
    return cmdInitClone(home, cloneUrl, flagBool(args.flags, 'force'));
  }

  const fresh = !existsSync(home);
  ensureHome(home);
  const config = loadConfig(home);
  if (fresh || !existsSync(files.config(home))) saveConfig(home, config);
  const index = new OmemIndex(home);
  try {
    console.log(`omem data directory: ${home}${fresh ? ' (created)' : ' (already exists)'}`);

    // config.toml 里残留的已移除键：不自动改文件（会丢掉用户手写的未知键），只点名让他删
    for (const r of findRemovedConfigKeys(home)) {
      console.log(`config.toml: ignoring removed key ${r}`);
      console.log(`  → delete that line from ${files.config(home)} to avoid confusion.`);
    }

    // 缺失的新键（新采集器等）：补写进去，让用户看得见、改得动。
    // 文本级插入，只加缺的那几行，其余内容原样保留。
    const added = appendMissingConfigKeys(home);
    if (added.length > 0) {
      console.log(`config.toml: added ${added.length} missing key(s): ${added.join(', ')}`);
      console.log(`  → these are new options with default values; edit ${files.config(home)} to change them.`);
    }

    // git 数据仓（SyncBackend 抽象的第一实现；规格 §5.3）
    if (flagBool(args.flags, 'no-git')) {
      console.log('Skipping git data repo initialization (--no-git)');
    } else if (existsSync(join(home, '.git')) && !flagBool(args.flags, 'force')) {
      console.log('git data repo already initialized; use --force to reset (deletes .git and re-inits).');
      console.log('  → warning: local commit history will be lost. If unpushed commits exist, run `omem backup push` first.');
    } else {
      try {
        if (flagBool(args.flags, 'force') && existsSync(join(home, '.git'))) {
          rmSync(join(home, '.git'), { recursive: true, force: true });
          console.log('Removed existing .git (re-initializing with --force).');
        }
        getBackend('git', home, config).init();
        console.log('git data repo initialized (source of truth = knowledge/ and sessions/; index/snapshots/logs/PROCESS.md excluded)');
      } catch (e: any) {
        console.log(`git data repo initialization skipped: ${e.message}${e.hint ? ` (${e.hint})` : ''}`);
      }
    }

    generateMemoryIndex(home, index);

    console.log('');
    console.log('Next');
    console.log('  omem sync');
    console.log('  omem sync --collectors cursor,qwenwork');
    console.log('  omem install');
    return 0;
  } finally {
    index.close();
  }
}
