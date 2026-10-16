// omem redact：单条与按来源批量硬删。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { listEntries } from '../../src/core/store.js';
import { cmdRedact } from '../../src/commands/redact.js';
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

function write(content: string, source: 'rules' | 'manual') {
  return commitEntry(home, defaultConfig(), index, {
    content,
    type: 'fact',
    source,
    confidence: source === 'manual' ? 0.9 : 0.4,
    verified: source === 'manual',
  });
}

describe('redact --source', () => {
  it('deletes every rules fragment and leaves other sources', async () => {
    write('规则碎片一 手写 SQL 候选', 'rules');
    write('规则碎片二 另一条候选', 'rules');
    const kept = write('手工记下的结论保留下来', 'manual');
    const prev = process.env.OMEM_HOME;
    process.env.OMEM_HOME = home;
    try {
      const code = await cmdRedact({ _: [], flags: { source: 'rules' } });
      expect(code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prev;
    }
    const left = listEntries(home, { includeArchived: true });
    expect(left).toHaveLength(1);
    expect(left[0].entry.fm.id).toBe(kept.id);
    expect(index.getById(kept.id!)).not.toBeNull();
  });
});
