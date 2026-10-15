// 使用日志：JSONL（规划 5.4-5 调用率可观测；评估 4.5 omem audit 的数据源）。
// 只记录本地遥测，不进 git（数据仓 .gitignore 排除 logs/）。
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { files } from './paths.js';

export function appendLog(home: string, event: string, data: Record<string, unknown> = {}): void {
  const path = files.usageLog(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch {
    /* 日志失败不阻断主流程 */
  }
}

export function tailLog(home: string, n: number): string[] {
  const path = files.usageLog(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-n);
}
