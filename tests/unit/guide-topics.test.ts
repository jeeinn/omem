// PROCESS.md 里的既有主题词表：让 Agent 复用已有 topic，而不是为同一主题再造一个名字。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { collectExistingTopics, renderGuide } from '../../src/process/guide.js';
import type { ExistingTopic, GuideTopic } from '../../src/process/guide.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;

function add(id: string, topic: string | undefined, fm: Partial<Frontmatter> = {}): void {
  writeEntry(home, {
    fm: newFrontmatter({ id, type: 'fact', domain: 'coding', topic, ...fm }),
    body: `正文 ${id}`,
  });
}

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe('collectExistingTopics', () => {
  it('只收 active 且有 topic 的文档，按 created 降序', () => {
    add('2026-10-01-a', 'older-topic', { created: '2026-10-01T00:00:00.000Z', confidence: 0.55 });
    add('2026-10-20-b', 'newer-topic', { created: '2026-10-20T00:00:00.000Z', confidence: 0.9 });
    add('2026-10-21-c', undefined); // 无 topic
    add('2026-10-22-d', 'gone-topic', { status: 'superseded' }); // 非 active

    const topics = collectExistingTopics(home);

    expect(topics.map((t) => t.name)).toEqual(['newer-topic', 'older-topic']);
    expect(topics[0]).toMatchObject({ name: 'newer-topic', confidence: 0.9 });
  });

  it('同一 topic 只出现一次（取首个即可）', () => {
    add('2026-10-01-a', 'dup-topic', { created: '2026-10-01T00:00:00.000Z' });
    // 正常情况下同 topic 只有一份 active；这里模拟脏数据，确保不重复列出
    add('2026-10-05-b', 'dup-topic', { created: '2026-10-05T00:00:00.000Z' });

    const topics = collectExistingTopics(home);

    expect(topics.filter((t) => t.name === 'dup-topic')).toHaveLength(1);
  });

  it('空库返回空数组', () => {
    expect(collectExistingTopics(home)).toEqual([]);
  });
});

describe('renderGuide: Existing topics 段', () => {
  const group: GuideTopic = {
    topic: 'fp-abc',
    docId: undefined,
    docTitle: undefined,
    otherDocs: 0,
    sessions: [{ path: '/tmp/s.md', sessionId: 's1', agent: 'claude-code' }],
  };

  const existing: ExistingTopic[] = [
    { name: 'pool-tuning', docId: '2026-10-20-pool', confidence: 0.9, created: '2026-10-20T00:00:00.000Z' },
    { name: 'deploy-pipeline', docId: '2026-10-19-depl', confidence: 0.55, created: '2026-10-19T00:00:00.000Z' },
  ];

  it('列出主题名与置信度，并说明「新名字会开第二份活文档」', () => {
    const text = renderGuide([group], 0, [], existing);

    expect(text).toContain('## Existing topics');
    expect(text).toContain('`pool-tuning`');
    // 只给名字不够：复用名字之后仍拿不到 supersedes 需要的 id。
    expect(text).toContain('`2026-10-20-pool`');
    expect(text).toContain('0.90 · 2026-10-20');
    expect(text).toContain('`deploy-pipeline`');
    expect(text).toContain('A new name starts a second living document');
  });

  it('词表排在待办之后（参考信息不挡在最前面）', () => {
    const text = renderGuide([group], 0, [], existing);

    expect(text.indexOf('## fp-abc')).toBeLessThan(text.indexOf('## Existing topics'));
  });

  it('队列为空时仍然输出词表（Agent 主动整理记忆的场景）', () => {
    const text = renderGuide([], 0, [], existing);

    expect(text).toContain('No topics are waiting.');
    expect(text).toContain('## Existing topics');
    expect(text).toContain('`pool-tuning`');
  });

  it('没有既有主题时不输出该段', () => {
    const text = renderGuide([group], 0, [], []);

    expect(text).not.toContain('## Existing topics');
  });

  it('超过 15 个时截断并提示 omem topic list', () => {
    const many: ExistingTopic[] = Array.from({ length: 20 }, (_, i) => ({
      name: `topic-${String(i).padStart(2, '0')}`,
      docId: `2026-10-doc${String(i).padStart(2, '0')}`,
      confidence: 0.55,
      created: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));

    const text = renderGuide([group], 0, [], many);

    // 截断提示里不能只给 CLI 命令：MCP 客户端执行不了它。
    expect(text).toContain('…5 more.');
    expect(text).toContain('omem topic list');
    expect(text).toContain('search_memory(topic=');
    expect((text.match(/^- `topic-/gm) ?? []).length).toBe(15);
  });
});
