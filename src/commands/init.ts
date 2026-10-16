// omem init：建库 + git 数据仓 + 扫描已有会话（规则抽取，规格 §7）。
// --no-scan 跳过首次扫描；--no-git 跳过数据仓初始化。
import { existsSync } from 'node:fs';
import { ensureHome, files } from '../core/paths.js';
import { loadConfig, saveConfig, findRemovedConfigKeys } from '../core/config.js';
import { OmemIndex } from '../core/index.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { getBackend } from '../sync/backend.js';
import { runPipeline } from '../process/pipeline.js';
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

  console.log(`omem data directory: ${home}${fresh ? ' (created)' : ' (already exists)'}`);

  // config.toml 里残留的已移除键：不自动改文件（会丢掉用户手写的未知键），只点名让他删
  for (const r of findRemovedConfigKeys(home)) {
    console.log(`config.toml: ignoring removed key ${r}`);
    console.log(`  → delete that line from ${files.config(home)} to avoid confusion.`);
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

  if (flagBool(args.flags, 'no-scan')) {
    console.log('Skipping initial session scan (--no-scan)');
  } else {
    const report = runPipeline(home, config, index, {});
    console.log(
      `Initial scan (tier ${report.tier}): sessions ${report.sessions} (skipped unchanged ${report.skipped}), ` +
        `messages ${report.messages}, candidates ${report.candidates}, written ${report.written.length}, ` +
        `deduped ${report.deduped}, redacted ${report.redacted}, excluded ${report.excluded}`,
    );
    for (const n of report.notes) console.log(`  · ${n}`);
  }

  console.log('');
  console.log('Next steps:');
  console.log('  omem install            Auto-detect and wire up local Agents (MCP)');
  console.log('  omem search "<query>"   Search memories');
  console.log('  omem sync               Sync across machines (git)');
  return 0;
}
