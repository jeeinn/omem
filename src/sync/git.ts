// GitBackend（规格 §5.3）：V0.1 唯一同步后端。
// 数据仓库根 = OMEM_HOME（~/.omem）；index/ snapshots/ logs/ 由 .gitignore 排除。
// 纪律：init 写仓库级 user.name/email（不污染全局）；未配 origin 时只本地提交并提示；
//       pull 前有未提交改动先固化为自动提交（本地版成为冲突 ours 侧）；
//       冲突只报告——另存 .conflict.md，本地版保留。
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BackendUnavailableError } from '../core/util.js';
import { runSnapshot } from '../core/snapshot.js';
import type { SyncReport, SyncStatus } from './backend.js';
import type { BackendConfig } from './backend.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitTry(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  try {
    return { ok: true, out: git(args, cwd), err: '' };
  } catch (e: any) {
    return { ok: false, out: '', err: String(e.stderr ?? e.message ?? e) };
  }
}

const DATA_GITIGNORE = `# omem data repo: only the source of truth is versioned
index/
snapshots/
logs/
PROCESS.md
*.tmp-*
*.conflict.md
`;

export class GitBackend {
  readonly id = 'git' as const;

  constructor(
    private readonly home: string,
    private readonly config: BackendConfig,
  ) {}

