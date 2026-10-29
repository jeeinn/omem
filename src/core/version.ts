// 版本号的唯一来源：从包根的 package.json 读，供 CLI 与 MCP 的 serverInfo 共用。
// 为什么不写死：stdio server 是长驻进程，`npm i -g` 升版后旧进程仍活着。
// serverInfo.version 若恒为字面量，就无法回答「这个连接器跑的是哪个 build」。
//
// 可追溯性（beta.9 / T01）：版本串后面追加 `+<short-commit>`，由构建期脚本
// `scripts/build-info.mjs` 写进 `dist/core/build-info.json`。为什么不在运行时跑 git：
// 发布出去的 tarball 里没有 .git，`git rev-parse` 必然失败；构建期取一次最诚实。
// 读不到 build-info.json（源码运行、vitest、非 git 环境）时退化为纯版本号，
// 不做任何猜测——猜出来的 commit 比没有 commit 更糟。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** dist/core/version.js 的上一级是 dist，再上一级才是包根。 */
const here = dirname(fileURLToPath(import.meta.url));

/** 构建期落盘的 commit 摘要；缺省或无法解析时为 undefined。 */
interface BuildInfo {
  commit?: string;
  dirty?: boolean;
}

function readBuildInfo(): BuildInfo | undefined {
  try {
    const raw = readFileSync(join(here, 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw) as BuildInfo;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readBaseVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0-unknown';
  } catch {
    // 打包方式变化时宁可给一个可识别的占位符，也不要让 server 启动失败。
    return '0.0.0-unknown';
  }
}

/**
 * 版本串组装：`<version>+<short-commit>`，脏工作区再加 `-dirty`。
 *
 * 单独抽成纯函数是为了让单测能钉住格式——真实构建产物不在测试可及范围内
 * （vitest 跑的是 src/，没有 dist/core/build-info.json）。
 */
export function composeVersion(base: string, info?: BuildInfo): string {
  const commit = (info?.commit ?? '').trim();
  if (!commit || commit === 'unknown') return base;
  return `${base}+${commit}${info?.dirty ? '-dirty' : ''}`;
}

export const OMEM_VERSION = composeVersion(readBaseVersion(), readBuildInfo());
