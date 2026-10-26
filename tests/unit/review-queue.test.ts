// omem review：短队列、按 id 打开、旧的高置信未确认不进默认队列。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { updateEntry } from '../../src/core/store.js';
import { makeHome, cleanupHome } from './helpers.js';
import { cmdReview } from '../../src/commands/review.js';

let home: string;
let index: OmemIndex;
let logs: string[];
const orig = console.log;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  process.env.OMEM_HOME = home;
});
afterEach(() => {
  console.log = orig;
  delete process.env.OMEM_HOME;
  index.close();
  cleanupHome(home);
});

function add(content: string, over: { confidence?: number; source?: 'llm' | 'agent' | 'manual'; topic?: string; tags?: string[] } = {}) {
  const r = commitEntry(home, defaultConfig(), index, {
    content,
    type: 'fact',
    source: over.source ?? 'agent',
    confidence: over.confidence ?? 0.55,
    verified: false,
    topic: over.topic,
    tags: over.tags,
  }, { refreshIndex: false });
  return r.id!;
}

describe('omem review queue', () => {
  it('shows the 10 newest and tells you how to open one', async () => {
    for (let i = 0; i < 12; i++) add(`recent conclusion number ${i} about pools`);
    const old = add('old high confidence note that should stay out of the inbox');
    updateEntry(home, old, (fm) => { fm.created = '2020-01-01T00:00:00.000Z'; });
    const low = add('old ungrounded note that stays in the inbox', { confidence: 0.35, tags: ['ungrounded'] });
    updateEntry(home, low, (fm) => { fm.created = '2020-01-01T00:00:00.000Z'; });

    const code = await cmdReview({ _: [], flags: {} });
    const text = logs.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('Pending 13 · showing 10 newest');
    expect(text).toContain('3 more.  omem review --all');
    expect(text).toContain('Open one:  omem review <id>');
    expect(text).not.toContain(old);
    expect(text).not.toContain('## ');
  });

  it('--all lists the whole inbox and omem review <id> prints the file', async () => {
    const id = add('the full body of this living document stays on disk');
    const code = await cmdReview({ _: [id], flags: {} });
    const text = logs.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('File:');
    expect(text).toContain('the full body of this living document stays on disk');
    expect(text).toContain(`omem review --confirm ${id}`);
    expect(text).toContain(`omem review --dismiss ${id}`);

    logs.length = 0;
    await cmdReview({ _: [], flags: { all: true } });
    expect(logs.join('\n')).toContain(id);
  });

  it('--source keeps other sources out of the page', async () => {
    add('from the agent path', { source: 'agent' });
    const llm = add('from the api path', { source: 'llm', topic: 'git-sync' });
    await cmdReview({ _: [], flags: { source: 'llm' } });
    const text = logs.join('\n');
    expect(text).toContain(llm);
    expect(text).not.toContain('from the agent path');
    expect(text).toContain('git-sync');
  });
});
