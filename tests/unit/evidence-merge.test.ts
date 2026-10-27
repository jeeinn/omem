// 证据链继承：活文档更新时旧 evidence 不能丢（丢了会导致置信度重算掉档），但也不能无限膨胀。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { findById } from '../../src/core/store.js';
import { mergeEvidence } from '../../src/core/entry.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('mergeEvidence', () => {
  it('本次的排在前面，旧版按原顺序补在后面', () => {
    expect(mergeEvidence(['新证据'], [['旧 A', '旧 B']])).toEqual(['新证据', '旧 A', '旧 B']);
  });

  it('同一段原文只留一份（本次优先保留）', () => {
    expect(mergeEvidence(['同一句'], [['同一句', '另一句']])).toEqual(['同一句', '另一句']);
  });

  it('条数上限 8，超出的旧证据先丢', () => {
    const fresh = Array.from({ length: 10 }, (_, i) => `新证据 ${i}`);

    const out = mergeEvidence(fresh, [['旧证据']]);

    expect(out).toHaveLength(8);
    expect(out).not.toContain('旧证据');
    expect(out[0]).toBe('新证据 0');
  });

  it('总字符上限 2000，超长的旧证据被拒', () => {
    const fresh = 'a'.repeat(1500);
    const tooLong = 'b'.repeat(600);

    expect(mergeEvidence([fresh], [[tooLong]])).toEqual([fresh]);
    expect(mergeEvidence([fresh], [['b'.repeat(400)]])).toEqual([fresh, 'b'.repeat(400)]);
  });

  it('空白与空串被忽略', () => {
    expect(mergeEvidence(['  ', '有内容'], [['', '   ']])).toEqual(['有内容']);
  });

  it('全空返回空数组', () => {
    expect(mergeEvidence([], [])).toEqual([]);
  });
});

describe('commitEntry: 活文档更新继承证据链', () => {
  function write(content: string, evidence: string[], supersedes?: string[]): string {
    const r = commitEntry(home, defaultConfig(), index, {
      content,
      type: 'fact',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      topic: supersedes ? 'pool-tuning' : content.includes('另一条') ? 'other-topic' : 'pool-tuning',
      evidence,
      supersedes,
    }, { refreshIndex: false, refreshGuide: false });
    expect(r.status).toBe('written');
    return r.id!;
  }

  it('新版文档带上旧版 evidence（新的在前）', () => {
    const v1 = write('第一版内容', ['第一版引用的原话']);
    const v2 = write('第二版内容', ['第二版引用的原话'], [v1]);

    const fm = findById(home, v2)!.entry.fm;

    expect(fm.evidence).toEqual(['第二版引用的原话', '第一版引用的原话']);
  });

  it('新版没有传 evidence 时，旧证据仍保留（此前会清零）', () => {
    const v1 = write('第一版内容', ['旧原话']);
    const v2 = write('第二版内容', [], [v1]);

    expect(findById(home, v2)!.entry.fm.evidence).toEqual(['旧原话']);
  });

  it('并合同一主题的多份旧文档时，各自治证据都被收上来', () => {
    const a = commitEntry(home, defaultConfig(), index, {
      content: '旧文档 A', type: 'fact', source: 'agent', confidence: 0.55, verified: false,
      topic: 'merge-a', evidence: ['A 的原话'],
    }, { refreshIndex: false, refreshGuide: false });
    const b = commitEntry(home, defaultConfig(), index, {
      content: '旧文档 B', type: 'fact', source: 'agent', confidence: 0.55, verified: false,
      topic: 'merge-b', evidence: ['B 的原话'],
    }, { refreshIndex: false, refreshGuide: false });

    const merged = write('合并后的内容', ['新原话'], [a.id!, b.id!]);

    expect(findById(home, merged)!.entry.fm.evidence).toEqual(['新原话', 'A 的原话', 'B 的原话']);
  });

  it('没有 supersedes 时不会凭空继承别人的证据', () => {
    write('第一版内容', ['别处的原话']);
    const independent = write('另一条的独立内容', []);

    expect(findById(home, independent)!.entry.fm.evidence).toEqual([]);
  });
});
