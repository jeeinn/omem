// omem init：建库 + git 数据仓 + 扫描已有会话（规则抽取，规格 §7）。
// --no-scan 跳过首次扫描；--no-git 跳过数据仓初始化。
import { existsSync } from 'node:fs';
import { ensureHome, files } from '../core/paths.js';
import { loadConfig, saveConfig } from '../core/config.js';
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

  console.log(`omem 数据目录: ${home}${fresh ? '（已创建）' : '（已存在）'}`);

  // git 数据仓（SyncBackend 抽象的第一实现；规格 §5.3）
  if (flagBool(args.flags, 'no-git')) {
    console.log('跳过 git 数据仓初始化（--no-git）');
  } else {
    try {
      getBackend('git', home, config).init();
      console.log('git 数据仓已初始化（事实源 = knowledge/，index/snapshots/logs 已排除）');
    } catch (e: any) {
      console.log(`git 数据仓初始化跳过: ${e.message}${e.hint ? `（${e.hint}）` : ''}`);
    }
  }

  generateMemoryIndex(home, index);

  if (flagBool(args.flags, 'no-scan')) {
    console.log('跳过首次会话扫描（--no-scan）');
  } else {
    const report = runPipeline(home, config, index, {});
    console.log(
      `首次扫描（档 0 规则抽取，零配置）：会话 ${report.sessions}（跳过未变化 ${report.skipped}），` +
        `消息 ${report.messages}，候选 ${report.candidates}，写入 ${report.written.length}，` +
        `去重 ${report.deduped}，脱敏 ${report.redacted}，排除 ${report.excluded}`,
    );
    for (const n of report.notes) console.log(`  · ${n}`);
  }

  console.log('');
  console.log('下一步：');
  console.log('  omem install            自动检测并接线本机 Agent（MCP）');
  console.log('  omem search "<关键词>"  检索记忆');
  console.log('  omem sync               跨机器同步（git）');
  return 0;
}
