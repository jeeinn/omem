// PROCESS.md 的无损瘦身与预算护栏（beta.9 / T04 / P0-3）。
//
// 三条判据都是相对口径，不钉绝对值（QA §8.5：绝对基线来自 WAL 未回放的快照，钉不进去）：
//   ① 会话行不再带绝对路径（旧体积的 50.7% 是零信息冗余）；
//   ② 会话行数不减：显示行 + 每组 hidden 计数 == 输入会话数（截断也不许静默）；
//   ③ 渲染有 30,000 字节硬预算，超限按阶梯降级并在**每组**输出带数字的标记。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_MAX_BYTES, renderGuide } from '../../src/process/guide.js';
import type { GuideSessionRef, GuideTopic } from '../../src/process/guide.js';

function refs(count: number, prefix = 'sess'): GuideSessionRef[] {
  return Array.from({ length: count }, (_, i) => ({
    // 路径故意给不存在的绝对路径：既验证「渲染不读盘也能跑」，也验证它不会把路径写出来。
    path: `C:\\Users\\wei\\.omem\\sessions\\workbuddy\\${prefix}-${i}.md`,
    // id 用真实形状（36 字符 uuid）：短 id 会把体积算小，测不出预算
    sessionId: `${prefix}-${String(i).padStart(4, '0')}-4f2525a1-9c3b-4d7e-8a01-${String(i).padStart(12, '0')}`,
    agent: 'workbuddy',
  }));
}

function group(topic: string, sessions: GuideSessionRef[]): GuideTopic {
  return { topic, sessions, otherDocs: 0 };
}

/** 从渲染产物里读出「每组 hidden 会话数」的总和。 */
function hiddenTotal(text: string): number {
  const matches = text.match(/…(\d+) more in this group — hidden by the size budget/g) ?? [];
  return matches.reduce((n, m) => n + Number(/(\d+)/.exec(m)![1]), 0);
}

function sessionLineCount(text: string): number {
  return text.split('\n').filter((l) => /^ {2}- `/.test(l)).length;
}

describe('无损瘦身：会话行不再拼绝对路径', () => {
  it('10 个会话全量渲染，产物里没有任何盘符路径', () => {
    const sessions = refs(10);
    const text = renderGuide([group('local:aaa', sessions)], 0, []);
    expect(sessionLineCount(text)).toBe(10);
    // 判据与 QA 的 `grep -c 'C:\Users'` 一致
    expect(text).not.toMatch(/[A-Za-z]:\\\\Users/);
    expect(text).not.toContain('sessions\\workbuddy');
    // 但裸 id 必须在——读取通道靠它（agent 名不参与任何调用，去掉它才装得进 30KB）
    expect(text).toContain('  - `sess-0000-');
    expect(text).not.toContain('`workbuddy` /');
  });

  it('会话行数不减：显示行数 == 输入会话数（无预算压力时）', () => {
    const sessions = refs(37);
    const text = renderGuide([group('local:bbb', sessions)], 0, []);
    expect(sessionLineCount(text)).toBe(37);
  });
});

describe('预算护栏 GUIDE_MAX_BYTES', () => {
  it('单组 400 个会话（真实 id 长度）→ 输出 ≤ 30KB，一行不丢', () => {
    const sessions = refs(400, 'a');
    const degradations: { level: number; groupCap: number | null; bytes: number }[] = [];
    const text = renderGuide([group('local:big', sessions)], 0, [], [], undefined, {
      onDegrade: (info) => degradations.push(info),
    });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(GUIDE_MAX_BYTES);
    // 刚好装得下就一行不裁：预算不是借口去裁内容
    if (degradations.length === 0) expect(sessionLineCount(text)).toBe(400);
    // 装不下则必须逐组标记，且 Σ显示行 + Σhidden == 400（截断不许静默）
    else expect(sessionLineCount(text) + hiddenTotal(text)).toBe(400);
  });

  it('单组 1,200 个会话：靠降级装进 30KB，且每个被裁的组都带数字标记', () => {
    const sessions = refs(1200, 'b');
    const degradations: { level: number; groupCap: number | null; bytes: number }[] = [];
    const text = renderGuide([group('local:huge', sessions)], 0, [], [], undefined, {
      onDegrade: (info) => degradations.push(info),
    });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(GUIDE_MAX_BYTES);
    expect(text).toContain('hidden by the size budget');
    // 标记必须带数字（只说「…more」等于告诉 Agent 「有东西你看不到但拿不到」）
    expect(hiddenTotal(text)).toBeGreaterThan(0);
    expect(sessionLineCount(text) + hiddenTotal(text)).toBe(1200);
    // 降级被记下来，等级与组内上限都在（refreshProcessGuide 会写进 logs/omem.log）
    expect(degradations).toHaveLength(1);
    expect(degradations[0].level).toBe(2);
    expect(degradations[0].groupCap).toBeGreaterThan(0);
  });

  it('多组同时超限时每组各自标记，不是只在全局说一句', () => {
    const big1 = refs(700, 'c');
    const big2 = refs(700, 'd');
    const text = renderGuide([group('local:a', big1), group('local:b', big2)], 0, []);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(GUIDE_MAX_BYTES);
    const markers = text.match(/hidden by the size budget/g) ?? [];
    expect(markers.length).toBe(2);
    expect(sessionLineCount(text) + hiddenTotal(text)).toBe(1400);
  });

  it('未超预算时不降级、不出现 hidden 标记（预算不是借口去裁内容）', () => {
    const degradations: unknown[] = [];
    const text = renderGuide([group('local:small', refs(20))], 0, [], [], undefined, {
      onDegrade: (info) => degradations.push(info),
    });
    expect(text).not.toContain('hidden by the size budget');
    expect(degradations).toHaveLength(0);
  });
});

