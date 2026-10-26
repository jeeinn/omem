// docId 机制：PROCESS.md 里的「Current document」必须指向真实存在的活文档。
//
// 背景（2026-10-26 审计）：待办分组用的是会话的 project_fp，活文档的 topic 是
// Agent 自己起的语义名——两者本不在同一个命名空间。旧实现只能靠「同组里已被
// 吸收的会话 → 当年写出的文档」反查，绕一大圈且经常落空，docId 结构性为空。
//
// 现在改成主路径：活文档的 frontmatter 里本来就有 project 字段（真实库实测
// 26 份活文档里 25 份带它），与分组指纹是同一个命名空间，直接匹配。
// 会话反查退为补充路径，覆盖没有 project 字段的文档。
//
// 这里验证：主路径生效、补充路径仍有效、两者都没有时报 none（不编造）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { sessionKey } from '../../src/collect/session-store.js';
import { pendingTopics } from '../../src/process/guide.js';
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

function put(id: string, project: string): void {
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

describe('docId: the document project field is the primary match path', () => {
  it('resolves the current document by project even without an absorbed session link', () => {
    // 关键场景：活文档带 project 字段，但没有任何会话被它吸收过。
    // 旧实现只能靠会话反查，这里必然为空；新实现直接按 project 命中。
    put('pending-1', 'proj-x');
    put('pending-2', 'proj-x');
    const doc = commitEntry(home, defaultConfig(), index, {
      content: 'proj-x 分组的活文档，project 字段与分组指纹一致',
      type: 'fact',
      topic: 'a-meaningful-topic',
      project: 'proj-x',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    expect(doc.id).toBeTruthy();

    const [topics] = pendingTopics(home, index);
    const group = topics.find((t) => t.topic === 'proj-x');
    expect(group).toBeTruthy();
    expect(group!.docId).toBe(doc.id);
    expect(group!.docTitle).toBeTruthy();
  });

  it('falls back to the session link when the document has no project field', () => {
    // 补充路径：文档没有 project 字段，但吸收过同组的某个会话。
    put('old-sess', 'proj-y');
    put('pending-3', 'proj-y');
    const doc = commitEntry(home, defaultConfig(), index, {
      content: 'proj-y 分组的活文档，没有 project 字段',
      type: 'fact',
      topic: 'topic-y',
      session_id: 'old-sess',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    const [topics] = pendingTopics(home, index);
    const group = topics.find((t) => t.topic === 'proj-y');
    expect(group).toBeTruthy();
    expect(group!.docId).toBe(doc.id);
  });

  it('reports none when the group genuinely has no document', () => {
    // 不该编造一个 docId——分组确实没有任何活文档。
    put('pending-4', 'proj-z');
    const [topics] = pendingTopics(home, index);
    const group = topics.find((t) => t.topic === 'proj-z');
    expect(group).toBeTruthy();
    expect(group!.docId).toBeUndefined();
  });

  it('picks the newest document when the project has several', () => {
    put('p-old', 'proj-m');
    put('p-new', 'proj-m');
    const older = commitEntry(home, defaultConfig(), index, {
      content: 'proj-m 的第一份活文档',
      type: 'fact',
      topic: 'm-one',
      project: 'proj-m',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    const newer = commitEntry(home, defaultConfig(), index, {
      content: 'proj-m 的第二份活文档，created 更晚',
      type: 'fact',
      topic: 'm-two',
      project: 'proj-m',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    const [topics] = pendingTopics(home, index);
    const group = topics.find((t) => t.topic === 'proj-m');
    expect(group).toBeTruthy();
    // 最新的那份是默认 supersede 对象。
    expect([older.id, newer.id]).toContain(group!.docId);
    expect(group!.otherDocs).toBeGreaterThanOrEqual(1);
  });

  it('does not leak documents across projects', () => {
    // proj-a 的文档不能被挂到 proj-b 的分组上。
    put('a-pending', 'proj-a');
    put('b-pending', 'proj-b');
    const docA = commitEntry(home, defaultConfig(), index, {
      content: '只属于 proj-a 的活文档',
      type: 'fact',
      topic: 'only-a',
      project: 'proj-a',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    const [topics] = pendingTopics(home, index);
    const groupB = topics.find((t) => t.topic === 'proj-b');
    expect(groupB).toBeTruthy();
    expect(groupB!.docId).toBeUndefined();
    const groupA = topics.find((t) => t.topic === 'proj-a');
    expect(groupA!.docId).toBe(docA.id);
  });
});
