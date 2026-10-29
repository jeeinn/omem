// 写路径的自动提交（beta.9 / T05 / R3 / QA W14）。
//
// beta.8 的实测：13 次 MCP 写入 + 1 次 `omem add` 之后 `git log` 只有 `chore: omem init`，
// `git status` 里 10 个 knowledge 文件全是 `??` —— 也就是「记忆有版本历史」这件事根本没发生。
// 三条性质：
//   ① 一次工具调用落多个文件 → **1 个** commit（不是 N 个）；
//   ② 非 git 仓库静默跳过：写入照样成功、回执说明原因、**不进 stdout**；
//   ③ `auto_commit = "off"` 时完全不提交。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { defaultConfig, loadConfig, saveConfig } from '../../src/core/config.js';
import type { OmemConfig } from '../../src/core/config.js';
import { commitEntry } from '../../src/core/commit.js';
import { listEntries } from '../../src/core/store.js';
import { handleTool } from '../../src/mcp/tools.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: home, encoding: 'utf8' }).trim();
}

/** 建一个空的 git 数据仓（带仓库级身份，不碰全局 config）。 */
function initRepo(): void {
  git(['init']);
  git(['config', 'user.name', 'omem-test']);
  git(['config', 'user.email', 'omem-test@localhost']);
  git(['commit', '--allow-empty', '-m', 'chore: omem init']);
}

function commitCount(): number {
  return Number(git(['rev-list', '--count', 'HEAD']));
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  try { index.close(); } catch { /* 个别用例已关闭 */ }
  cleanupHome(home);
});

function ctx(config: OmemConfig = defaultConfig()) {
  return { home, config, index };
}

async function save(args: Record<string, any>, config: OmemConfig = defaultConfig()) {
  const r = await handleTool('save_memory', args, ctx(config));
  return { text: r.content.map((c) => c.text).join('\n'), sc: r.structuredContent as Record<string, any> };
}

describe('auto_commit = "session"（默认）', () => {
  it('一次 save_memory 落多个文件 → 恰好 1 个 commit', async () => {
    initRepo();
    const before = commitCount();

    // 先写一份活文档，再 supersede 它：一次调用会改「新文档 + 旧版 status + 清单」
    const first = await save({ content: '第一版：部署用国内镜像源', topic: 'deploy-mirror' });
    expect(first.sc.status).toBe('written');
    const second = await save({
      content: '第二版：部署用国内镜像源，并固定 registry',
      topic: 'deploy-mirror',
      supersedes: [first.sc.id],
    });
    expect(second.sc.status).toBe('written');

    // 两次工具调用 = 两次提交（不是每个文件一次）
    expect(commitCount() - before).toBe(2);
    expect(second.sc.vcs).toMatchObject({ status: 'committed' });
    expect(second.sc.vcs.files).toBeGreaterThanOrEqual(2);
    expect(second.text).toContain('Version control: committed');
    // 工作区干净：没有留下未提交的改动
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('deduped 不产生第二个 commit（没有新内容就没有新版本）', async () => {
    initRepo();
    const body = '同一句话只记一次 auto-commit-dedup-marker';
    await save({ content: body });
    const after = commitCount();
    const again = await save({ content: body });
    expect(again.sc.status).toBe('deduped');
    expect(commitCount()).toBe(after);
  });

  it('dry_run 不提交', async () => {
    initRepo();
    const before = commitCount();
    await save({ content: '预演不落盘 auto-commit-dryrun-marker', dry_run: true });
    expect(commitCount()).toBe(before);
  });

  it('auto_commit = "off" 时完全不提交（回退点）', async () => {
    initRepo();
    const config = defaultConfig();
    config.process.auto_commit = 'off';
    const before = commitCount();
    const r = await save({ content: '关闭自动提交仍要落盘 auto-commit-off-marker' }, config);
    expect(r.sc.status).toBe('written');
    expect(commitCount()).toBe(before);
    expect(r.sc.vcs).toEqual({ status: 'off' });
    expect(r.text).toContain('auto_commit is off');
  });
});

describe('非 git 仓库：静默跳过 + 回执给 warning', () => {
  it('写入成功、不报错、回执说明原因，且没有任何文件被提交', async () => {
    expect(existsSync(`${home}/.git`)).toBe(false);
    const r = await save({ content: '没有 git 也照样记住 no-git-marker' });
    expect(r.sc.status).toBe('written');
    expect(r.sc.vcs).toMatchObject({ status: 'skipped', reason: 'not a git repository' });
    // 给的是 MCP 可执行的下一步，不是 CLI 语法
    expect(r.text).toContain('Version control: nothing committed (not a git repository)');
    expect(r.text).toContain('ask the user to run omem backup');
    expect(listEntries(home)).toHaveLength(1);
  });

  it('CLI omem add 在非 git 仓也只说明、不失败', async () => {
    const r = commitEntry(home, defaultConfig(), index, {
      content: '非 git 仓的 CLI 写入 cli-no-git-marker',
      type: 'fact',
      source: 'manual',
      confidence: 0.9,
      verified: true,
      overCap: 'reject',
    });
    expect(r.status).toBe('written');
    // commitEntry 本身不提交（一次工具调用一个 commit 由调用方决定），
    // 但 autoCommit 在非 git 仓必须返回 skipped 而不是抛
    const { autoCommit } = await import('../../src/core/commit.js');
    expect(autoCommit(home, defaultConfig(), 'omem: add test')).toMatchObject({
      status: 'skipped',
      reason: 'not a git repository',
    });
  });
});

describe('配置往返', () => {
  it('[process] auto_commit 的默认值与关闭值都能落盘读回', () => {
    expect(defaultConfig().process.auto_commit).toBe('session');
    const config = defaultConfig();
    config.process.auto_commit = 'off';
    saveConfig(home, config);
    expect(loadConfig(home).process.auto_commit).toBe('off');
    // 拼错的值按默认（开）处理：历史缺失无法补救，多一笔提交可以 revert
    const broken = defaultConfig();
    (broken.process as any).auto_commit = 'sometimes';
    saveConfig(home, broken);
    expect(loadConfig(home).process.auto_commit).toBe('session');
  });
});
