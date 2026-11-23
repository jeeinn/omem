// omem review：短队列、按 id 打开、旧的高置信未确认不进默认队列。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { updateTopic } from '../../src/core/store.js';
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

let seq = 0;

function add(content: string, over: { confidence?: number; source?: 'llm' | 'agent' | 'manual'; topic?: string; tags?: string[] } = {}) {
  const r = commitEntry(home, defaultConfig(), index, {
    content,
    type: 'fact',
    source: over.source ?? 'agent',
    confidence: over.confidence ?? 0.55,
    topic: over.topic ?? `auto-topic-${++seq}`,
    tags: over.tags,
  }, { refreshIndex: false });
  return r.topic!;
}

describe('omem review queue', () => {
  it('shows the 10 newest and tells you how to open one', async () => {
    for (let i = 0; i < 12; i++) add(`recent conclusion number ${i} about pools`);
    const old = add('old high confidence note that should stay out of the inbox');
    updateTopic(home, old, (fm) => { fm.created = '2020-01-01T00:00:00.000Z'; });
    const low = add('old ungrounded note that stays in the inbox', { confidence: 0.35, tags: ['ungrounded'] });
    updateTopic(home, low, (fm) => { fm.created = '2020-01-01T00:00:00.000Z'; });

    const code = await cmdReview({ _: [], flags: {} });
    const text = logs.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('Pending 13 · showing 10 newest');
    expect(text).toContain('3 more.  omem review --all');
    expect(text).toContain('Open one:  omem review <topic>');
    expect(text).not.toContain(old);
    expect(text).not.toContain('## ');
  });

  it('--all lists the whole inbox and omem review <topic> prints the file', async () => {
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

describe('omem review --pending', () => {
  it('lists evidence-less entries regardless of age, with a batch confirm hint', async () => {
    const fresh = add('fresh note with no evidence at all');
    const old = add('ancient note with no evidence at all');
    updateTopic(home, old, (fm) => { fm.created = '2020-01-01T00:00:00.000Z'; });

    // 默认队列按 14 天窗口收：2020 那条看不见。
    await cmdReview({ _: [], flags: {} });
    expect(logs.join('\n')).not.toContain(old);

    logs.length = 0;
    await cmdReview({ _: [], flags: { pending: true } });
    const text = logs.join('\n');
    expect(text).toContain(fresh);
    expect(text).toContain(old);
    expect(text).toContain('omem review --confirm');
    expect(text).toContain('0.9');
  });

  it('an entry that carries evidence is not a pending candidate', async () => {
    const withEvidence = add('note that does have a quoted evidence trail');
    updateTopic(home, withEvidence, (fm) => { fm.evidence = ['a quote long enough to count as evidence']; });
    const bare = add('note with nothing backing it');

    await cmdReview({ _: [], flags: { pending: true } });
    const text = logs.join('\n');
    expect(text).toContain(bare);
    expect(text).not.toContain(withEvidence);
  });

  it('reports an empty pending set explicitly instead of "Queue is empty"', async () => {
    await cmdReview({ _: [], flags: { pending: true } });
    expect(logs.join('\n')).toContain('No pending candidates.');
  });
});
