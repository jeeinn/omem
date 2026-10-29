// 发布可追溯（beta.9 / T01）：版本串、打包内容、白名单三条判据的单测。
// 只钉纯函数——真跑 `npm pack` 的判据由 scripts/release-check.mjs 在发布前执行，
// 在没有精确 tag 的工作区里它必须失败，那是设计意图，不是测试环境问题。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FORBIDDEN_PATTERNS,
  findForbiddenPath,
  md5File,
  normalizeTag,
  versionTagMismatch,
  whitelistProblems,
} from '../../scripts/release-check.mjs';
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
