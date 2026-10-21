// 会话原文入库：剥离脚手架、写入 sessions/、默认不产生结论、依据打分。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { stripHarness } from '../../src/collect/dialogue.js';
import { parseCursorTranscript } from '../../src/collect/cursor.js';
import {
  renderDialogue,
  sessionKey,
  writeSessionFile,
  parseStoredSession,
  readStoredSession,
  updateSessionApiState,
} from '../../src/collect/session-store.js';
import type { SessionDigest } from '../../src/collect/types.js';
import { OmemIndex } from '../../src/core/index.js';
import { runPipeline } from '../../src/process/pipeline.js';
import { searchEntries, searchSessions } from '../../src/core/search.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { listEntries } from '../../src/core/store.js';
import { files } from '../../src/core/paths.js';
import { commitEntry } from '../../src/core/commit.js';
import { reconfirm } from '../../src/core/lifecycle.js';
import { applyAssent, scoreEvidence } from '../../src/process/score.js';
import { makeHome, cleanupHome } from './helpers.js';

const FIXTURE_ROOT = join(process.cwd(), 'tests', 'fixtures', 'claude-projects');
const FIXTURE_FILE = join(FIXTURE_ROOT, '-x-demo-project', 'sess-fixture-1.jsonl');
const ABSENT = join(FIXTURE_ROOT, 'nonexistent');

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

function fixtureConfig() {
  const config = defaultConfig();
  config.collect.claude_projects = FIXTURE_ROOT;
  config.collect.workbuddy_projects = ABSENT;
  config.collect.cursor_projects = ABSENT;
  saveConfig(home, config);
  return config;
}

