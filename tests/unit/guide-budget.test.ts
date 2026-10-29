// PROCESS.md 的预算护栏与计数口径（beta.9 / T04，beta.9.1 按 QA 实测校正）。
//
// 三条判据都是**可失败**的，且都不钉绝对值（绝对基线来自别的机器/别的吸收状态）：
//   ① 会话行不含绝对路径（断言作用在「会话行」上，不是全文件——`## X:\ai-dev` 是数据）；
//   ② 会话维度恒等式：`shown + hidden + unassigned == 窗口会话数`；
//   ③ 预算 45,000 B：判据是宿主 `Read` 的 `字符数÷4 > 20000`，不是拍的数。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_MAX_BYTES, renderGuide } from '../../src/process/guide.js';
import type { GuideSessionRef, GuideTopic } from '../../src/process/guide.js';

const uuid = (i: number): string =>
  `${(0x10000000 + i).toString(16).padStart(8, '0')}-1a2b-4c3d-8e9f-${String(i).padStart(12, '0')}`;

let seq = 0;
/** 造 refs；`folded` 指定前多少行代表 2 份副本（模拟 same-user-text 折叠）。 */
function refs(count: number, folded = 0): GuideSessionRef[] {
  return Array.from({ length: count }, (_, i) => ({
    // 路径故意给不存在的绝对路径：验证「渲染不写路径」而不是「读盘失败就跳过」
    path: `C:\\Users\\wei\\.omem\\sessions\\workbuddy\\${uuid(seq)}.md`,
    sessionId: uuid(seq++),
    agent: 'workbuddy',
    copies: i < folded ? 2 : 1,
  }));
}

function group(topic: string, sessions: GuideSessionRef[]): GuideTopic {
  return { topic, sessions, otherDocs: 0 };
}

const sessionLines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('  - `'));
const unassignedLines = (text: string): string[] => text.split('\n').filter((l) => /^- `[0-9a-f]{8}-/.test(l));
const markers = (text: string): number[] =>
  (text.match(/…(\d+) session\(s\)(?: \(\d+ line\(s\)\))? hidden by the size budget/g) ?? [])
    .map((m) => Number(/(\d+)/.exec(m)![1]));

describe('预算常量的依据（不是拍的数）', () => {
  it('45,000 B：宿主 Read 的 est = 字符÷4 ≤ 20,000 → 硬顶约 80,000 字符，本值留 44% 余量', () => {
    expect(GUIDE_MAX_BYTES).toBe(45_000);
    expect(GUIDE_MAX_BYTES / 4).toBeLessThan(20_000);
    // 真实仓同批会话（546 行 ≈ 31.6 KB）必须装得下，且不许贴到 80,000 的硬顶
    expect(GUIDE_MAX_BYTES).toBeGreaterThan(32_000);
    expect(GUIDE_MAX_BYTES).toBeLessThan(60_000);
  });
});

describe('真实形状：0 隐藏、行数不减', () => {
  it('548 refs（含 91 份折叠）+ 235 unassigned + 58 topic → 装得下，0 隐藏', () => {
    seq = 0;
    // 形状取自 QA 验收报告 §4.1：窗口 refs 548 / 会话 639 / 最大组 469 / unassigned 235
    const topics = [
      group('local:7578434e', refs(469, 60)),
      group('workbuddy:66a01cd3', refs(40, 20)),
      group('local:35651ad7', refs(20, 10)),
      group('catpaw:9f1c02aa', refs(12, 1)),
      group('qoder:77aa10bb', refs(7, 0)),
    ];
    const unassigned = refs(235);
    const existing = Array.from({ length: 58 }, (_, k) => ({
      name: `topic-${String(k).padStart(2, '0')}`,
      docId: `2026-10-28-${(k + 100).toString(16).padStart(6, '0')}`,
      confidence: 0.55,
      created: '2026-10-28T00:00:00.000Z',
    }));
    const windowSessions = [...topics.map((t) => t.sessions), unassigned]
      .flat()
      .reduce((n, r) => n + (r.copies ?? 1), 0);
    const degradations: unknown[] = [];
    const text = renderGuide(topics, 64, unassigned, existing, { sessions: windowSessions + 405, shownSessions: 0 }, {
      onDegrade: (info) => degradations.push(info),
    });

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(GUIDE_MAX_BYTES);
    // 会话行一行不丢（548 组内 + 235 unassigned），且没有降级
    expect(sessionLines(text)).toHaveLength(548);
    expect(unassignedLines(text)).toHaveLength(235);
    expect(degradations).toHaveLength(0);
    expect(text).not.toContain('hidden by the size budget');
    // topic 行数 == active 数，且 id 仍在
    expect((text.match(/^- `topic-/gm) ?? []).length).toBe(58);
    expect(text).toContain('`2026-10-28-00006d`');
  });
});

