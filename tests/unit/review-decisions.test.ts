// applyReviewDecisions：批量审阅决议（文档 docs/omem-review-ui设计方案.md §4.2）。
//
// 重点盯四件事：
// 1. 分级落章——未读的 confirm 必须降级为 assent，且被限制的是 verified 不是分数；
// 2. 不整批回滚——单条失败记 skipped，其余照常；
// 3. 顺序与不重复——outcomes 顺序与 decisions 一致，同批重复 id 只处理一次；
// 4. 热层只重建一次——批量入口存在的理由之一。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { findById, moveToArchive, writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { applyAssent, applyReviewDecisions, generateMemoryIndex } from '../../src/core/lifecycle.js';
import { files } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function add(id: string, body: string, fm: Partial<Frontmatter> = {}): void {
  const e = { fm: newFrontmatter({ id, type: 'fact', domain: 'coding', ...fm }), body };
  const { path, content } = writeEntry(home, e);
  index.upsert(e, path, content);
}

function fmOf(id: string): Frontmatter {
  const loc = findById(home, id, { includeArchived: true });
  if (!loc) throw new Error(`missing fixture ${id}`);
  return loc.entry.fm;
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('applyReviewDecisions: confirm 与分级落章', () => {
  it('read:true → verified, confidence 0.9, confirmations+1, last_confirmed 刷新', () => {
    add('2026-10-27-aaaaaa', '结论 A', { confidence: 0.55, last_confirmed: '2020-01-01T00:00:00.000Z' });

    const out = applyReviewDecisions(home, index, [{ id: '2026-10-27-aaaaaa', action: 'confirm', read: true }]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'ok', applied: 'confirm', requested: 'confirm' });
    const fm = fmOf('2026-10-27-aaaaaa');
    expect(fm.verified).toBe(true);
    expect(fm.confidence).toBe(0.9);
    expect(fm.confirmations).toBe(1);
    expect(Date.parse(fm.last_confirmed)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
    expect(fm.tags).not.toContain('assent');
  });

  it('read 缺失 → 降级为 assent：confidence 0.8、verified 仍 false、打 assent tag', () => {
    add('2026-10-27-bbbbbb', '结论 B', { confidence: 0.55 });

    const out = applyReviewDecisions(home, index, [{ id: '2026-10-27-bbbbbb', action: 'confirm' }]);

    expect(out[0]).toMatchObject({ status: 'ok', requested: 'confirm', applied: 'assent' });
    const fm = fmOf('2026-10-27-bbbbbb');
    expect(fm.verified).toBe(false);
    expect(fm.confidence).toBe(0.8);
    expect(fm.tags).toContain('assent');
  });

  it('read:false 同样降级（显式 false 不等于已读）', () => {
    add('2026-10-27-cccccc', '结论 C', { confidence: 0.55 });
    const out = applyReviewDecisions(home, index, [{ id: '2026-10-27-cccccc', action: 'confirm', read: false }]);
    expect(out[0].applied).toBe('assent');
    expect(fmOf('2026-10-27-cccccc').verified).toBe(false);
  });

  it('requireReadForVerified:false → 未读也置 verified（CLI 显式确认路径）', () => {
    add('2026-10-27-dddddd', '结论 D', { confidence: 0.55 });

    const out = applyReviewDecisions(
      home,
      index,
      [{ id: '2026-10-27-dddddd', action: 'confirm' }],
      { requireReadForVerified: false },
    );

    expect(out[0].applied).toBe('confirm');
    const fm = fmOf('2026-10-27-dddddd');
    expect(fm.verified).toBe(true);
    expect(fm.confidence).toBe(0.9);
  });

  it('assent 是 max 语义：原本 0.9 的未验证条目保持 0.9，不被压到 0.8', () => {
    add('2026-10-27-eeeeee', '结论 E', { confidence: 0.9 });

    applyReviewDecisions(home, index, [{ id: '2026-10-27-eeeeee', action: 'assent' }]);

    const fm = fmOf('2026-10-27-eeeeee');
    expect(fm.confidence).toBe(0.9);
    expect(fm.verified).toBe(false);
    expect(fm.tags).toContain('assent');
  });

  it('已 superseded 的条目 confirm → skipped，且不写 verified', () => {
    add('2026-10-27-ffffff', '旧版', { status: 'superseded', superseded_by: '2026-10-27-gggggg' });

    const out = applyReviewDecisions(home, index, [{ id: '2026-10-27-ffffff', action: 'confirm', read: true }]);

    expect(out[0]).toMatchObject({ status: 'skipped', applied: 'skipped' });
    expect(out[0].reason).toContain('superseded by 2026-10-27-gggggg');
    const fm = fmOf('2026-10-27-ffffff');
    expect(fm.verified).toBe(false);
    expect(fm.confidence).toBe(0.5);
  });

  it('已归档的条目 confirm → skipped', () => {
    add('2026-10-27-hhhhhh', '已归档');
    moveToArchive(home, '2026-10-27-hhhhhh');

    const out = applyReviewDecisions(home, index, [{ id: '2026-10-27-hhhhhh', action: 'confirm', read: true }]);

    expect(out[0].status).toBe('skipped');
    expect(out[0].reason).toContain('archived');
  });
});

describe('applyReviewDecisions: dismiss / stale', () => {
  it('dismiss → status=archived 且文件移入 archive/', () => {
    add('2026-10-27-iiiiii', '要归档的结论');
    const before = findById(home, '2026-10-27-iiiiii')!;

    const out = applyReviewDecisions(home, index, [{ id: '2026-10-27-iiiiii', action: 'dismiss' }]);

    expect(out[0]).toMatchObject({ status: 'ok', applied: 'dismiss' });
    const after = findById(home, '2026-10-27-iiiiii', { includeArchived: true })!;
    expect(after.entry.fm.status).toBe('archived');
    expect(after.location).toBe('archive');
    expect(after.path).not.toBe(before.path);
    expect(index.getById('2026-10-27-iiiiii')?.status).toBe('archived');
  });

  it('重复 dismiss（已归档）→ skipped', () => {
    add('2026-10-27-jjjjjj', '已归档的');
    moveToArchive(home, '2026-10-27-jjjjjj');

    const out = applyReviewDecisions(home, index, [{ id: '2026-10-27-jjjjjj', action: 'dismiss' }]);

    expect(out[0].status).toBe('skipped');
    expect(out[0].reason).toContain('already archived');
  });

  it('stale → status=stale，文件不动', () => {
    add('2026-10-27-kkkkkk', '要冷却的');
    const before = findById(home, '2026-10-27-kkkkkk')!;

    const out = applyReviewDecisions(home, index, [{ id: '2026-10-27-kkkkkk', action: 'stale' }]);

    expect(out[0]).toMatchObject({ status: 'ok', applied: 'stale' });
    const after = findById(home, '2026-10-27-kkkkkk')!;
    expect(after.entry.fm.status).toBe('stale');
    expect(after.path).toBe(before.path);
  });

  it('对 superseded 条目 stale → skipped（只有 active 能冷却）', () => {
    add('2026-10-27-llllll', '旧版', { status: 'superseded' });
    const out = applyReviewDecisions(home, index, [{ id: '2026-10-27-llllll', action: 'stale' }]);
    expect(out[0].status).toBe('skipped');
    expect(out[0].reason).toContain('status is superseded');
  });
});

describe('applyReviewDecisions: 批量语义', () => {
  it('不存在的 id → status=missing，不影响同批其他条目', () => {
    add('2026-10-27-mmmmmm', '存在的');

    const out = applyReviewDecisions(home, index, [
      { id: '2026-10-27-mmmmmm', action: 'confirm', read: true },
      { id: '2026-10-27-nope', action: 'confirm', read: true },
    ]);

    expect(out[0].status).toBe('ok');
    expect(out[1]).toMatchObject({ status: 'missing', applied: 'skipped' });
    expect(fmOf('2026-10-27-mmmmmm').verified).toBe(true);
  });

  it('混合动作：各走各的路径，顺序与 decisions 一致', () => {
    add('2026-10-27-p1', '确认项', { confidence: 0.55 });
    add('2026-10-27-p2', '归档项');
    add('2026-10-27-p3', '冷却项');
    add('2026-10-27-p4', '未读项', { confidence: 0.55 });

    const out = applyReviewDecisions(home, index, [
      { id: '2026-10-27-p1', action: 'confirm', read: true },
      { id: '2026-10-27-p2', action: 'dismiss' },
      { id: '2026-10-27-p3', action: 'stale' },
      { id: '2026-10-27-p4', action: 'confirm' },
    ]);

    expect(out.map((o) => o.id)).toEqual(['2026-10-27-p1', '2026-10-27-p2', '2026-10-27-p3', '2026-10-27-p4']);
    expect(out.map((o) => o.applied)).toEqual(['confirm', 'dismiss', 'stale', 'assent']);
    expect(out.every((o) => o.status === 'ok')).toBe(true);
  });

  it('同批重复 id 只处理一次，第二次记 duplicate', () => {
    add('2026-10-27-q1', '结论', { confidence: 0.55 });

    const out = applyReviewDecisions(home, index, [
      { id: '2026-10-27-q1', action: 'confirm', read: true },
      { id: '2026-10-27-q1', action: 'confirm', read: true },
    ]);

    expect(out[0].status).toBe('ok');
    expect(out[1].status).toBe('skipped');
    expect(out[1].reason).toContain('duplicate');
    // confirmations 只加一次，否则重复决策可以刷分
    expect(fmOf('2026-10-27-q1').confirmations).toBe(1);
  });

  it('空数组 → 返回空数组', () => {
    expect(applyReviewDecisions(home, index, [])).toEqual([]);
  });
});

describe('applyReviewDecisions: 热层重建', () => {
  it('refreshIndex 默认开启：确认后 verified 条目排在 MEMORY-INDEX 最前', () => {
    add('2026-10-27-r1', '甲结论');
    add('2026-10-27-r2', '乙结论');
    generateMemoryIndex(home, index);

    applyReviewDecisions(home, index, [{ id: '2026-10-27-r2', action: 'confirm', read: true }]);

    const text = readFileSync(files.memoryIndex(home), 'utf8');
    expect(text.indexOf('2026-10-27-r2')).toBeLessThan(text.indexOf('2026-10-27-r1'));
  });

  it('refreshIndex:false → MEMORY-INDEX 完全不动（写入成功但不刷派生视图）', () => {
    add('2026-10-27-s1', '结论', { confidence: 0.55 });
    generateMemoryIndex(home, index);
    const before = readFileSync(files.memoryIndex(home), 'utf8');

    applyReviewDecisions(home, index, [{ id: '2026-10-27-s1', action: 'confirm', read: true }], {
      refreshIndex: false,
    });

    expect(readFileSync(files.memoryIndex(home), 'utf8')).toBe(before);
    expect(fmOf('2026-10-27-s1').verified).toBe(true);
  });
});

describe('applyAssent: opts 契约', () => {
  it('touchLastConfirmed 默认 false：save_memory 的 confirm_ids 路径不刷新时间戳', () => {
    add('2026-10-27-t1', '结论', { confidence: 0.55, last_confirmed: '2020-01-01T00:00:00.000Z' });

    applyAssent(home, index, ['2026-10-27-t1']);

    expect(fmOf('2026-10-27-t1').last_confirmed).toBe('2020-01-01T00:00:00.000Z');
    expect(fmOf('2026-10-27-t1').confidence).toBe(0.8);
  });

  it('touchLastConfirmed:true 时刷新（--ui 的 assent 路径）', () => {
    add('2026-10-27-t2', '结论', { confidence: 0.55, last_confirmed: '2020-01-01T00:00:00.000Z' });

    applyAssent(home, index, ['2026-10-27-t2'], { touchLastConfirmed: true });

    expect(Date.parse(fmOf('2026-10-27-t2').last_confirmed)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
  });
});
