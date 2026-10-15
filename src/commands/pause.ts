// omem pause / omem resume：一键停采集（规格 §7；评估 3.4 信任三件套之一）。
import { openCtx } from '../core/ctx.js';
import { saveConfig } from '../core/config.js';
import { appendLog } from '../core/log.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdPause(): Promise<number> {
  const { home, config } = openCtx();
  config.general.paused = true;
  saveConfig(home, config);
  appendLog(home, 'pause', {});
  console.log('采集已暂停：omem run 与后续 watcher 不再加工会话（MCP save_memory 等显式写入不受影响）。');
  console.log('恢复: omem resume');
  return 0;
}

export async function cmdResume(): Promise<number> {
  const { home, config } = openCtx();
  config.general.paused = false;
  saveConfig(home, config);
  appendLog(home, 'resume', {});
  console.log('采集已恢复。');
  return 0;
}

export type { ParsedArgs };
