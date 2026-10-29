// 真实仓聚合形状的本地代理测量（不读真实仓；形状取自 QA 验收报告 §4.1/§4.2 的聚合数字）。
// 用法：node scripts/measure-guide.mjs         # 真实形状（548 refs / 235 unassigned / 58 topics）
//      node scripts/measure-guide.mjs 1500 2000  # 增长场景（窗口内会话总量）
import { renderGuide, GUIDE_MAX_BYTES } from 'file:///X:/omem/dist/process/guide.js';

const uuid = (i) => `${(0x10000000 + i).toString(16).padStart(8, '0')}-1a2b-4c3d-8e9f-${String(i).padStart(12, '0')}`;
let seq = 0;
const mk = (n, extraCopies) => {
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ path: 'x', sessionId: uuid(seq++), agent: 'local', copies: k < extraCopies ? 2 : 1 });
  }
  return out;
};

const existing = Array.from({ length: 58 }, (_, k) => ({
  name: `topic-${String(k).padStart(2, '0')}`,
  docId: `2026-10-28-${(k + 100).toString(16).padStart(6, '0')}`,
  confidence: 0.55,
  created: '2026-10-28T00:00:00.000Z',
}));

const copies = (refs) => refs.reduce((n, r) => n + (r.copies ?? 1), 0);

/** 按 QA §4.1 的组形状构造窗口；extraRefs 追加进最大组，模拟数据增长。 */
function shape(extraRefs) {
  seq = 0;
  const topics = [
    { topic: 'local:7578434e', sessions: mk(469 + extraRefs, 60), otherDocs: 0 },
    { topic: 'workbuddy:66a01cd3', sessions: mk(40, 20), otherDocs: 0 },
    { topic: 'local:35651ad7', sessions: mk(20, 10), otherDocs: 0 },
    { topic: 'catpaw:9f1c02aa', sessions: mk(12, 1), otherDocs: 0 },
    { topic: 'qoder:77aa10bb', sessions: mk(7, 0), otherDocs: 0 },
  ];
  const unassignedRefs = Array.from({ length: 235 }, () => ({ path: 'x', sessionId: uuid(seq++), agent: 'local' }));
  return { topics, unassignedRefs };
}

function measure(extraRefs) {
  const { topics, unassignedRefs } = shape(extraRefs);
  const windowSessions = topics.reduce((n, t) => n + copies(t.sessions), 0) + copies(unassignedRefs);
  const totalSessions = windowSessions + 405;
  const text = renderGuide(topics, 64, unassignedRefs, existing, { sessions: totalSessions, shownSessions: 0 });
  const lines = text.split('\n');
  const sessionLines = lines.filter((l) => l.startsWith('  - `')).length;
  const unassignedLines = lines.filter((l) => /^- `[0-9a-f]{8}-/.test(l)).length;
  const hidden = (text.match(/…(\d+) session\(s\)(?: \(\d+ line\(s\)\))? hidden by the size budget/g) ?? [])
    .reduce((n, m) => n + Number(/(\d+)/.exec(m)[1]), 0);
  const headerAt = lines.findIndex((l) => l.startsWith('This batch'));
  const shownInHeader = Number(/\/ (\d+) session\(s\) shown/.exec(lines[headerAt] ?? '')?.[1] ?? 0);
  const unassignedSessions = copies(unassignedRefs) - (text.slice(text.indexOf('## Unassigned')).match(/…(\d+) session\(s\)(?: \(\d+ line\(s\)\))? hidden/g) ?? [])
    .reduce((n, m) => n + Number(/(\d+)/.exec(m)[1]), 0);
  return {
    extraRefs,
    bytes: Buffer.byteLength(text, 'utf8'),
    totalLines: lines.length,
    sessionLines,
    unassignedLines,
    hiddenSessions: hidden,
    shownPlusHidden: sessionLines + hidden,
    windowSessions,
    // 会话维度恒等式：头部 shown + 各处 hidden + unassigned（含其自身 hidden）== 窗口会话数
    identityHolds: shownInHeader + hidden + unassignedSessions === windowSessions,
    identity: `${shownInHeader} + ${hidden} + ${unassignedSessions} = ${shownInHeader + hidden + unassignedSessions} (window ${windowSessions})`,
    markers: (text.match(/hidden by the size budget/g) ?? []).length,
    header: lines[headerAt],
    driveInSessionLines: lines.filter((l) => l.startsWith('  - `') && /[A-Za-z]:[\\/]/.test(l)).length,
  };
}

const args = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const cases = args.length > 0 ? args.map((target) => Math.max(0, target - 548)) : [0];
console.log(JSON.stringify({ budget: GUIDE_MAX_BYTES, cases: cases.map(measure) }, null, 1));
