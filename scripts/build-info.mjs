#!/usr/bin/env node
// 构建期把 short commit 落进 dist/core/build-info.json（beta.9 / T01）。
//
// 为什么在构建期而不是运行时取：npm 发布出去的是 dist/，tarball 里没有 .git，
// 运行时 `git rev-parse` 必然失败，那就只能给一个猜出来的值——比没有更糟。
// 为什么单独一个 json 而不写 .ts：version.ts 是 tsc 的输入，构建脚本不该改源码树。
// 非 git 环境（干净目录解包、CI 无 .git）不写文件：version.ts 会自动退化为纯版本号。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'core');

/** 取 `git rev-parse --short HEAD`；不是 git 仓库时返回 null（不抛）。 */
export function shortCommit(cwd = root) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** 工作区是否有未提交改动（发布物要能看出「这不是一个干净 build」）。 */
export function isDirty(cwd = root) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function main() {
  const commit = shortCommit();
  if (!commit) {
    console.log('[build-info] no git checkout; version stays plain');
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const info = { commit, dirty: isDirty() };
  writeFileSync(join(outDir, 'build-info.json'), `${JSON.stringify(info)}\n`, 'utf8');
  console.log(`[build-info] ${commit}${info.dirty ? ' (dirty)' : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
