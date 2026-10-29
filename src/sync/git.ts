// GitBackend（规格 §5.3）：V0.1 唯一同步后端。
// 数据仓库根 = OMEM_HOME（~/.omem）；index/ snapshots/ logs/ 由 .gitignore 排除。
// 纪律：init 写仓库级 user.name/email（不污染全局）；未配 origin 时只本地提交并提示；
//       pull 前有未提交改动先固化为自动提交（本地版成为冲突 ours 侧）；
//       冲突只报告——另存 .conflict.md，本地版保留。
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
    // 失败也要保留 stdout：`git add -v` 会以非零退出（点名的路径被 .gitignore 忽略），
    // 但它已经打印了真正收进索引的那些 —— 丢掉 stdout 就分不清「什么都没加」与「加了但报了警告」。
    return { ok: false, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? e.message ?? e) };
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

  /**
   * 进程内缓存：`git --version` 每次要 40–80 ms 的进程启动，而写入路径每次都要问一次。
   * 版本不会在同一个进程生命周期里变化，缓存是安全的。
   */
  private static gitAvailable: boolean | undefined;

  static available(): boolean {
    if (GitBackend.gitAvailable !== undefined) return GitBackend.gitAvailable;
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      GitBackend.gitAvailable = true;
    } catch {
      GitBackend.gitAvailable = false;
    }
    return GitBackend.gitAvailable;
  }

  private ensureGit(): void {
    if (!GitBackend.available()) {
      throw new BackendUnavailableError(
        'git command not found.',
        'Please install git first; the non-developer path (WebDAV) ships in V0.2: omem backup use webdav',
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
    // 只有刚建仓时才落第一笔：omem backup 每次都会先 init()，若这里照旧 add+commit，
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
      report.notes.push('No remote configured (omem backup remote <url>); committed locally');
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
      report.notes.push(`Push failed (${p.err.trim().split('\n')[0]}); committed locally, retry omem backup when online`);
    }
  }

  pull(report: SyncReport): void {
    this.ensureGit();
    const remote = this.remoteUrl();
    if (!remote) {
      report.notes.push('No remote configured; skipping pull (omem backup remote <url>)');
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

    let pr = gitTry(['pull', '--no-rebase', '--no-edit', 'origin', branch], this.home);
    // 多机场景：本地独立 init 再设 remote，两边历史没有共同祖先 → 首次 pull 报 unrelated histories。
    // 自动重试：将 flag 加在 pull 上。这不会覆盖用户的冲突策略（冲突仍走下面的 .conflict.md 分支）。
    if (!pr.ok && /refusing to merge unrelated histories/.test(pr.err)) {
      report.notes.push('Local and remote have no common ancestor; retrying pull with --allow-unrelated-histories.');
      pr = gitTry(['pull', '--no-rebase', '--no-edit', '--allow-unrelated-histories', 'origin', branch], this.home);
    }
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
      base.note = 'Data repo not initialized (omem backup will init automatically)';
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

/**
 * 自动提交覆盖的路径（beta.9.1 / P1-1）。
 *
 * `git add -A` 在真实仓（1,101 份会话 / 22 MB sessions/）上要逐文件重算 hash：QA 实测稳态
 * +456 ms、冷启 +4.1 s。而一次 `save_memory` 真正改动的只有结论、热层清单与 PROCESS.md——
 * 会话原文由 `omem sync` 采集、由 `omem backup` 统一入版本。把 pathspec 收窄到这三处，
 * 写入延迟的增量就只与「本次改了几个结论文件」有关。
 */
/**
 * 只本地提交，不碰远端、不建快照（beta.9 / T05 / R3；beta.9.1 改为按「本次写过的文件」提交）。
 *
 * 为什么不 back 到 `git add -A`：真实仓 1,101 份会话 / 22 MB，全仓扫描要逐文件重算 hash
 * （QA 实测稳态 +456 ms、冷启 +4.1 s），而且会把无关改动一起卷进「这次写入」的提交里。
 * 也**不猜**固定路径白名单：`PROCESS.md`、`review.toml`、`config.toml`、被改写 frontmatter 的
 * `sessions/**.md`、`archive/**.md` 都属于「这次真的写过」，白名单一猜就漏（QA 实测提交后
 * 工作区还脏 23–25 项）。所以由写入台账（`core/write-journal.ts`）给出精确清单。
 *
 * 非 git 仓库 / 未配置身份 / 没有改动 一律返回结构化原因，**不抛**：记忆已经落盘了，
 * 提交失败不该让一次成功的写入变成失败（清单与正文都还在）。
 */
export interface LocalCommitResult {
  committed: boolean;
  sha?: string;
  /** committed=false 的原因（人话，直接进回执）。 */
  reason?: string;
  /** 提交后工作区里仍然脏的路径（不是本次写过的，或写不进去的）。空数组 = 干净。 */
  residue?: string[];
}

/** 把绝对路径转成仓库相对路径（posix 分隔符）；不在 home 内的丢弃。 */
function repoRelative(home: string, paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const rel = relative(home, p).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    out.push(rel);
  }
  return [...new Set(out)];
}

/** `git status --porcelain` 的残留路径（提交后自检用）。 */
function pendingPaths(home: string): string[] {
  const r = gitTry(['status', '--porcelain'], home);
  if (!r.ok) return [];
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''))
    .map((line) => (line.includes(' -> ') ? line.split(' -> ').pop() as string : line));
}

