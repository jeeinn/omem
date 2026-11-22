// T1 引文覆盖率门禁：读 tests/eval/quote-coverage.json 的固定 fixture，
// 在隔离 OMEM_HOME 里重建会话与活文档，调产品纯函数 verifyQuoteCoverage 并逐字段比对。
// 零模型、零网络、绝不读真实 ~/.omem。失败时 process.exit(2)（policy rejection）。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome, dirs } from '../dist/core/paths.js';
import { defaultConfig, saveConfig } from '../dist/core/config.js';
import { OmemIndex } from '../dist/core/index.js';
import { serializeEntry, newFrontmatter } from '../dist/core/entry.js';
import { verifyQuoteCoverage } from '../dist/process/score.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = JSON.parse(readFileSync(join(ROOT, 'tests', 'eval', 'quote-coverage.json'), 'utf8'));
if (DATA.kind !== 'quote-coverage') throw new Error(`unexpected fixture kind: ${DATA.kind}`);

const home = mkdtempSync(join(tmpdir(), 'omem-quotes-'));
let index;
let exitCode = 0;

try {
  ensureHome(home);
  saveConfig(home, defaultConfig());

  for (const s of DATA.sessions) {
    const dir = join(dirs.sessions(home), s.agent);
    mkdirSync(dir, { recursive: true });
    const text = [
      '---',
      `agent: ${s.agent}`,
      `session_id: ${s.id}`,
      'project: eval',
      'started: 2026-11-22T00:00:00.000Z',
      'ended: 2026-11-22T00:00:00.000Z',
      'messages: 1',
      `content_hash: eval-${s.id}`,
      '---', '',
      s.body,
    ].join('\n');
    writeFileSync(join(dir, `${s.id}.md`), text, 'utf8');
  }

  for (const e of DATA.entries) {
    const fm = newFrontmatter({ topic: e.topic, type: 'fact', domain: 'general' });
    fm.source = 'agent';
    fm.status = 'active';
    fm.confirmations = 0;
    fm.session_id = e.session_id ?? '';
    fm.source_sessions = e.source_sessions ?? [];
    // 关键：evidence_current 在场（含空数组）即走 current 层，不用历史链回补。
    fm.evidence_current = e.evidence_current;
    fm.evidence = [];
    const text = serializeEntry({ fm, body: e.body });
    const dir = join(dirs.knowledge(home), fm.domain);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${e.topic}.md`), text, 'utf8');
  }

  index = new OmemIndex(home);
  const got = verifyQuoteCoverage(home, index);
  const want = DATA.expected;
  const checks = [
    ['checked', got.checked, want.checked],
    ['quotes', got.quotes, want.quotes],
    ['matched', got.matched, want.matched],
    ['noQuote', got.noQuote, want.noQuote],
    ['misses', got.misses.length, want.misses],
    ['ratio', got.ratio === null ? null : Number(got.ratio.toFixed(6)), Number(want.ratio.toFixed(6))],
  ];
  const failures = checks.filter(([, a, b]) => a !== b).map(([k, a, b]) => `${k}: got ${a}, want ${b}`);
  for (const m of got.misses) {
    if (!m.reason.startsWith('not-in-')) failures.push(`unexpected miss reason: ${m.reason} (${m.topic})`);
  }

  console.log('Quote coverage fixture (offline, isolated home):');
  console.log(`  checked ${got.checked} · quotes ${got.quotes} · matched ${got.matched} · ratio ${got.ratio === null ? 'null' : got.ratio.toFixed(4)}`);
  console.log(`  noQuote ${got.noQuote} (listed separately) · misses ${got.misses.length} · skipped ${got.skipped}`);
  if (failures.length === 0) {
    console.log('RESULT: PASS (fixture reproduces the expected failures deterministically)');
  } else {
    console.error(`RESULT: FAIL (${failures.length})`);
    for (const f of failures) console.error(`  ${f}`);
    exitCode = 2;
  }
} catch (err) {
  console.error(`Quote coverage eval aborted: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 2;
} finally {
  if (index) index.close();
  rmSync(home, { recursive: true, force: true });
}

process.exitCode = exitCode;