describe('会话行不得含绝对路径（断言作用在会话行上，不在全文件上）', () => {
  it('会话行里没有盘符', () => {
    seq = 0;
    const text = renderGuide([group('local:aaa', refs(10))], 0, []);
    expect(sessionLines(text)).toHaveLength(10);
    for (const line of sessionLines(text)) expect(line).not.toMatch(/[A-Za-z]:[\\/]/);
    // 裸 id 仍在（读取通道靠它）
    expect(sessionLines(text)[0]).toMatch(/^ {2}- `[0-9a-f]{8}-/);
  });

  it('project_fp 里的盘符是数据，必须原样保留（不能被当违规路径清掉）', () => {
    seq = 0;
    const text = renderGuide([group('X:\\ai-dev', refs(2))], 0, []);
    expect(text).toContain('## X:\\ai-dev');
  });
});

describe('预算触发时：标记按会话计，恒等式成立', () => {
  it('1,800 refs（含折叠）→ 装进 45,000，且 Σshown + Σhidden + unassigned == 窗口会话数', () => {
    seq = 0;
    const topics = [
      group('local:7578434e', refs(1420, 100)),
      group('workbuddy:66a01cd3', refs(200, 40)),
      group('local:35651ad7', refs(180, 0)),
    ];
    const unassigned = refs(60);
    const windowSessions = [...topics.map((t) => t.sessions), unassigned]
      .flat()
      .reduce((n, r) => n + (r.copies ?? 1), 0);
    const text = renderGuide(topics, 0, unassigned, [], { sessions: windowSessions, shownSessions: 0 });

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(GUIDE_MAX_BYTES);
    const hidden = markers(text).reduce((a, b) => a + b, 0);
    expect(hidden).toBeGreaterThan(0);
    // 头部报的 shown 是**真正渲染出来**的会话数（不是窗口内全部）
    const shown = Number(/This batch: \d+ group\(s\) \/ (\d+) session\(s\) shown/.exec(text)![1]);
    const unassignedRendered = unassignedLines(text).reduce((n, line) => {
      const id = /`([^`]+)`/.exec(line)![1];
      const ref = unassigned.find((r) => r.sessionId === id);
      return n + (ref?.copies ?? 1);
    }, 0);
    expect(shown + hidden + unassignedRendered).toBe(windowSessions);
    // 头部不许再把被隐藏的算成 shown
    expect(shown).toBeLessThan(windowSessions);
  });

  it('Unassigned sessions 也有自己的隐藏标记（不允许「235 条只列 5 条且不吭声」）', () => {
    seq = 0;
    const unassigned = refs(235);
    const text = renderGuide([], 0, unassigned, [], { sessions: 235, shownSessions: 0 }, { maxBytes: 6_000 });
    const unassignedSection = text.slice(text.indexOf('## Unassigned sessions'));
    expect(unassignedSection).toContain('hidden by the size budget');
    const rendered = unassignedLines(text).length;
    expect(rendered).toBeLessThan(235);
    expect(markers(unassignedSection).reduce((a, b) => a + b, 0)).toBe(235 - rendered);
  });

  it('每组各自标记，且标记的数字是会话数（折叠行会在括号里补行数）', () => {
    seq = 0;
    const big = refs(600, 300); // 600 行 = 900 会话
    const text = renderGuide([group('local:huge', big)], 0, [], [], { sessions: 900, shownSessions: 0 }, { maxBytes: 20_000 });
    const line = text.split('\n').find((l) => l.startsWith('  - …'))!;
    expect(line).toMatch(/…\d+ session\(s\) \(\d+ line\(s\)\) hidden by the size budget/);
    const hiddenSessions = Number(/…(\d+) session\(s\)/.exec(line)![1]);
    const hiddenLines = Number(/\((\d+) line\(s\)\)/.exec(line)![1]);
    expect(hiddenSessions).toBeGreaterThan(hiddenLines); // 折叠行代表的会话更多
  });
});

describe('消灭手写副本：规则句只从 instructions.ts 取', () => {
  it('guide.ts 源码里 RULE_EVIDENCE / RULE_VERIFIED 的字面串出现 0 次', () => {
    const src = readFileSync(join(process.cwd(), 'src/process/guide.ts'), 'utf8');
    expect(src).not.toContain('at least 12 consecutive characters copied from a');
    expect(src).not.toContain('comes only from `omem add` or `omem review --confirm`');
    expect(src).toContain('RULE_EVIDENCE');
    expect(src).toContain('RULE_VERIFIED');
  });

  it('渲染产物里仍然含这两条规则（去重不是删掉）', () => {
    seq = 0;
    const text = renderGuide([group('local:ccc', refs(1))], 0, []);
    expect(text).toContain('copied from a `## user` section');
    expect(text).toContain('comes only from `omem add` or `omem review --confirm`');
  });
});