export function commitLocal(home: string, message: string, paths: string[]): LocalCommitResult {
  if (!existsSync(join(home, '.git'))) {
    return { committed: false, reason: 'not a git repository' };
  }
  if (!GitBackend.available()) {
    return { committed: false, reason: 'git command not found' };
  }
  const rel = repoRelative(home, paths);
  if (rel.length === 0) return { committed: false, reason: 'nothing to commit' };

  // `--ignore-errors`：台账里可能包含 .gitignore 覆盖且未跟踪的路径（如 `index/`），
  // 显式点名被忽略的路径会让 `git add` 整体失败；这里让它跳过而不是炸掉整次提交。
  // `--verbose` 的输出还解决了另一个坑：`git commit -- <pathspec>` 遇到「点名的路径 git
  // 根本不认识」（被忽略且未跟踪的 PROCESS.md）会整笔失败 —— 只提交 add 真正收进去的那些。
  const added = gitTry(['add', '--ignore-errors', '-A', '--verbose', '--', ...rel], home);
  const staged = added.out
    .split('\n')
    .map((line) => /^(?:add|remove) '(.*)'$/.exec(line.trim())?.[1])
    .filter((v): v is string => Boolean(v));
  if (staged.length === 0) {
    // 「点名的路径被 .gitignore 忽略」会让 add 以 1 退出但确实是良性结果（`--ignore-errors`
    // 只是把它降级成提示）；只有真失败才把原因带回去。没有 staged 就是没有新内容可提交。
    const benign = added.ok || /ignored by one of your \.gitignore|did not match any files/i.test(added.err);
    return {
      committed: false,
      reason: benign ? 'nothing to commit' : `git add failed (${added.err.split('\n')[0]})`,
      residue: pendingPaths(home),
    };
  }
  // 只提交 add 真正收进去的路径：被忽略且未跟踪的文件（例如尚未 track 的 PROCESS.md）
  // 一旦出现在 `git commit -- <pathspec>` 里，整笔提交会失败。
  const commitPaths = staged;
  // `-q` 只影响输出量；`--` pathspec 保证不把用户自己暂存的其它改动带进这笔提交。
  const c = gitTry(['commit', '-q', '-m', message, '--', ...commitPaths], home);
  const residue = pendingPaths(home);
  if (!c.ok) {
    const why = c.err.trim().split('\n')[0];
    if (/nothing to commit|no changes added|nothing added to commit/i.test(c.err)) {
      return { committed: false, reason: 'nothing to commit', residue };
    }
    return { committed: false, reason: `git commit failed (${why})`, residue };
  }
  const sha = gitTry(['rev-parse', '--short', 'HEAD'], home);
  return { committed: true, sha: sha.ok ? sha.out : undefined, residue };
}
