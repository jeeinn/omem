// PROCESS.md 里的既有主题词表：让 Agent 复用已有 topic，而不是为同一主题再造一个名字。
//
// D1-B′ 之后 topic 就是文件名，词表只需要列名字与置信度——不再需要额外的 id 列，
// 因为「拿 id 去 supersedes」这条动线已经整个消失了。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeEntry } from '../../src/core/store.js';
import { newFrontmatter } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { collectExistingTopics, renderGuide } from '../../src/process/guide.js';
import type { ExistingTopic, GuideTopic } from '../../src/process/guide.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;

function add(topic: string, fm: Partial<Frontmatter> = {}): void {
  writeEntry(home, {
    fm: newFrontmatter({ topic, type: 'fact', domain: 'coding', ...fm }),
    body: `正文 ${topic}`,
  });
}

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe('collectExistingTopics', () => {
  it('只收 active 文档，按 created 降序', () => {
    add('older-topic', { created: '2026-10-01T00:00:00.000Z', confidence: 0.55 });
    add('newer-topic', { created: '2026-10-20T00:00:00.000Z', confidence: 0.9 });
    add('gone-topic', { status: 'archived' }); // 非 active

    const topics = collectExistingTopics(home);

    expect(topics.map((t) => t.name)).toEqual(['newer-topic', 'older-topic']);
    expect(topics[0]).toMatchObject({ name: 'newer-topic', confidence: 0.9 });
  });

  it('同一 topic 只出现一次（取首个即可）', () => {
    add('dup-topic', { created: '2026-10-01T00:00:00.000Z' });
    // 正常情况下同 topic 只有一份文件；这里模拟脏数据（外部重复落盘），确保不重复列出
    writeEntry(home, {
      fm: newFrontmatter({ topic: 'dup-topic', type: 'fact', domain: 'general', created: '2026-10-05T00:00:00.000Z' }),
      body: '另一份同名文件',
    });

    const topics = collectExistingTopics(home);

    expect(topics.filter((t) => t.name === 'dup-topic')).toHaveLength(1);
  });

  it('空库返回空数组', () => {
    expect(collectExistingTopics(home)).toEqual([]);
  });
});

describe('renderGuide: Existing topics 段', () => {
  const group: GuideTopic = {
    project: 'fp-abc',
    sessions: [{ path: '/tmp/s.md', sessionId: 's1', agent: 'claude-code' }],
  };

  const existing: ExistingTopic[] = [
    { name: 'pool-tuning', confidence: 0.9, created: '2026-10-20T00:00:00.000Z' },
    { name: 'deploy-pipeline', confidence: 0.55, created: '2026-10-19T00:00:00.000Z' },
  ];

  it('列出主题名与置信度，并说明「新名字会开第二份活文档」', () => {
    const text = renderGuide([group], 0, [], existing);

    expect(text).toContain('## Existing topics');
    expect(text).toContain('`pool-tuning`');
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

  it('topic 全量列出（不再 slice 15）', () => {
    const many: ExistingTopic[] = Array.from({ length: 20 }, (_, i) => ({
      name: `topic-${String(i).padStart(2, '0')}`,
      confidence: 0.55,
      created: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));

    const text = renderGuide([group], 0, [], many);

    // T04：全量列出。旧行为（只列 15 条 + `…5 more`）会让 Agent 看不到词表 → 新造 topic 名。
    expect(text).not.toContain('more. List them with');
    expect((text.match(/^- `topic-/gm) ?? []).length).toBe(20);
    expect(text).toContain('A new name starts a second living document');
  });
});
