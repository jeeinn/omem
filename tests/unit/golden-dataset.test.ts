// Golden 标注集在 vitest 里也跑一遍：npm test 必须覆盖同一份数据，
// 不能只靠一个「记得手动执行」的离线脚本（S5 / P2）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { moveToArchive, updateTopic } from '../../src/core/store.js';
import { searchEntriesPage } from '../../src/core/search.js';
import { makeHome, cleanupHome } from './helpers.js';

interface GoldenCase {
  query: string;
  status?: ('active' | 'stale' | 'archived')[];
  expected_topics: string[];
}

const DATA = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'eval', 'golden-search.json'), 'utf8'),
) as { documents: { topic: string; content: string; confidence?: number; status?: string }[]; cases: GoldenCase[] };

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  const config = defaultConfig();
  for (const doc of DATA.documents) {
    const r = commitEntry(home, config, index, {
      content: doc.content,
      type: 'fact',
      topic: doc.topic,
      source: 'agent',
      confidence: doc.confidence ?? 0.55,
      overCap: 'reject',
    });
    expect(r.status).toBe('written');
    if (doc.status === 'stale') {
      const loc = updateTopic(home, doc.topic, (fm) => { fm.status = 'stale'; });
      if (loc) index.upsert(loc.entry, loc.path, readFileSync(loc.path, 'utf8'));
    } else if (doc.status === 'archived') {
      const loc = moveToArchive(home, doc.topic);
      if (loc) index.upsert(loc.entry, loc.path, readFileSync(loc.path, 'utf8'));
    }
  }
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('golden dataset: query → expected_topics', () => {
  it('every annotated case matches the current deterministic ranking', () => {
    const failures: string[] = [];
    for (const c of DATA.cases) {
      const page = searchEntriesPage(index, {
        query: c.query,
        status: c.status,
        limit: 20,
        staleWeight: defaultConfig().process.stale_weight,
      });
      const got = page.rows.map((r) => r.topic).sort();
      const want = [...c.expected_topics].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        failures.push(`"${c.query}" status=${JSON.stringify(c.status ?? [])}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('the dataset itself has documents and non-trivial cases', () => {
    expect(DATA.documents.length).toBeGreaterThanOrEqual(5);
    expect(DATA.cases.length).toBeGreaterThanOrEqual(6);
    expect(DATA.cases.some((c) => c.expected_topics.length === 0)).toBe(true);
    expect(DATA.cases.some((c) => c.status)).toBe(true);
  });
});
