#!/usr/bin/env node
// omem 启动包装器。
// node:sqlite 在 Node 22 需要 --experimental-sqlite flag（规格 §10：V0.1 用 node:sqlite）。
// 本包装器在缺失该 flag 时以正确 flag 自 re-exec，保证 `omem <cmd>` 与 npm bin shim 直接可用。
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, '..', 'dist', 'cli.js');

if (!process.execArgv.includes('--experimental-sqlite')) {
  const res = spawnSync(process.execPath, ['--experimental-sqlite', main, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, OMEM_CLI_ENTRY: '1' },
  });
  if (res.error) {
    console.error(`omem: 启动失败: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

// 动态 import 必须走 file:// URL——Windows 绝对路径（X:\...）会被 ESM 当作 URL 协议解析而崩溃
process.env.OMEM_CLI_ENTRY = '1';
await import(pathToFileURL(main).href);
