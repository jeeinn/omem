// 四类检索能力评测：当前值 / 历史值 / 多跳 / 弃权 + 排序消融。
// 读 tests/eval/search-capability.json，零模型、零网络、不读真实 ~/.omem。
// 语料建在临时 OMEM_HOME；历史值题显式 git init + autoCommit 造版本链，
// 用 git show 读旧正文——这验证「数据层可恢复」，不代表产品层有 as_of 查询。
// 需要先 npm run build / npm run eval:capability（脚本从 dist/ 导入）。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome } from '../dist/core/paths.js';
import { defaultConfig, saveConfig } from '../dist/core/config.js';
import { OmemIndex } from '../dist/core/index.js';
import { autoCommit, commitEntry } from '../dist/core/commit.js';
import { moveToArchive, readEntryFile, updateTopic } from '../dist/core/store.js';
import { searchEntriesPage } from '../dist/core/search.js';
import { formatNoHits } from '../dist/core/search-format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = JSON.parse(readFileSync(join(ROOT, 'tests', 'eval', 'search-capability.json'), 'utf8'));
if (DATA.kind !== 'search-capability') throw new Error(`unexpected dataset kind: ${DATA.kind}`);

const home = mkdtempSync(join(tmpdir(), 'omem-capability-'));
const git = (args) => execFileSync('git', args, { cwd: home, encoding: 'utf8' });
const index = new OmemIndex(home);
const failures = [];
let gaps = 0;

function write(doc) {
  const r = commitEntry(home, CONFIG, index, {
    content: doc.content,
    type: 'fact',
    topic: doc.topic,
    source: 'agent',
    confidence: doc.confidence ?? 0.55,
    overCap: 'reject',
  });
  if (r.status !== 'written') throw new Error(`seed failed for ${doc.topic}: ${r.status}`);
  const rel = relative(home, r.path).replace(/\\/g, '/');
  const vcs = autoCommit(home, CONFIG, `eval: ${doc.topic}`, [r.path]);
  if (vcs.status !== 'committed') throw new Error(`seed commit failed for ${doc.topic}: ${vcs.status} ${vcs.reason ?? ''}`);
  return { path: r.path, rel };
}

function record(id, ok, detail) {
  if (!ok) failures.push(`${id}: ${detail}`);
  return ok;
}

function topTopics(page) {
  return page.rows.map((r) => r.topic);
}