describe('消灭手写副本：规则句只从 instructions.ts 取', () => {
  it('guide.ts 源码里 RULE_EVIDENCE / RULE_VERIFIED 的字面串出现 0 次', () => {
    const src = readFileSync(join(process.cwd(), 'src/process/guide.ts'), 'utf8');
    // 字面串（不是标识符）：AGENTS.md:23 的原始缺陷就是这两句被手写了第二份
    expect(src).not.toContain('at least 12 consecutive characters copied from a');
    expect(src).not.toContain('comes only from `omem add` or `omem review --confirm`');
    // 但仍要 import 常量，否则渲染出来就少了这两条规则
    expect(src).toContain('RULE_EVIDENCE');
    expect(src).toContain('RULE_VERIFIED');
  });

  it('渲染产物里仍然含这两条规则（去重不是删掉）', () => {
    const text = renderGuide([group('local:ccc', refs(1))], 0, []);
    expect(text).toContain('copied from a `## user` section');
    expect(text).toContain('comes only from `omem add` or `omem review --confirm`');
  });
});

describe('真实 shape 的验收：572 行 + 58 topic 同时满足 ≤30KB 与行数不减', () => {
  const uuid = (i: number): string => `${(0x7578434e + i).toString(16).padStart(8, '0')}-1a2b-4c3d-8e9f-${String(i).padStart(12, '0')}`;

  function realRefs(count: number): GuideSessionRef[] {
    return Array.from({ length: count }, (_, i) => ({ path: 'x', sessionId: uuid(i), agent: 'local' }));
  }

  it('478 行巨组 + 94 行其余组 + 58 个 topic → 29KB 左右、0 隐藏、0 盘符路径', () => {
    const topics = [
      group('local:7578434e', realRefs(478)),
      group('workbuddy:66a01cd3', realRefs(40)),
      group('local:35651ad7', realRefs(30)),
      group('catpaw:9f1c02aa', realRefs(24)),
    ];
    const existing = Array.from({ length: 58 }, (_, i) => ({
      name: `topic-${String(i).padStart(2, '0')}`,
      docId: `2026-10-28-${(i + 100).toString(16).padStart(6, '0')}`,
      confidence: 0.55,
      created: '2026-10-28T00:00:00.000Z',
    }));
    const degradations: unknown[] = [];
    const text = renderGuide(topics, 60, [], existing, { sessions: 1101, shownSessions: 572 }, {
      onDegrade: (info) => degradations.push(info),
    });

    // ① 宿主 Read 的硬门槛（≤30,000 B）
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(GUIDE_MAX_BYTES);
    // ② 会话行数不减：572 行一行不少，也没有靠隐藏来换体积
    expect(sessionLineCount(text)).toBe(572);
    expect(text).not.toContain('hidden by the size budget');
    // 降级最多到「主题行紧凑」，id 必须还在（supersedes 要的就是它）
    if (degradations.length > 0) {
      expect(degradations).toHaveLength(1);
      expect((degradations[0] as { level: number }).level).toBe(1);
    }
    expect(text).toContain('`2026-10-28-00006d`');
    // ③ topic 行数 == active 数（58）
    expect((text.match(/^- `topic-/gm) ?? []).length).toBe(58);
    // ④ 没有盘符路径
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});
