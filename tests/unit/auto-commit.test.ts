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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { defaultConfig, loadConfig, saveConfig } from '../../src/core/config.js';
import type { OmemConfig } from '../../src/core/config.js';
import { autoCommit, commitEntry } from '../../src/core/commit.js';
import { beginWriteJournal, endWriteJournal } from '../../src/core/write-journal.js';
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
  // 与真实数据仓同一份 .gitignore：index/ snapshots/ logs/ PROCESS.md 都不入版本
  writeFileSync(join(home, '.gitignore'), 'index/\nsnapshots/\nlogs/\nPROCESS.md\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'chore: omem init']);
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
    expect(second.sc.vcs.sha).toMatch(/^[0-9a-f]{7,}$/);
    // 提交里必须含本次写入的文档（不是空提交）
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    expect(committedFiles.some((f) => f.startsWith('knowledge/'))).toBe(true);
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
    const r = commitEntry(home, defaultConfig(), index, { topic: 'test-topic',
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

describe('commit 的 pathspec 收窄（beta.9.1 / P1-1）', () => {
  it('只提交 knowledge/ 与 MEMORY-INDEX.md：sessions/ 的未跟踪文件不被卷进来', async () => {
    initRepo();
    mkdirSync(join(home, 'sessions', 'local'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'local', 'stray.md'), 'untracked transcript\n', 'utf8');

    const r = await save({ content: '窄 pathspec 不卷会话 pathspec-marker' });
    expect(r.sc.vcs).toMatchObject({ status: 'committed' });

    const committed = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    expect(committed.some((f) => f.startsWith('knowledge/'))).toBe(true);
    expect(committed.some((f) => f.startsWith('sessions/'))).toBe(false);
    // 会话文件仍是未跟踪状态（等 omem backup 统一入版本）
    // 未跟踪目录在 porcelain 里会被折叠成 `?? sessions/`
    expect(git(['status', '--porcelain', '--', 'sessions'])).toContain('?? sessions/');
  });
});

describe('P1-B 写入台账：写过的都提交、没写过的不碰', () => {
  /** 真实数据仓的历史遗留：PROCESS.md 先被 track，后来才加进 .gitignore。 */
  function initRepoWithTrackedGuide(): void {
    git(['init']);
    git(['config', 'user.name', 'omem-test']);
    git(['config', 'user.email', 'omem-test@localhost']);
    writeFileSync(join(home, '.gitignore'), 'index/\nsnapshots/\nlogs/\nPROCESS.md\n', 'utf8');
    writeFileSync(join(home, 'PROCESS.md'), 'stale guide\n', 'utf8');
    git(['add', '-A']);
    git(['add', '-f', 'PROCESS.md']);
    git(['commit', '-q', '-m', 'chore: omem init']);
  }

  it('PROCESS.md（已跟踪但被 ignore）+ 结论 + 热层索引全部提交，提交后工作区为空', () => {
    initRepoWithTrackedGuide();
    beginWriteJournal();
    const r = commitEntry(home, defaultConfig(), index, { topic: 'test-topic',
      content: '台账测试：写入的每个文件都要进提交 journal-marker-1',
      type: 'fact', topic: 'journal-topic', source: 'agent', confidence: 0.55, verified: false, overCap: 'reject',
    });
    const touched = endWriteJournal();
    // 台账必须覆盖：结论文件 + MEMORY-INDEX.md + PROCESS.md
    expect(touched.some((f) => f.includes('knowledge'))).toBe(true);
    expect(touched.some((f) => f.endsWith('MEMORY-INDEX.md'))).toBe(true);
    expect(touched.some((f) => f.endsWith('PROCESS.md'))).toBe(true);

    const vcs = autoCommit(home, defaultConfig(), 'omem: save test', touched);
    expect(vcs.status).toBe('committed');
    expect(vcs.residue).toEqual([]);
    expect(git(['status', '--porcelain'])).toBe('');

    // PROCESS.md 的内容确实进了这笔提交（已跟踪文件 → 照旧提交，不做 git rm --cached）
    const guideInCommit = git(['show', 'HEAD:PROCESS.md']);
    expect(guideInCommit).toContain('journal-topic');
    expect(r.status).toBe('written');
  });

  it('别人留下的脏文件不会被卷进这次提交，而是列进 residue', () => {
    initRepoWithTrackedGuide();
    writeFileSync(join(home, 'notes.txt'), "someone else's work\n", 'utf8');

    beginWriteJournal();
    commitEntry(home, defaultConfig(), index, { topic: 'test-topic',
      content: '台账测试：只提交自己写过的 journal-marker-2',
      type: 'fact', source: 'agent', confidence: 0.55, verified: false, overCap: 'reject',
    });
    const vcs = autoCommit(home, defaultConfig(), 'omem: save test 2', endWriteJournal());

    expect(vcs.status).toBe('committed');
    expect(vcs.residue).toContain('notes.txt');
    const committed = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    expect(committed).not.toContain('notes.txt');
  });
});
