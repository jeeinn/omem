// 发布可追溯（beta.9 / T01）：版本串、打包内容、白名单三条判据的单测。
// 只钉纯函数——真跑 `npm pack` 的判据由 scripts/release-check.mjs 在发布前执行，
// 在没有精确 tag 的工作区里它必须失败，那是设计意图，不是测试环境问题。
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORBIDDEN_PATTERNS,
  distProblems,
  findForbiddenPath,
  md5File,
  normalizeTag,
  packageCountProblem,
  versionTagMismatch,
  whitelistProblems,
} from '../../scripts/release-rules.mjs';
import { composeVersion } from '../../src/core/version.js';

describe('version string carries the build commit', () => {
  it('appends +<short-commit>', () => {
    expect(composeVersion('0.1.0-beta.9', { commit: '1a2b3c4' })).toBe('0.1.0-beta.9+1a2b3c4');
  });

  it('marks a dirty build so the artifact can be recognised', () => {
    expect(composeVersion('0.1.0-beta.9', { commit: '1a2b3c4', dirty: true })).toBe('0.1.0-beta.9+1a2b3c4-dirty');
  });

  it('degrades to the plain version when no build info exists', () => {
    expect(composeVersion('0.1.0-beta.9')).toBe('0.1.0-beta.9');
    expect(composeVersion('0.1.0-beta.9', {})).toBe('0.1.0-beta.9');
    expect(composeVersion('0.1.0-beta.9', { commit: '  ' })).toBe('0.1.0-beta.9');
    // 不猜：读到 unknown 也不编一个 commit
    expect(composeVersion('0.1.0-beta.9', { commit: 'unknown' })).toBe('0.1.0-beta.9');
  });
});

describe('release-check: version must equal the exact tag', () => {
  it('strips the v prefix', () => {
    expect(normalizeTag('v0.1.0-beta.9')).toBe('0.1.0-beta.9');
    expect(normalizeTag(' 0.1.0-beta.9 ')).toBe('0.1.0-beta.9');
  });

  it('passes only on exact equality', () => {
    expect(versionTagMismatch('0.1.0-beta.9', 'v0.1.0-beta.9')).toBeNull();
    expect(versionTagMismatch('0.1.0-beta.8', 'v0.1.0-beta.9')).toContain('!= tag');
    // 没有精确 tag（HEAD 领先 tag）也必须是失败：那正是 QA N6 的场景
    expect(versionTagMismatch('0.1.0-beta.9', '')).toContain('no exact tag');
  });
});

describe('release-check: packing must not ship tests or docs', () => {
  it('accepts a clean file list', () => {
    expect(findForbiddenPath([
      'package.json', 'README.md', 'NOTICE', 'bin/omem.js',
      'dist/cli.js', 'dist/core/guide-budget.js', 'dist/core/build-info.json',
    ])).toBeNull();
  });

  it('rejects the residue QA actually found', () => {
    expect(findForbiddenPath(['dist/index.js', '.omem-test/home-1793196628/knowledge/x.md'])).toContain('.omem-test');
    expect(findForbiddenPath(['test/unit/commit.ts'])).toContain('test/');
    expect(findForbiddenPath(['dist/__tests__/x.test.js'])).toBeTruthy();
    expect(findForbiddenPath(['dist/core/commit.test.js'])).toContain('commit.test.js');
    expect(findForbiddenPath(['docs/releases.md'])).toContain('docs/');
    expect(findForbiddenPath(['src/cli.ts'])).toContain('src/');
  });

  it('every pattern has a reason to exist', () => {
    // 防止有人「顺手」放宽判据：模式数量与清单同长
    expect(FORBIDDEN_PATTERNS).toHaveLength(5);
  });
});

describe('release-check: whitelist and entry points', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as Record<string, any>;

  it('the real package.json keeps dist + bin and its entry points exist', () => {
    expect(whitelistProblems(pkg)).toEqual([]);
  });

  it('a whitelist without dist/bin is a failure, not a warning', () => {
    const broken = { ...pkg, files: ['README.md'], main: 'dist/cli.js', bin: { omem: 'bin/omem.js' } };
    const problems = whitelistProblems(broken);
    expect(problems.join()).toContain('missing "dist"');
    expect(problems.join()).toContain('missing "bin"');
  });

  it('a missing entry point is a failure (an empty tarball is a release accident)', () => {
    const broken = { ...pkg, main: 'dist/nope.js' };
    expect(whitelistProblems(broken).join()).toContain('entry point not found');
  });

  it('md5File hashes the tarball for registration in docs/releases.md', () => {
    const file = join(process.cwd(), 'package.json');
    expect(md5File(file)).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ── P1-A（beta.9.1）：dist 不许有孤儿产物，否则 md5 取决于构建历史 ──
describe('release-check: dist 孤儿产物', () => {
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'omem-dist-'));
    mkdirSync(join(root, 'src', 'commands'), { recursive: true });
    mkdirSync(join(root, 'dist', 'commands'), { recursive: true });
    writeFileSync(join(root, 'src', 'cli.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src', 'commands', 'add.ts'), 'export const b = 1;\n');
    writeFileSync(join(root, 'dist', 'cli.js'), 'export const a = 1;\n');
    writeFileSync(join(root, 'dist', 'commands', 'add.js'), 'export const b = 1;\n');
    mkdirSync(join(root, 'dist', 'core'), { recursive: true });
    writeFileSync(join(root, 'dist', 'core', 'build-info.json'), '{}');
    return root;
  }

  it('干净构建：dist 与 src 一一对应，无孤儿', () => {
    const root = fixture();
    try {
      const r = distProblems(root);
      expect(r.orphans).toEqual([]);
      expect(r.missing).toEqual([]);
      expect(r.actualCount).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('源码已删但 dist 残留（真实事故：dist/commands/pause.js）→ 判为孤儿', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'dist', 'commands', 'pause.js'), '// stale');
      const r = distProblems(root);
      expect(r.orphans).toEqual(['commands/pause.js']);
      expect(r.missing).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('少一个产物（构建不完整）也算失败', () => {
    const root = fixture();
    try {
      rmSync(join(root, 'dist', 'commands', 'add.js'));
      expect(distProblems(root).missing).toEqual(['commands/add.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('包内文件数必须等于 dist + 5 个固定条目', () => {
    const root = fixture();
    try {
      // dist 3 个文件 → 期望 8
      expect(packageCountProblem(8, root)).toBeNull();
      expect(packageCountProblem(9, root)).toContain('packed 9 file(s)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
