// 两个独立索引视图（模拟两个 MCP 客户端进程）共享同一份磁盘事实源时的版本比对。
// 边界：只验证「持有旧 revision 的一方被拒绝」。这是 best-effort（D3），
// 不是跨进程锁，不承诺并发写入绝不丢失更新；真双进程路径由 smoke.sh S17 覆盖。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry, readCurrentRevision } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { findByTopic } from '../../src/core/store.js';
import { makeHome, cleanupHome } from './helpers.js';

const TOPIC = 'shared-topic';
let home: string;
let viewA: OmemIndex;
let viewB: OmemIndex;

beforeEach(() => {
  home = makeHome();
  viewA = new OmemIndex(home);
  viewB = new OmemIndex(home);
});
afterEach(() => {
  viewB.close();
  viewA.close();
  cleanupHome(home);
});

function write(view: OmemIndex, content: string, extra: Record<string, unknown> = {}) {
  return commitEntry(home, defaultConfig(), view, {
    content,
    type: 'fact' as const,
    topic: TOPIC,
    source: 'manual' as const,
    confidence: 0.9,
    overCap: 'reject' as const,
    ...extra,
  });
}

describe('two independent index views over one store', () => {
  it('a reader with a stale revision is refused and the other client\'s body survives', () => {
    write(viewA, '最初使用 PHP');
    viewB.catchUp();
    const staleRevision = readCurrentRevision(findByTopic(home, TOPIC)!.path);

    // 客户端 B 先覆盖；A 的索引视图仍是旧的，但事实源（磁盘）已经变了。
    expect(write(viewB, '客户端 B 改写为 Go').status).toBe('written');
    const afterB = readFileSync(findByTopic(home, TOPIC)!.path, 'utf8');

    const r = write(viewA, '客户端 A 改写为 Rust', { expected_revision: staleRevision });
    expect(r.status).toBe('stale-revision');
    expect(r.staleRevision).toMatchObject({ expected: staleRevision });
    expect(readFileSync(findByTopic(home, TOPIC)!.path, 'utf8')).toBe(afterB);
  });

  it('without a revision baseline the legacy overwrite path is untouched', () => {
    write(viewA, '最初使用 PHP');
    viewB.catchUp();
    expect(write(viewB, '客户端 B 改写为 Go').status).toBe('written');
    expect(write(viewA, '客户端 A 改写为 Rust').status).toBe('written');
    expect(findByTopic(home, TOPIC)!.entry.body).toBe('客户端 A 改写为 Rust');
  });

  it('index rows stay rebuildable from disk after a refused write', () => {
    write(viewA, '最初使用 PHP');
    const staleRevision = readCurrentRevision(findByTopic(home, TOPIC)!.path);
    write(viewB, '另一个客户端先改写');
    const refused = write(viewA, 'A 带着旧 revision 再写', { expected_revision: staleRevision });
    expect(refused.status).toBe('stale-revision');

    const rebuilt = new OmemIndex(home);
    try {
      const row = rebuilt.getByTopic(TOPIC);
      expect(row).not.toBeNull();
      expect(row?.body_hash).toBeTruthy();
      expect(rebuilt.rows().some((entry: any) => (entry.row ?? entry).topic === TOPIC)).toBe(true);
    } finally {
      rebuilt.close();
    }
  });
});
