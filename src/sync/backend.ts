// SyncBackend 抽象（规格 §5.2 契约；评估 4.9 接口税 #1）。
// 三条不可违背约束：
// 1. 只报告冲突，绝不自动合并——冲突另存 .conflict.md，本地版本保留
// 2. 后端不得假设 git 存在——检测不到时给可操作提示而不是抛栈
// 3. 三个后端对上层暴露完全相同的语义——新增后端只加实现类 + 注册表一行
import { BackendUnavailableError } from '../core/util.js';
import { GitBackend } from './git.js';
import type { SyncBackendId } from '../core/config.js';

export interface SyncReport {
  backend: string;
  pushed: boolean;
  conflicts: string[];
  notes: string[];
}

export interface SyncStatus {
  backend: string;
  available: boolean;
  remote: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  note?: string;
}

export interface SyncBackend {
  readonly id: SyncBackendId;
  init(): void;
  push(report: SyncReport): void;
  pull(report: SyncReport): void;
  status(): SyncStatus;
}

export interface BackendConfig {
  sync: { git: { remote: string }; auto_snapshot: boolean };
}

/** 后端注册表：V0.1 只交付 git；webdav/dir 为 V0.2（接口已预留，调用给可操作提示）。 */
export function getBackend(id: SyncBackendId, home: string, config: BackendConfig): SyncBackend {
  if (id === 'git') return new GitBackend(home, config);
  throw new BackendUnavailableError(
    `Sync backend ${id} is not yet delivered (V0.2: webdav first, dir alongside).`,
    'For V0.1, use the git backend: omem backup use git',
  );
}
