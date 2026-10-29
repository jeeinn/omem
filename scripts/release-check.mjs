#!/usr/bin/env node
// 发布前的可断言门（beta.9 / T01，P0-4）。
//
// 为什么需要它：QA N6 的实证是「安装包 = HEAD 构建，版本号仍是 beta.8」——
// 于是所有「beta.8 实测」结论都可能是 HEAD 结论，回归基线不可信，bug 无法定位。
// 治理点不是加 .npmignore（files 白名单已存在且优先级更高），而是把「打包内容」
// 变成一条会失败的命令：
//   1. package.json.version 必须等于 HEAD 上的精确 tag（v 前缀会被剥除）；
//   2. `npm pack --dry-run --json` 的文件清单里不得出现测试残留 / docs / 源码；
//   3. files 白名单必含 dist、bin，且 main / bin 入口存在（空包也是发布事故）；
//   4. 打了 tarball 时打印 md5，供登记进 docs/releases.md（人工一步，但数字由命令给出）。
//
// 用法：
//   node scripts/release-check.mjs              # 完整检查（发布前）
//   node scripts/release-check.mjs --no-tag     # 只检查打包内容（本地演练 / 未打 tag 时）
//   node scripts/release-check.mjs --tarball x.tgz
//
// 断言逻辑抽成纯函数并导出：tests/unit/release-check.test.ts 直接钉这些判据，
// 而不是「跑一遍命令看它退不退出」——后者在没有 tag 的工作区永远红。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** tag → 版本号：`v0.1.0-beta.9` → `0.1.0-beta.9`。 */
export function normalizeTag(tag) {
  return String(tag ?? '').trim().replace(/^v/, '');
}

/**
 * 打包清单里不允许出现的路径特征。
 * 每一条都对应一次真实事故或一类可预见的泄漏：
 * - `test/`、`*.test.*`：QA 报告里带出去的就是这些（含 `.omem-test/home-*`）；
 * - `.omem-test`：冒烟测试把隔离 HOME 建在仓库根；
 * - `docs/`、`src/`：源码与内部文档没必要进包，且会把内部推理带出去。
 */
export const FORBIDDEN_PATTERNS = [
  /(^|\/)tests?\//i,
  /\.test\.[cm]?[jt]sx?$/i,
  /(^|\/)\.omem-test(\/|$)/i,
  /(^|\/)docs\//i,
  /(^|\/)src\//i,
];

/** 返回清单里第一处违禁路径；干净时返回 null。 */
export function findForbiddenPath(files) {
  for (const f of files ?? []) {
    const p = String(f).replace(/\\/g, '/');
    if (FORBIDDEN_PATTERNS.some((re) => re.test(p))) return p;
  }
  return null;
}

/** 版本与 tag 的一致性判据。返回 null 表示通过，否则返回人话原因。 */
export function versionTagMismatch(version, tag) {
  const wanted = normalizeTag(tag);
  if (!wanted) return 'no exact tag on HEAD (git describe --tags --exact-match is empty)';
  if (String(version ?? '').trim() !== wanted) return `package.json version "${version}" != tag "${tag}"`;
  return null;
}

/** `files` 白名单自检：dist / bin 必在，main 与 bin 入口文件必须真实存在。 */
export function whitelistProblems(pkg) {
  const problems = [];
  const files = Array.isArray(pkg?.files) ? pkg.files.map(String) : [];
  for (const required of ['dist', 'bin']) {
    if (!files.includes(required)) problems.push(`files whitelist is missing "${required}"`);
  }
  for (const entry of [pkg?.main, ...Object.values(pkg?.bin ?? {})]) {
    if (typeof entry !== 'string' || !entry) continue;
    if (!existsSync(join(ROOT, entry))) problems.push(`entry point not found: ${entry}`);
  }
  return problems;
}

export function md5File(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

function gitTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--exact-match'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * 找到能真正执行 `npm pack` 的启动方式。
 *
 * 为什么不能直接 execFileSync('npm')：Windows 上 PATH 里的 `npm` 是 **bash 脚本**
 * （node 发行版自带的那个），execFile 既不能执行 shebang 也不做 PATHEXT 解析，
 * 一律 ENOENT/EINVAL。而 `shell: true` 会把参数拼成一行，仓库路径带空格就错位。
 * 最稳的是「用当前 node 跑 npm-cli.js」，找不到再回退到平台命令名。
 */
function npmInvocation() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cli of candidates) {
    if (existsSync(cli)) return { cmd: process.execPath, prefix: [cli] };
  }
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
}

function packedFiles() {
  const { cmd, prefix } = npmInvocation();
  const out = execFileSync(cmd, [...prefix, 'pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return (entry?.files ?? []).map((f) => f.path ?? f.name ?? '').filter(Boolean);
}

function main(argv) {
  const noTag = argv.includes('--no-tag');
  const tarballArg = argv.find((a) => a.startsWith('--tarball='));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const failures = [];

  // 1. 版本 == tag
  if (!noTag) {
    const tag = gitTag();
    const problem = versionTagMismatch(pkg.version, tag);
    if (problem) failures.push(`version: ${problem}`);
    else console.log(`version: ${pkg.version} == tag ${tag}`);
  } else {
    console.log(`version: ${pkg.version} (tag check skipped by --no-tag)`);
  }

  // 2. 打包内容
  const files = packedFiles();
  const forbidden = findForbiddenPath(files);
  if (forbidden) failures.push(`packed file must not ship: ${forbidden}`);
  else console.log(`pack: ${files.length} file(s), no tests/docs/src residue`);

  // 3. 白名单与入口
  for (const problem of whitelistProblems(pkg)) failures.push(`packaging: ${problem}`);
  if (failures.length === 0) console.log('whitelist: dist + bin present, entry points exist');

  // 4. tarball md5（供 docs/releases.md 登记）
  if (tarballArg) {
    const path = resolve(ROOT, tarballArg.slice('--tarball='.length));
    if (!existsSync(path)) failures.push(`tarball not found: ${path}`);
    else console.log(`md5: ${md5File(path)}  ${path.split(/[\\/]/).pop()}  (register in docs/releases.md)`);
  }

  if (failures.length > 0) {
    console.error('\nrelease-check FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nrelease-check OK');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
