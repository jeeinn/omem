// 写入台账（beta.9.1 / P1-B）：记录「本次操作真正写过的文件」，供写入路径做精确提交。
//
// 为什么需要它：自动提交只能覆盖**本次真正改过的文件**。此前的做法是猜一组固定路径
// （`knowledge/` + `MEMORY-INDEX.md`），于是 `PROCESS.md`、`review.toml`、`config.toml`、
// 被改写 frontmatter 的 `sessions/**.md`、`archive/**.md` 永远提交不进去——QA 实测提交后
// 工作区仍有 23–25 项脏文件。退回 `git add -A` 又会把 1,089 份无关会话卷进每次写入（且慢）。
//
// 实现选点：`atomicWrite()` 是所有持久化写入的唯一落点（AGENTS.md「Persisted writes go
// through atomicWrite」），在它里面记一笔即可覆盖全部写入路径，不用逐个 writer 手工登记。
// 台账是进程内、可嵌套重置的：每次操作 begin 一次、end 一次取走清单。
import { resolve } from 'node:path';

let active: Set<string> | null = null;

/** 开始记录（会丢弃上一轮未取走的清单——那说明调用方忘了 end）。 */
export function beginWriteJournal(): void {
  active = new Set();
}

/** 记一笔；没有活跃台账时是空操作（例如 `omem init` 之类不关心提交的路径）。 */
export function recordWrite(path: string): void {
  if (active) active.add(resolve(path));
}

/** 取走本次写过的绝对路径清单并关闭台账。 */
export function endWriteJournal(): string[] {
  const out = active ? [...active] : [];
  active = null;
  return out;
}