function assertTopics(id, got, want, label) {
  const a = [...got].sort();
  const b = [...want].sort();
  return record(id, JSON.stringify(a) === JSON.stringify(b), `${label}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

let CONFIG;
try {
  ensureHome(home);
  CONFIG = defaultConfig();
  saveConfig(home, CONFIG);
  // commitEntry 自己不提交；历史值题必须显式建仓，否则 autoCommit 会静默跳过。
  git(['init', '-q']);
  git(['config', 'user.name', 'omem-eval']);
  git(['config', 'user.email', 'omem-eval@localhost']);

  const paths = new Map();
  for (const doc of DATA.documents) {
    const loc = write(doc);
    paths.set(doc.topic, loc);
    if (doc.status === 'stale') {
      const changed = updateTopic(home, doc.topic, (fm) => { fm.status = 'stale'; });
      if (changed) index.upsert(changed.entry, changed.path, readFileSync(changed.path, 'utf8'));
    } else if (doc.status === 'archived') {
      const changed = moveToArchive(home, doc.topic);
      if (changed) {
        index.upsert(changed.entry, changed.path, readFileSync(changed.path, 'utf8'));
        paths.set(doc.topic, { path: changed.path, rel: relative(home, changed.path).replace(/\\/g, '/') });
      }
    }
  }
  for (const doc of DATA.overwrites) {
    const loc = write(doc);
    paths.set(doc.topic, loc);
  }

  const totals = new Map();
  const bump = (kind, ok) => {
    const t = totals.get(kind) ?? { pass: 0, total: 0 };
    t.total++;
    if (ok) t.pass++;
    totals.set(kind, t);
  };

  for (const c of DATA.cases) {
    if (c.kind === 'current-value') {
      const page = searchEntriesPage(index, {
        query: c.query,
        domain: c.domain,
        status: c.status,
        limit: 20,
        staleWeight: CONFIG.process.stale_weight,
      });
      const okTopics = assertTopics(c.id, topTopics(page), c.expected_topics, 'topics');
      const body = page.rows.length > 0 ? (readEntryFile(page.rows[0].path)?.body ?? '') : '';
      const hasExpected = !c.expected_body_contains || body.includes(c.expected_body_contains);
      const hasForbidden = Boolean(c.forbidden_body_contains && body.includes(c.forbidden_body_contains));
      const ok = record(c.id, okTopics && hasExpected && !hasForbidden,
        `body check: expected=${c.expected_body_contains ?? '-'} forbidden=${c.forbidden_body_contains ?? '-'} body=${JSON.stringify(body.slice(0, 120))}`);
      bump(c.kind, ok);
      continue;
    }

    if (c.kind === 'historical') {
      const loc = paths.get(c.topic);
      if (!loc) { bump(c.kind, record(c.id, false, 'topic missing from seed')); continue; }
      const revs = git(['log', '--format=%H', '--', loc.rel]).trim().split('\n').filter(Boolean);
      if (revs.length < 2) { bump(c.kind, record(c.id, false, `need >=2 revisions for ${loc.rel}, got ${revs.length}`)); continue; }
      const prior = git(['show', `${revs[revs.length - 1]}:${loc.rel}`]);
      const current = readFileSync(loc.path, 'utf8');
      const ok = record(c.id,
        prior.includes(c.prior_body_contains) && current.includes(c.current_body_contains),
        `git history missing ${JSON.stringify(c.prior_body_contains)} or current missing ${JSON.stringify(c.current_body_contains)}`);
      bump(c.kind, ok);
      // 产品层缺口：当前 search_memory/searchEntriesPage 没有 as_of 参数，
      // 有历史数据不等于能按时间截面查。等 P1-1 落地后把数据文件标记改为 true，
      // 这里改为断言 as_of 检索命中旧值。
      if (!c.product_as_of_supported) {
        gaps++;
        console.log(`  KNOWN GAP ${c.id}: git can restore ${JSON.stringify(c.prior_body_contains)}, but product has no as_of query`);
      }
      continue;
    }

    if (c.kind === 'multi-hop') {
      let ok = true;
      for (const step of c.steps) {
        const page = searchEntriesPage(index, {
          query: step.query, limit: 20, staleWeight: CONFIG.process.stale_weight,
        });
        ok = assertTopics(`${c.id}/${step.query}`, topTopics(page), step.expected_topics, `step "${step.query}"`) && ok;
      }
      const joined = searchEntriesPage(index, {
        query: c.single_query, limit: 20, staleWeight: CONFIG.process.stale_weight,
      });
      ok = assertTopics(`${c.id}/joined`, topTopics(joined), c.single_query_expected_topics, 'single combined query') && ok;
      bump(c.kind, record(c.id, ok, 'one or more hops failed (see per-step lines)'));
      continue;
    }

    if (c.kind === 'abstain') {
      const page = searchEntriesPage(index, {
        query: c.query, domain: c.domain, status: c.status,
        limit: 20, staleWeight: CONFIG.process.stale_weight,
      });
      let ok = assertTopics(c.id, topTopics(page), c.expected_topics, 'topics');
      if (c.expect_no_hits_copy) {
        const copy = formatNoHits({ query: c.query, domain: c.domain, project: undefined }, { cli: true });
        ok = record(c.id, ok && copy.length > 0 && copy.join('\n').includes(c.query),
          `no-hits copy is empty or omits the query: ${JSON.stringify(copy)}`) && ok;
      }
      bump(c.kind, ok);
      continue;
    }

    bump(c.kind, record(c.id, false, `unknown kind ${c.kind}`));
  }

  let ablationPass = 0;
  let ablationTotal = 0;
  for (const a of DATA.ablations) {
    for (const v of a.variants) {
      ablationTotal++;
      const page = searchEntriesPage(index, {
        query: a.query, limit: 20, staleWeight: v.staleWeight,
      });
      const ok = record(`${a.id}/${v.name}`, topTopics(page)[0] === v.expected_first_topic,
        `first topic ${JSON.stringify(topTopics(page)[0])}, want ${JSON.stringify(v.expected_first_topic)}`);
      if (ok) ablationPass++;
    }
  }

  console.log('Search capability eval (offline, isolated home):');
  for (const [kind, t] of totals) {
    console.log(`  ${kind.padEnd(14)} ${t.pass}/${t.total}`);
  }
  console.log(`  ablations      ${ablationPass}/${ablationTotal}`);
  console.log(`  product as-of  ${gaps} known gap(s) (data layer recoverable, no query surface yet)`);
  if (failures.length === 0) {
    console.log('RESULT: PASS');
  } else {
    console.error(`RESULT: FAIL (${failures.length})`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`Search capability eval aborted: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  index.close();
  rmSync(home, { recursive: true, force: true });
}
