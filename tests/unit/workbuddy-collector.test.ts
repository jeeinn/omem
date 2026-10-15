// WorkBuddy JSONL 只读解析。源文件不得被改写。
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionFile } from '../../src/collect/claude-code.js';
import { parseWorkbuddyFile } from '../../src/collect/workbuddy.js';
import { extractFromDigest } from '../../src/process/rules.js';

const FIXTURE = [
  '{"type":"session-meta","id":"m1","sessionId":"wb-fixture-1","timestamp":"2026-10-15T01:00:00.000Z","meta":{}}',
  '{"type":"message","id":"u1","sessionId":"wb-fixture-1","timestamp":"2026-10-15T01:00:01.000Z","role":"user","content":[{"type":"input_text","text":"这个项目以后都用手写 SQL，不要用 ORM"}],"cwd":"X:/demo/workbuddy"}',
  '{"type":"reasoning","id":"r1","timestamp":"2026-10-15T01:00:01.500Z","content":[{"type":"reasoning_text","text":"should-skip-reasoning-marker"}]}',
  '{"type":"function_call","id":"c1","name":"Edit","arguments":"{\\"file\\":\\"x\\"}"}',
  '{"type":"function_call_result","id":"c2","name":"Edit","output":"tool-result-marker-xyz"}',
  '{"type":"file-history-snapshot","timestamp":"2026-10-15T01:00:01.800Z","snapshot":{"files":[]}}',
  '{"type":"message","id":"a1","sessionId":"wb-fixture-1","timestamp":"2026-10-15T01:00:02.000Z","role":"assistant","content":[{"type":"output_text","text":"好的，以后手写 SQL。"}]}',
  '{"type":"message","id":"side","sessionId":"wb-fixture-1","timestamp":"2026-10-15T01:00:03.000Z","role":"user","isSidechain":true,"content":[{"type":"input_text","text":"sidechain-marker-xyz"}]}',
].join('\n');

describe('collector: WorkBuddy JSONL', () => {
  it('只保留 user/assistant 正文，丢掉推理、工具和 sidechain', () => {
    const dir = join(tmpdir(), 'omem-wb-' + Date.now());
    const path = join(dir, 'wb-fixture-1.jsonl');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, FIXTURE);
      const before = statSync(path);
      const digest = parseWorkbuddyFile(path)!;
      const after = statSync(path);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(digest.agent).toBe('workbuddy');
      expect(digest.session_id).toBe('wb-fixture-1');
      expect(digest.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      const all = digest.messages.map((m) => m.content).join('\n');
      expect(all).toContain('以后都用手写 SQL');
      expect(all).not.toContain('should-skip-reasoning-marker');
      expect(all).not.toContain('tool-result-marker-xyz');
      expect(all).not.toContain('sidechain-marker-xyz');
      const candidates = extractFromDigest(digest);
      expect(candidates.some((c) => c.content.includes('手写 SQL'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Claude Code 解析器不会把 WorkBuddy 行当成用户消息', () => {
    const dir = join(tmpdir(), 'omem-wb-claude-' + Date.now());
    const path = join(dir, 'wb-fixture-1.jsonl');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, FIXTURE);
      expect(parseSessionFile(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
