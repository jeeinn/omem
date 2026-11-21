// 能力标注集在 vitest 里也跑一遍：与 scripts/eval-search-capability.mjs 共用同一份 JSON，
// 防止「脚本绿、npm test 不知道」的口径漂移。历史值题在这里也真的建仓、真的读旧正文。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { autoCommit, commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { moveToArchive, readEntryFile, updateTopic } from '../../src/core/store.js';
import { searchEntriesPage } from '../../src/core/search.js';
import { makeHome, cleanupHome } from './helpers.js';

const DATA = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'eval', 'search-capability.json'), 'utf8'),
);

let home;
let index;
const config = defaultConfig();
const paths = new Map();

const git = (args) => execFileSync('git', args, { cwd: home, encoding: 'utf8' });

function write(doc) {
  const r = commitEntry(home, config, index, {
    content: doc.content,
    type: 'fact',
    topic: doc.topic,
    source: 'agent',
    confidence: doc.confidence ?? 0.55,
    overCap: 'reject',
  });
  expect(r.status).toBe('written');
  const vcs = autoCommit(home, config, `eval: ${doc.topic}`, [r.path]);
  expect(vcs.status).toBe('committed');
  return { path: r.path, rel: relative(home, r.path).replace(/\\/g, '/') };
}

beforeAll(() => {
  home = makeHome();
  index = new OmemIndex(home);
  git(['init', '-q']);
  git(['config', 'user.name', 'omem-eval']);
  git(['config', 'user.email', 'omem-eval@localhost']);
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
  for (const doc of DATA.overwrites) paths.set(doc.topic, write(doc));
});

afterAll(() => {
  index.close();
  cleanupHome(home);
});

function ranked(c) {
  return searchEntriesPage(index, {
    query: c.query,
    domain: c.domain,
    status: c.status,
    limit: 20,
    staleWeight: c.staleWeight ?? config.process.stale_weight,
  }).rows.map((r) => r.topic);
}

function search(c) {
  return [...ranked(c)].sort();
}

describe(`search capability dataset (${DATA.kind})`, () => {
  it('current-value: latest body wins and stale copies never displace active', () => {
    for (const c of DATA.cases.filter((c) => c.kind === 'current-value')) {
      const page = searchEntriesPage(index, {
        query: c.query, domain: c.domain, status: c.status,
        limit: 20, staleWeight: config.process.stale_weight,
      });
      expect(page.rows.map((r) => r.topic).sort()).toEqual([...c.expected_topics].sort());
      const body = readEntryFile(page.rows[0].path)?.body ?? '';
      if (c.expected_body_contains) expect(body).toContain(c.expected_body_contains);
      if (c.forbidden_body_contains) expect(body).not.toContain(c.forbidden_body_contains);
    }
  });

  it('historical: prior values are recoverable from git, product as_of is a known gap', () => {
    const historical = DATA.cases.filter((c) => c.kind === 'historical');
    expect(historical.length).toBeGreaterThan(0);
    for (const c of historical) {
      const loc = paths.get(c.topic);
      expect(loc).toBeDefined();
      const revs = git(['log', '--format=%H', '--', loc.rel]).trim().split('\n').filter(Boolean);
      expect(revs.length).toBeGreaterThanOrEqual(2);
      const prior = git(['show', `${revs[revs.length - 1]}:${loc.rel}`]);
      expect(prior).toContain(c.prior_body_contains);
      expect(readFileSync(loc.path, 'utf8')).toContain(c.current_body_contains);
      // 产品层缺口要显式钉住：标记一旦翻成 true 而代码没跟上，这条会红。
      expect(c.product_as_of_supported).toBe(false);
    }
  });

  it('multi-hop: each hop resolves alone, a joined query does not', () => {
    const hops = DATA.cases.filter((c) => c.kind === 'multi-hop');
    expect(hops.length).toBeGreaterThan(0);
    for (const c of hops) {
      for (const step of c.steps) {
        expect(search({ query: step.query })).toEqual([...step.expected_topics].sort());
      }
      expect(search({ query: c.single_query })).toEqual([...c.single_query_expected_topics].sort());
    }
  });

  it('abstain: zero hits for absent facts and wrong filters', () => {
    for (const c of DATA.cases.filter((c) => c.kind === 'abstain')) {
      expect(search(c)).toEqual([]);
    }
  });

  it('ranking ablations: stale downweight and confidence precedence', () => {
    for (const a of DATA.ablations) {
      for (const v of a.variants) {
        expect(ranked({ query: a.query, staleWeight: v.staleWeight })[0]).toBe(v.expected_first_topic);
      }
    }
  });

  it('dataset itself stays self-describing and non-trivial', () => {
    expect(DATA.kind).toBe('search-capability');
    expect(new Set(DATA.cases.map((c) => c.kind))).toEqual(
      new Set(['current-value', 'historical', 'multi-hop', 'abstain']),
    );
    expect(DATA.overwrites.length).toBeGreaterThanOrEqual(2);
  });
});
