// Cursor transcript 只读解析。源文件不得被改写。
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionFile } from '../../src/collect/claude-code.js';
import { parseCursorTranscript } from '../../src/collect/cursor.js';
import { extractFromDigest } from '../../src/process/rules.js';

const FIXTURE = [
  '{"role":"user","message":{"content":[{"type":"text","text":"这个项目以后都用手写 SQL，不要用 ORM"}]}}',
  '{"role":"assistant","message":{"content":[{"type":"text","text":"好的，以后手写 SQL。"},{"type":"tool_use","name":"Edit","input":{"file":"x"}}]}}',
  '{"message":{"content":[{"type":"text","text":"missing-role-marker"}]}}',
].join('\n');

describe('collector: Cursor transcript', () => {
  it('只保留 text 块，丢掉 tool_use，源文件不变', () => {
    const dir = join(tmpdir(), 'omem-cursor-' + Date.now());
    const path = join(dir, 'cursor-fixture-1.jsonl');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, FIXTURE);
      const before = statSync(path);
      const digest = parseCursorTranscript(path)!;
      const after = statSync(path);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(digest.agent).toBe('cursor');
      expect(digest.session_id).toBe('cursor-fixture-1');
      expect(digest.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      const all = digest.messages.map((m) => m.content).join('\n');
      expect(all).toContain('以后都用手写 SQL');
      expect(all).toContain('好的，以后手写 SQL。');
      expect(all).not.toContain('tool_use');
      expect(all).not.toContain('missing-role-marker');
      const candidates = extractFromDigest(digest);
      expect(candidates.some((c) => c.content.includes('手写 SQL'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Claude Code 解析器不会把 Cursor 行当成用户消息', () => {
    const dir = join(tmpdir(), 'omem-cursor-claude-' + Date.now());
    const path = join(dir, 'cursor-fixture-1.jsonl');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, FIXTURE);
      expect(parseSessionFile(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
