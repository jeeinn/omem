// v0.5.0 S3：空态渲染 + 隐藏提示的「可执行性」端到端核对。
// 评审要求：隐藏提示里出现的工具名 + 参数组合，必须真能取到会话原文。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { refreshProcessGuide } from '../../src/process/guide.js';
import { readSessionsById } from '../../src/collect/session-store.js';
import { userSegments } from '../../src/collect/session-store.js';
import { dirs } from '../../src/core/paths.js';
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

describe('S3: empty state', () => {
  it('no sessions at all -> "No topics are waiting." and no exception', () => {
    const guidePath = refreshProcessGuide(home, index);
    const { readFileSync } = require('node:fs');
    const text = readFileSync(guidePath, 'utf8');
    expect(text).toContain('No topics are waiting.');
    expect(text.toLowerCase()).toContain('topics');
  });
});

describe('S3: hidden hint points to a channel that really returns ## user text', () => {
  it('search_memory(session_id="<hidden id>") resolves to quotable user segments', () => {
    const dir = join(dirs.sessions(home), 'claude-code');
    mkdirSync(dir, { recursive: true });
    const id = 'hidden-probe-0001';
    writeFileSync(join(dir, `${id}.md`), [
      '---', 'agent: claude-code', `session_id: ${id}`, 'project: eval',
      'started: 2026-11-22T00:00:00.000Z', 'ended: 2026-11-22T00:00:00.000Z',
      'messages: 1', `content_hash: hash-${id}`, '---', '',
      '## user', '连接池上限设为 20，超过就排队',
      '## assistant', '助手的回答不算证据', '',
    ].join('\n'), 'utf8');
    index.catchUp();

    const cited = readSessionsById(home, id);
    expect(cited).toHaveLength(1);
    const { segments } = userSegments(cited[0].body);
    expect(segments.some((s) => s.text.includes('连接池上限设为 20'))).toBe(true);
    expect(segments.every((s) => s.role === 'user')).toBe(true);
    expect(JSON.stringify(segments)).not.toContain('助手的回答');
  });
});
