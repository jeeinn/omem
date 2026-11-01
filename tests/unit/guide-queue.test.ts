// PROCESS.md 主题队列：按项目归组、已吸收会话退出、无指纹的进 unassigned。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { sessionKey } from '../../src/collect/session-store.js';
import { pendingTopics } from '../../src/process/pipeline.js';
import { renderGuide } from '../../src/process/guide.js';
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

function put(id: string, project: string) {
  index.putSession({
    session_id: sessionKey('cursor', id),
    agent: 'cursor',
    path: `${home}/sessions/cursor/${id}.md`,
    content_hash: id,
    project_fp: project,
    msg_count: 1,
    last_ts: '2026-10-16T00:00:00.000Z',
    processed_at: '2026-10-16T00:00:00.000Z',
  }, `## user\n${id}`);
}

describe('pendingTopics', () => {
  it('groups sessions by project and splits unknown fingerprints', () => {
    put('a', 'proj-a');
    put('b', 'proj-a');
    put('c', 'proj-b');
    put('u', 'unknown');
    const [topics, remaining, unassigned] = pendingTopics(home, index);
    expect(remaining).toBe(0);
    expect(topics.map((t) => t.project).sort()).toEqual(['proj-a', 'proj-b']);
    expect(topics.find((t) => t.project === 'proj-a')!.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
    expect(unassigned.map((s) => s.sessionId)).toEqual(['u']);
  });

  it('drops sessions absorbed by a superseded document via source_sessions', () => {
    put('old-sess', 'proj-a');
    put('fresh', 'proj-a');
    const first = commitEntry(home, defaultConfig(), index, {
      content: 'proj-a 的第一版活文档记下旧会话',
      type: 'fact',
      topic: 'proj-a',
      session_id: 'old-sess',
      source: 'agent',
      confidence: 0.55,
    });
    commitEntry(home, defaultConfig(), index, {
      content: 'proj-a 的第二版活文档继承旧会话',
      type: 'fact',
      topic: 'proj-a',
      source: 'agent',
      confidence: 0.55,
      supersedes: [first.id!],
    });
    const [topics] = pendingTopics(home, index);
    const ids = topics.flatMap((t) => t.sessions.map((s) => s.sessionId));
    expect(ids).not.toContain('old-sess');
    expect(ids).toContain('fresh');
    expect(topics[0].docTopic).toBeTruthy();
  });

  it('resolves the current document through absorbed sessions when topic != project fingerprint', () => {
    // 真机形态：分组名是 project_fp（如 local:7578434e），活文档的 topic 是 Agent 起的语义名（如 knee-rehab）。
    // 二者不同命名空间，只能靠「同组里已被吸收的会话 → 它当年写出的文档」反查。
    put('old-sess', 'proj-c');
    put('fresh', 'proj-c');
    const doc = commitEntry(home, defaultConfig(), index, {
      content: 'proj-c 分组里第一份活文档，topic 名与分组名无关',
      type: 'fact',
      topic: 'a-topic-name-that-is-not-the-fingerprint',
      session_id: 'old-sess',
      source: 'agent',
      confidence: 0.55,
    });
    const [topics] = pendingTopics(home, index);
    const group = topics.find((t) => t.project === 'proj-c')!;
    expect(group.sessions.map((s) => s.sessionId)).toEqual(['fresh']);
    expect(group.docTopic).toBe(doc.topic);
    const text = renderGuide([group], 0, []);
    expect(text).toContain(doc.topic!);
    expect(text).not.toContain('Current document: none');
  });

  it('a group with several living documents reports the newest one and the remaining count', () => {
    put('s1', 'proj-d');
    put('s2', 'proj-d');
    put('pending', 'proj-d');
    const older = commitEntry(home, defaultConfig(), index, {
      content: 'proj-d 的第一份活文档',
      type: 'fact',
      topic: 'proj-d-one',
      session_id: 's1',
      source: 'agent',
      confidence: 0.55,
    });
    const newer = commitEntry(home, defaultConfig(), index, {
      content: 'proj-d 的第二份活文档，topic 不同',
      type: 'fact',
      topic: 'proj-d-two',
      session_id: 's2',
      source: 'agent',
      confidence: 0.55,
    });
    const [topics] = pendingTopics(home, index);
    const group = topics.find((t) => t.project === 'proj-d')!;
    expect([older.topic, newer.topic]).toContain(group.docTopic);
    expect((group.otherTopics ?? []).length).toBe(1);
    // 「还有 N 份」现在列的是 topic 名——只说数量等于死信息，调用方仍不知道改哪个。
    const guide = renderGuide([group], 0, []);
    expect(guide).toContain('other living documents in this project');
    const otherTopic = [older.topic, newer.topic].find((t) => t !== group.docTopic)!;
    expect(guide).toContain(otherTopic);
  });

  it('renderGuide tells the agent to pass supersedes', () => {
    const text = renderGuide([
      {
        project: 'proj-a',
        docTopic: 'topic-1',
        docTitle: '第一版',
        sessions: [{ path: '/tmp/a.md', sessionId: 'a', agent: 'cursor' }],
      },
      {
        project: 'proj-b',
        sessions: [{ path: '/tmp/b.md', sessionId: 'b', agent: 'cursor' }],
      },
    ], 0, [{ path: '/tmp/u.md', sessionId: 'u', agent: 'cursor' }]);
    expect(text).not.toContain('supersedes');
    expect(text).toContain('topic-1');
    expect(text).toContain('## Unassigned sessions');
    expect(text).toContain('The project name is not a topic');
  });
});
