// 发布判据的纯函数（beta.9.1）：与 CLI 分开，便于单测直接 import。
//
// 为什么拆文件：`release-check.mjs` 带 shebang 且顶层执行 main()，把它 import 进测试
// 会让打包器的 ESM 解析路径分叉（本机 vitest 在 import 时直接报 SyntaxError）。判据与
// 执行分离后，测试 import 这个文件，CLI 只管取数、打印、给退出码。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/** 递归列出目录下的文件（相对路径，posix 分隔符）。 */
function walkFiles(root, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * `dist/` 的孤儿产物判据（beta.9.1 / P1-A）。
 *
 * `tsc` 只写不删：源码里删掉的文件会在 `dist/` 留下孤儿 js，而 `files: ["dist"]` 会把它
 * 一起打进包——于是同一个 commit 在不同构建历史下产出不同的 md5（QA 用干净 worktree 构建，
 * 三个 md5 三个样，多出来的就是 10 月 22 日的 `dist/commands/pause.js`）。
 * 判据：dist 的文件集合必须**恰好等于** src/**\/*.ts 一一映射到 dist/**\/*.js，外加
 * build-info.json。多一个 = 孤儿，少一个 = 构建不完整。
 */
export function distProblems(root = ROOT) {
  const srcDir = join(root, 'src');
  const distDir = join(root, 'dist');
  const expected = new Set(
    walkFiles(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.slice(0, -3) + '.js'),
  );
  // build-info.json 由 build 的第二步生成，不是 tsc 的产物
  expected.add('core/build-info.json');
  const actual = new Set(walkFiles(distDir));
  const orphans = [...actual].filter((f) => !expected.has(f));
  const missing = [...expected].filter((f) => !actual.has(f));
  return { orphans, missing, expectedCount: expected.size, actualCount: actual.size };
}

/**
 * 包内文件数判据：`files: ["dist","bin"]` + README + NOTICE + package.json 之外，
 * 不允许多出任何东西（同步类文件、测试夹具、`.omem-test` 都不行）。
 */
export function packageCountProblem(packed, root = ROOT) {
  const distCount = walkFiles(join(root, 'dist')).length;
  // 固定 5 个顶层条目：bin/omem.js、README.md、NOTICE、LICENSE（npm 自动带上）、package.json
  const FIXED = 5;
  const expected = distCount + FIXED;
  if (packed === expected) return null;
  return `packed ${packed} file(s) but dist(${distCount}) + ${FIXED} fixed entries = ${expected}`;
}

export function md5File(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}
