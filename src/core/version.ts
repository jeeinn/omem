// 版本号的唯一来源：从包根的 package.json 读，供 CLI 与 MCP 的 serverInfo 共用。
// 为什么不写死：stdio server 是长驻进程，`npm i -g` 升版后旧进程仍活着。
// serverInfo.version 若恒为字面量，就无法回答「这个连接器跑的是哪个 build」。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** dist/core/version.js 的上一级是 dist，再上一级才是包根。 */
const here = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0-unknown';
  } catch {
    // 打包方式变化时宁可给一个可识别的占位符，也不要让 server 启动失败。
    return '0.0.0-unknown';
  }
}

export const OMEM_VERSION = readVersion();
