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
  console.log('Collection paused: omem run and future watchers will no longer process sessions (explicit writes like MCP save_memory are unaffected).');
  console.log('Resume: omem resume');
  return 0;
}

export async function cmdResume(): Promise<number> {
  const { home, config } = openCtx();
  config.general.paused = false;
  saveConfig(home, config);
  appendLog(home, 'resume', {});
  console.log('Collection resumed.');
  return 0;
}

export type { ParsedArgs };
