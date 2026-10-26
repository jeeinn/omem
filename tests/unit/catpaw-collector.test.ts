// CatPaw transcript.txt 只读解析。源文件不得被改写。
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCatpawFile, listCatpawTranscripts, defaultCatpawRoot } from '../../src/collect/catpaw.js';

// 合成 CatPaw 风格纯文本 transcript
function makeTranscript(turns: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  const parts: string[] = [];
  for (const t of turns) {
    if (t.role === 'user') {
      parts.push('user:', '<user_query>', t.text, '</user_query>', '');
    } else {
      parts.push('assistant:', t.text, '');
    }
  }
  return parts.join('\n');
}

function writeSession(root: string, project: string, sid: string, body: string): string {
  const dir = join(root, project, sid, 'agent-transcripts');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'transcript.txt');
  writeFileSync(p, body);
  return p;
}

describe('collector: CatPaw transcript.txt', () => {
  it('extracts user_query content and assistant reply; skips Thinking/Tool blocks', () => {
    const dir = join(tmpdir(), 'omem-catpaw-' + Date.now());
    try {
      const body = [
        'user:',
        '<user_query>',
        '以后都用手写 SQL',
        '</user_query>',
        '',
        '[Thinking]',
        'The user wants to always use handwritten SQL.',
        'Let me think about the implications...',
        '',
        '[Tool call] read_file',
        '  target_file: x:\\omem\\README.md',
        '',
        '[Tool result] read_file',
        '',
        'assistant:',
        '好的，以后手写 SQL。',
        '',
      ].join('\n');
      const p = writeSession(dir, 'idex--demo', 'sess-1', body);
      const before = statSync(p);
      const digest = parseCatpawFile(p)!;
      const after = statSync(p);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs); // 源文件只读
      expect(digest).not.toBeNull();
      expect(digest.agent).toBe('catpaw');
      expect(digest.session_id).toBe('idex--demo/sess-1');
      expect(digest.messages).toHaveLength(2);
      expect(digest.messages[0].role).toBe('user');
      expect(digest.messages[0].content).toBe('以后都用手写 SQL');
      expect(digest.messages[1].role).toBe('assistant');
      expect(digest.messages[1].content).toBe('好的，以后手写 SQL。');
      // 脚手架不得出现
      const all = digest.messages.map((m) => m.content).join('\n');
      expect(all).not.toContain('[Thinking]');
      expect(all).not.toContain('[Tool call]');
      expect(all).not.toContain('[Tool result]');
      expect(all).not.toContain('read_file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles multi-turn conversations', () => {
    const dir = join(tmpdir(), 'omem-catpaw-multi-' + Date.now());
    try {
      const body = makeTranscript([
        { role: 'user', text: '第一个问题' },
        { role: 'assistant', text: '第一个回答' },
        { role: 'user', text: '第二个问题' },
        { role: 'assistant', text: '第二个回答' },
      ]);
      const p = writeSession(dir, 'idex--multi', 'sess-2', body);
      const digest = parseCatpawFile(p)!;
      expect(digest.messages).toHaveLength(4);
      expect(digest.messages[0].content).toBe('第一个问题');
      expect(digest.messages[1].content).toBe('第一个回答');
      expect(digest.messages[2].content).toBe('第二个问题');
      expect(digest.messages[3].content).toBe('第二个回答');
      // msg_uuid 稳定递增
      expect(digest.messages[0].msg_uuid).toMatch(/#0$/);
      expect(digest.messages[3].msg_uuid).toMatch(/#3$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no valid messages (empty or only noise)', () => {
    const dir = join(tmpdir(), 'omem-catpaw-empty-' + Date.now());
    try {
      // 纯脚手架，无对话
      const body = [
        '[Thinking]',
        'some thinking',
        '',
        '[Tool call] something',
        '  param: value',
        '',
        '[Tool result] something',
        '',
      ].join('\n');
      const p = writeSession(dir, 'idex--empty', 'sess-e', body);
      expect(parseCatpawFile(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for nonexistent file', () => {
    expect(parseCatpawFile(join(tmpdir(), 'nonexistent.txt'))).toBeNull();
  });

  it('listCatpawTranscripts: scans project/session/agent-transcripts/transcript.txt', () => {
    const dir = join(tmpdir(), 'omem-catpaw-list-' + Date.now());
    try {
      writeSession(dir, 'idex--proj1', 'sess-a', makeTranscript([{ role: 'user', text: 'p1' }]));
      writeSession(dir, 'idex--proj1', 'sess-b', makeTranscript([{ role: 'user', text: 'p2' }]));
      writeSession(dir, 'idex--proj2', 'sess-c', makeTranscript([{ role: 'user', text: 'p3' }]));
      const list = listCatpawTranscripts(dir);
      expect(list).toHaveLength(3);
      expect(list.map((f) => f.sessionId).sort()).toEqual([
        'idex--proj1/sess-a',
        'idex--proj1/sess-b',
        'idex--proj2/sess-c',
      ]);
      // 不存在的根
      expect(listCatpawTranscripts(join(dir, 'nope'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listCatpawTranscripts: filters by --since', () => {
    const dir = join(tmpdir(), 'omem-catpaw-since-' + Date.now());
    try {
      writeSession(dir, 'idex--since', 'sess-old', makeTranscript([{ role: 'user', text: 'old' }]));
      const list = listCatpawTranscripts(dir, { since: new Date('2030-01-01') });
      expect(list).toHaveLength(0);
      const listAll = listCatpawTranscripts(dir);
      expect(listAll).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaultCatpawRoot: env override wins; defaults to ~/.catpaw/projects', () => {
    expect(defaultCatpawRoot({ OMEM_CATPAW_PROJECTS: '/x/catpaw' })).toBe('/x/catpaw');
    // Windows 上 expandHome 把 ~ 转成反斜杠路径，用 sep 兼容
    expect(defaultCatpawRoot({})).toContain('.catpaw');
    expect(defaultCatpawRoot({})).toMatch(/projects$/);
  });
});
