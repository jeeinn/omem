#!/usr/bin/env node
// omem 启动包装器。
// B 阶段去掉 SQLite 之后不再需要 --experimental-sqlite，也不再自 re-exec：
// 直接在当前进程里跑 CLI，少一次进程启动（Windows 上尤其明显）。
// 保留这个包装器是因为 npm bin shim 需要一个稳定入口，且 OMEM_CLI_ENTRY 约定在 CLI 侧。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, '..', 'dist', 'cli.js');

process.env.OMEM_CLI_ENTRY = '1';
try {
  await import(pathToFileURL(main).href);
} catch (err) {
  console.error(`omem: startup failed: ${err?.message ?? err}`);
  console.error('Hint: run `npm run build` first — the published package ships dist/.');
  process.exit(1);
}
