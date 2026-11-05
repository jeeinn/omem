// 离线检索评估：跑 tests/eval/golden-search.json 的 query → expected_topics 标注集。
// 零模型调用、零网络、零真实 ~/.omem 读取；语料建在临时 OMEM_HOME 里，跑完即回收。
// 需要先 npm run build（脚本从 dist/ 导入），由 npm run eval:search 单独调用。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome } from '../dist/core/paths.js';
import { defaultConfig, saveConfig } from '../dist/core/config.js';
import { OmemIndex } from '../dist/core/index.js';
import { commitEntry } from '../dist/core/commit.js';
import { moveToArchive, updateTopic } from '../dist/core/store.js';
import { searchEntriesPage } from '../dist/core/search.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'tests', 'eval', 'golden-search.json'), 'utf8'));
const home = mkdtempSync(join(tmpdir(), 'omem-eval-'));
let index;
let exitCode = 0;

try {
  ensureHome(home);
  const config = defaultConfig();
  saveConfig(home, config);
  index = new OmemIndex(home);

  for (const doc of data.documents) {
    const result = commitEntry(home, config, index, {
      content: doc.content,
      type: doc.type ?? 'fact',
      topic: doc.topic,
      source: 'agent',
      confidence: doc.confidence ?? 0.55,
      overCap: 'reject',
    });
    if (result.status !== 'written') throw new Error(`seed failed for ${doc.topic}: ${result.status}`);
    if (doc.status === 'stale') {
      const loc = updateTopic(home, doc.topic, (fm) => { fm.status = 'stale'; });
      if (loc) index.upsert(loc.entry, loc.path, readFileSync(loc.path, 'utf8'));
    } else if (doc.status === 'archived') {
      const loc = moveToArchive(home, doc.topic);
      if (loc) index.upsert(loc.entry, loc.path, readFileSync(loc.path, 'utf8'));
    }
  }

  let passed = 0;
  for (const c of data.cases) {
    const page = searchEntriesPage(index, {
      query: c.query,
      status: c.status,
      limit: 20,
      staleWeight: config.process.stale_weight,
    });
    const got = page.rows.map((r) => r.topic).sort();
    const want = [...c.expected_topics].sort();
    if (JSON.stringify(got) === JSON.stringify(want)) {
      passed++;
    } else {
      exitCode = 1;
      console.error(`FAIL "${c.query}" status=${JSON.stringify(c.status ?? [])}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }
  console.log(`Golden search: ${passed}/${data.cases.length} cases passed (offline, isolated home)`);
} catch (err) {
  exitCode = 1;
  console.error(`Golden search aborted: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (index) index.close();
  rmSync(home, { recursive: true, force: true });
}

process.exitCode = exitCode;