  static available(): boolean {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private ensureGit(): void {
    if (!GitBackend.available()) {
      throw new BackendUnavailableError(
        'git command not found.',
        'Please install git first; the non-developer path (WebDAV) ships in V0.2: omem sync use webdav',
      );
    }
  }

  /**
   * 远端地址以 git 仓库的 origin 为唯一事实源（status() 同样如此）。
   * 不读 config.sync.git.remote——setRemote() 只改仓库不改内存配置，
   * 同一进程内先 setRemote 再 push 会拿到空 remote（曾导致推送静默跳过）。
   */
  private remoteUrl(): string {
    const r = gitTry(['config', '--get', 'remote.origin.url'], this.home);
    return r.ok && r.out ? r.out : '';
  }

  private currentBranch(): string {
    const r = gitTry(['symbolic-ref', '--short', 'HEAD'], this.home);
    return r.ok && r.out ? r.out : 'master';
  }

  /**
   * 远端默认分支（clone 时对端 HEAD 指向的分支）：
   * 1) 协议层探测 `ls-remote --symref`（远端已有提交时）；
   * 2) 本地路径远端直接读 <path>/HEAD（git 本地传输同样这么做，空 bare 仓也能读到）；
   * 3) 探测不到 → null，调用方回退当前分支名。
   * 为什么需要：omem 数据仓默认分支随 git 版本漂移（master→main），远端 bare/GitHub
   * 空仓的默认分支可能与之不同。不一致时 push 仍成功，但 clone 侧 HEAD 指向未出生的
   * 分支 → 检出空树。对齐后推送直接落到远端默认分支上。
   */
  private remoteDefaultBranch(remote: string): string | null {
    const sym = gitTry(['ls-remote', '--symref', remote, 'HEAD'], this.home);
    if (sym.ok) {
      const m = sym.out.match(/^ref:\s*refs\/heads\/(\S+)\s+HEAD$/m);
      if (m) return m[1];
    }
    for (const base of [remote, resolve(this.home, remote)]) {
      try {
        const headFile = join(base, 'HEAD');
        if (existsSync(headFile)) {
          const m = readFileSync(headFile, 'utf8').match(/^ref:\s*refs\/heads\/(\S+)/);
          if (m) return m[1];
        }
      } catch {
        /* 非本地路径或不可读：跳过 */
      }
    }
    return null;
  }

  init(): void {
    this.ensureGit();
    const fresh = !existsSync(join(this.home, '.git'));
    if (fresh) {
      git(['init'], this.home);
      // 仓库级配置，不污染用户全局 git 配置（规格 §5.3）
      git(['config', 'user.name', 'omem'], this.home);
      git(['config', 'user.email', 'omem@localhost'], this.home);
      writeFileSync(join(this.home, '.gitignore'), DATA_GITIGNORE, 'utf8');
    }
    // 只有刚建仓时才落第一笔：omem sync 每次都会先 init()，若这里照旧 add+commit，
    // 会用 init 的提交信息抢在 push() 前面把改动提交掉，历史全是同名提交、版本差异也无从回溯。
    if (!fresh) return;
    git(['add', '-A'], this.home);
    gitTry(['commit', '-m', 'chore: omem init'], this.home); // 空仓库时无内容可提交，允许失败
  }

  push(report: SyncReport): void {
    this.ensureGit();
    if (this.config.sync.auto_snapshot) {
      const { path } = runSnapshot(this.home);
      report.notes.push(`Pre-sync snapshot: ${path}`);
    }
    git(['add', '-A'], this.home);
    const porcelain = gitTry(['status', '--porcelain'], this.home);
    if (porcelain.out) {
      const c = gitTry(['commit', '-m', `omem: sync ${new Date().toISOString()}`], this.home);
      if (!c.ok) report.notes.push(`Local commit failed: ${c.err}`);
    } else {
      report.notes.push('No local changes; nothing to commit');
    }
    const remote = this.remoteUrl();
    if (!remote) {
      report.notes.push('No remote configured (omem sync remote <url>); committed locally');
      return;
    }
    // 对齐远端默认分支，保证 clone 侧能检出（详见 remoteDefaultBranch 注释）
    const target = this.remoteDefaultBranch(remote) ?? this.currentBranch();
    const refspec = target === this.currentBranch() ? 'HEAD' : `HEAD:refs/heads/${target}`;
    // -u 让首次推送建立 upstream，避免 "no upstream branch" 失败
    const p = gitTry(['push', '-u', 'origin', refspec], this.home);
    if (p.ok) {
      report.pushed = true;
    } else {
      report.notes.push(`Push failed (${p.err.trim().split('\n')[0]}); committed locally, retry omem sync when online`);
    }
  }

  pull(report: SyncReport): void {
    this.ensureGit();
    const remote = this.remoteUrl();
    if (!remote) {
      report.notes.push('No remote configured; skipping pull (omem sync remote <url>)');
      return;
    }
    // 显式指定远端分支：不依赖 upstream 是否已建立（手动 init + add remote 的场景）
    const branch = this.remoteDefaultBranch(remote) ?? this.currentBranch();
    // 有未提交改动先固化为自动提交——它将成为冲突的 ours 侧（规格 §5.5：本地版保留）。
    // 为什么不能先 stash：stash 后工作区回到 base，合并因 ours=base 而干净通过，
    // 冲突被推迟到 pop 才爆，本地改动卡死在 stash 里，.conflict.md 也无从生成。
    const porcelain = gitTry(['status', '--porcelain'], this.home);
    if (porcelain.out) {
      git(['add', '-A'], this.home);
      const c = gitTry(['commit', '-m', 'omem: autosave before pull'], this.home);
      if (c.ok) report.notes.push('Uncommitted local changes fixed as an autosave commit (omem: autosave before pull)');
    }

    const pr = gitTry(['pull', '--no-rebase', '--no-edit', 'origin', branch], this.home);
    if (!pr.ok) {
      const conflicted = gitTry(['diff', '--name-only', '--diff-filter', 'U'], this.home).out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (conflicted.length > 0) {
        // 冲突是事件不是错误（规格 §5.5）：远端版另存 .conflict.md，本地版保留
        for (const f of conflicted) {
          const theirs = gitTry(['show', `:3:${f}`], this.home);
          if (theirs.ok) {
            mkdirSync(join(this.home, ...f.split('/').slice(0, -1)), { recursive: true });
            writeFileSync(join(this.home, `${f}.conflict.md`), theirs.out, 'utf8');
          }
          gitTry(['checkout', '--ours', f], this.home);
          git(['add', f], this.home);
          report.conflicts.push(f);
        }
        gitTry(['commit', '--no-edit'], this.home);
      } else if (/couldn't find remote ref/.test(pr.err)) {
        // 空远端（首次推送前的正常状态）不是失败：降级为说明性措辞，避免红字惊吓
        report.notes.push('Remote has no commits yet; nothing to pull. The first push will publish the branch.');
      } else {
        report.notes.push(`Pull failed: ${pr.err.trim().split('\n')[0]}`);
      }
    }
  }

  status(): SyncStatus {
    const base: SyncStatus = {
      backend: 'git',
      available: existsSync(join(this.home, '.git')),
      remote: null,
      ahead: 0,
      behind: 0,
      dirty: 0,
    };
    if (!base.available) {
      base.note = 'Data repo not initialized (omem sync will init automatically)';
      return base;
    }
    const r = gitTry(['config', '--get', 'remote.origin.url'], this.home);
    base.remote = r.ok && r.out ? r.out : null;
    const porcelain = gitTry(['status', '--porcelain'], this.home);
    base.dirty = porcelain.out ? porcelain.out.split('\n').filter(Boolean).length : 0;
    const up = gitTry(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], this.home);
    if (up.ok && /^\d+\t\d+$/.test(up.out)) {
      const [behind, ahead] = up.out.split('\t').map(Number);
      base.behind = behind;
      base.ahead = ahead;
    } else {
      base.note = 'No upstream branch (never pushed or no remote configured)';
    }
    return base;
  }

  setRemote(url: string): void {
    this.ensureGit();
    const r = gitTry(['remote', 'get-url', 'origin'], this.home);
    if (r.ok) git(['remote', 'set-url', 'origin', url], this.home);
    else git(['remote', 'add', 'origin', url], this.home);
  }
}