describe('stripHarness', () => {
  it('keeps only user_query and drops the system reminder', () => {
    const raw = '<system-reminder>never use it as the primary output</system-reminder>\n<user_query>以后都用手写 SQL</user_query>';
    expect(stripHarness(raw)).toBe('以后都用手写 SQL');
    expect(stripHarness(raw)).not.toContain('never use');
  });

  it('cursor parser does not keep the scaffold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omem-cursor-'));
    const path = join(dir, 'abc.jsonl');
    const before = { size: 0, mtimeMs: 0 };
    writeFileSync(path, JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<system-reminder>禁止读取 recommend-experts</system-reminder><user_query>请分别提交</user_query>' }] },
    }) + '\n');
    const st = statSync(path);
    before.size = st.size;
    before.mtimeMs = st.mtimeMs;
    const digest = parseCursorTranscript(path);
    expect(digest?.messages[0].content).toBe('请分别提交');
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('session ingest', () => {
  it('default run writes sessions/ and no knowledge entries', () => {
    const before = statSync(FIXTURE_FILE);
    const config = fixtureConfig();
    const report = runPipeline(home, config, index, {});
    expect(report.tier).toBe('agent');
    expect(report.written).toHaveLength(0);
    expect(listEntries(home)).toHaveLength(0);
    const sessionPath = join(home, 'sessions', 'claude-code', 'sess-fixture-1.md');
    const text = readFileSync(sessionPath, 'utf8');
    expect(text).toContain('## user');
    expect(text).toContain('手写 SQL');
    expect(text).not.toContain('sk-ant-abc123');
    expect(readFileSync(files.processGuide(home), 'utf8')).toContain('sess-fixture-1');
    const after = statSync(FIXTURE_FILE);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('unchanged session is skipped and search --sessions does not leak into conclusions', () => {
    const config = fixtureConfig();
    runPipeline(home, config, index, {});
    const again = runPipeline(home, config, index, {});
    expect(again.sessions).toBe(0);
    expect(again.skipped).toBe(1);
    expect(searchEntries(index, { query: '手写 SQL' })).toHaveLength(0);
    expect(searchSessions(index, '手写 SQL').length).toBeGreaterThan(0);
  });

  it('session text is stored verbatim: no keyword filter remains', () => {
    // exclude_keywords 已从配置移除。业务敏感词会原样落盘（已知取舍，见 README「已知取舍」）。
    const config = fixtureConfig();
    runPipeline(home, config, index, {});
    expect(readFileSync(join(home, 'sessions', 'claude-code', 'sess-fixture-1.md'), 'utf8')).toContain('踩坑');
  });
});

describe('evidence score', () => {
  function digest(id: string, user: string, assistant: string): SessionDigest {
    return {
      session_id: id,
      agent: 'cursor',
      project_fp: 'unknown',
      started_ts: '2026-10-15T00:00:00.000Z',
      ended_ts: '2026-10-15T00:01:00.000Z',
      messages: [
        { session_id: id, agent: 'cursor', ts: '2026-10-15T00:00:00.000Z', project_fp: 'unknown', role: 'user', content: user, msg_uuid: 'u' },
        { session_id: id, agent: 'cursor', ts: '2026-10-15T00:01:00.000Z', project_fp: 'unknown', role: 'assistant', content: assistant, msg_uuid: 'a' },
      ],
    };
  }

  it('grounds on a user section, rejects the assistant, and pending-session stays 0.55', () => {
    const userLine = '以后都用手写 SQL，不要用 ORM 框架';
    const d = digest('s1', userLine, '助手自己说了一句很长的不应该被当成依据的话');
    writeSessionFile(home, d, renderDialogue(d), 'h');
    const grounded = scoreEvidence(home, { content: '这个项目用手写 SQL', sessionId: 's1', evidence: userLine });
    expect(grounded.confidence).toBe(0.55);
    const assistant = scoreEvidence(home, {
      content: '引用助手',
      sessionId: 's1',
      evidence: '助手自己说了一句很长的不应该被当成依据的话',
    });
    expect(assistant.confidence).toBe(0.35);
    expect(assistant.tags).toContain('ungrounded');
    const pending = scoreEvidence(home, { content: '记住这件事' });
    expect(pending.confidence).toBe(0.55);
    expect(pending.tags).toContain('pending-session');
  });

  it('an on-disk copy that is not in the session index does not raise the score', () => {
    const userLine = '以后都用手写 SQL，不要用 ORM 框架';
    const cited = digest('s1', userLine, '助手甲');
    const extra = digest('s-extra', userLine, '助手乙');
    const written = writeSessionFile(home, cited, renderDialogue(cited), 'h1');
    writeSessionFile(home, extra, renderDialogue(extra), 'h2');
    index.putSession({
      session_id: sessionKey('cursor', 's1'),
      agent: 'cursor',
      path: written.path,
      content_hash: 'h1',
      project_fp: 'unknown',
      msg_count: 2,
      last_ts: cited.ended_ts,
      processed_at: cited.ended_ts,
    }, renderDialogue(cited));
    const scored = scoreEvidence(home, { content: '用手写 SQL', sessionId: 's1', evidence: userLine }, index);
    expect(scored.confidence).toBe(0.55);
  });

  it('confirm_ids stops at 0.8 and review --confirm reaches 0.9', () => {
    const config = defaultConfig();
    const saved = commitEntry(home, config, index, {
      content: '待确认的结论条目内容足够长',
      type: 'fact',
      domain: 'general',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    const id = saved.id!;
    applyAssent(home, index, [id]);
    const mid = listEntries(home)[0].entry.fm;
    expect(mid.confidence).toBe(0.8);
    expect(mid.verified).toBe(false);
    expect(mid.tags).toContain('assent');
    reconfirm(home, index, id);
    const done = listEntries(home)[0].entry.fm;
    expect(done.verified).toBe(true);
    expect(done.confidence).toBe(0.9);
  });
});

describe('session-store: api_state frontmatter (档 3 文档 §3.5)', () => {
  function digestOf(): SessionDigest {
    return {
      agent: 'claude-code',
      session_id: 'sess-api-state-1',
      project_fp: 'proj-x',
      started_ts: '2026-10-20T10:00:00.000Z',
      ended_ts: '2026-10-20T10:05:00.000Z',
      messages: [
        { role: 'user', content: 'hello world', ts: '2026-10-20T10:00:00.000Z' },
        { role: 'assistant', content: 'hi', ts: '2026-10-20T10:01:00.000Z' },
      ],
    };
  }

  it('parses and renders api_state; unknown keys are ignored', () => {
    const home = mkdtempSync(join(tmpdir(), 'omem-api-state-'));
    try {
      const d = digestOf();
      const { path, text } = writeSessionFile(home, d, '## user\nhello world\n\n## assistant\nhi', 'abc123');
      expect(text).not.toContain('api_state');
      // 手写一个带 api_state 与未知键的文件
      const manual = text.replace('---\n\n', 'api_state: ok:v1:abc123\nmystery_key: 42\n---\n\n');
      writeFileSync(path, manual);
      const stored = parseStoredSession(manual);
      expect(stored?.apiState).toBe('ok:v1:abc123');
      expect((stored as any).mystery_key).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writeSessionFile keeps api_state when content hash is unchanged', () => {
    const home = mkdtempSync(join(tmpdir(), 'omem-api-state-'));
    try {
      const d = digestOf();
      const body = '## user\nhello world\n\n## assistant\nhi';
      const first = writeSessionFile(home, d, body, 'hash-1');
      expect(updateSessionApiState(first.path, 'ok:v1:hash-1')).toBe(true);
      expect(readStoredSession(first.path)?.apiState).toBe('ok:v1:hash-1');
      // 同哈希重写（--session 点名未变内容的路径）→ 状态保留
      writeSessionFile(home, d, body, 'hash-1');
      expect(readStoredSession(first.path)?.apiState).toBe('ok:v1:hash-1');
      // 哈希变化 → 状态丢弃（重新进队列）
      writeSessionFile(home, d, `${body}\nmore`, 'hash-2');
      expect(readStoredSession(first.path)?.apiState).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('updateSessionApiState only touches the frontmatter line', () => {
    const home = mkdtempSync(join(tmpdir(), 'omem-api-state-'));
    try {
      const d = digestOf();
      const body = '## user\nhello world\n\n## assistant\nhi';
      const { path } = writeSessionFile(home, d, body, 'hash-1');
      updateSessionApiState(path, 'fail:v1:hash-1:1');
      const after = readFileSync(path, 'utf8');
      expect(after).toContain('api_state: fail:v1:hash-1:1');
      expect(after).toContain('content_hash: hash-1');
      expect(after).toContain('hello world');
      // 清空（undefined）→ 行消失
      updateSessionApiState(path, undefined);
      expect(readFileSync(path, 'utf8')).not.toContain('api_state');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
