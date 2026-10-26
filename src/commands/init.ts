// omem init：建库 + git 数据仓（规格 §7）。不扫描会话；采集用 omem sync。
// --no-scan 仍接受，无操作（旧脚本兼容）。--no-git 跳过数据仓初始化。
import { existsSync } from 'node:fs';
import { ensureHome, files } from '../core/paths.js';
import { loadConfig, saveConfig, findRemovedConfigKeys, appendMissingConfigKeys } from '../core/config.js';
import { OmemIndex } from '../core/index.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { getBackend } from '../sync/backend.js';
import { omemHome } from '../core/paths.js';
import { flagBool } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdInit(args: ParsedArgs): Promise<number> {
  const home = omemHome();
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
    } else {
      try {
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
