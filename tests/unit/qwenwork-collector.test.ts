// 千问办公（QwenWork）JSONL 只读解析。源文件不得被改写。
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionFile } from '../../src/collect/claude-code.js';
import { parseQwenworkFile } from '../../src/collect/qwenwork.js';
import { extractFromDigest } from '../../src/process/rules.js';

// 合成 fixture：与真实 ~/.qwenworkcn/projects/<encoded-cwd>/<id>.jsonl 的行结构一致
// （type=user|assistant + message.content 块数组；另有 active-leaf / last-prompt 等非消息行）。
const FIXTURE = [
  '{"type":"workspace-directories","sessionId":"qw-fixture-1","timestamp":"2026-10-20T08:00:00.000Z","directories":[]}',
  '{"type":"runtime-config","sessionId":"qw-fixture-1","timestamp":"2026-10-20T08:00:00.000Z","model":"m","reasoningEffort":"high"}',
  '{"type":"user","uuid":"u1","timestamp":"2026-10-20T08:00:01.000Z","sessionId":"qw-fixture-1","cwd":"X:/demo/qwenwork","gitBranch":"main","message":{"role":"user","content":[{"type":"text","text":"这个项目以后都用手写 SQL，不要用 ORM"}]}}',
  '{"type":"user","uuid":"u2","timestamp":"2026-10-20T08:00:02.000Z","sessionId":"qw-fixture-1","cwd":"X:/demo/qwenwork","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>harness noise</system-reminder>部署时统一用 pnpm"}]}}',
  '{"type":"user","uuid":"u3","timestamp":"2026-10-20T08:00:03.000Z","sessionId":"qw-fixture-1","cwd":"X:/demo/qwenwork","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"tool-result-marker-xyz"}]}}',
  '{"type":"assistant","uuid":"a1","timestamp":"2026-10-20T08:00:04.000Z","sessionId":"qw-fixture-1","cwd":"X:/demo/qwenwork","message":{"role":"assistant","content":[{"type":"thinking","thinking":"should-skip-thinking-marker"},{"type":"text","text":"好的，以后手写 SQL。"},{"type":"tool_use","id":"t1","name":"Edit","input":{"file":"x"}}]}}',
  '{"type":"active-leaf","sessionId":"qw-fixture-1","timestamp":"2026-10-20T08:00:05.000Z","leafUuid":"a1"}',
  '{"type":"last-prompt","sessionId":"qw-fixture-1","timestamp":"2026-10-20T08:00:06.000Z","lastPrompt":"最后输入"}',
  '{"type":"user","uuid":"side","timestamp":"2026-10-20T08:00:07.000Z","sessionId":"qw-fixture-1","isSidechain":true,"cwd":"X:/demo/qwenwork","message":{"role":"user","content":[{"type":"text","text":"sidechain-marker-xyz"}]}}',
  '{"type":"user","uuid":"u4","timestamp":"2026-10-20T08:00:08.000Z","sessionId":"qw-fixture-1","cwd":"X:/demo/qwenwork","message":{"role":"user","content":"纯字符串正文：接口一律走 /api/v2"}}',
  '{"broken',
  '',
].join('\n');

describe('collector: QwenWork JSONL', () => {
  it('keeps only user/assistant text; drops thinking, tools, sidechain, harness noise; tolerates broken lines', () => {
    const dir = join(tmpdir(), 'omem-qw-' + Date.now());
    const path = join(dir, 'qw-fixture-1.jsonl');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, FIXTURE);
      const before = statSync(path);
      const digest = parseQwenworkFile(path)!;
      const after = statSync(path);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(digest.agent).toBe('qwenwork');
      expect(digest.session_id).toBe('qw-fixture-1');
      expect(digest.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user']);
      const all = digest.messages.map((m) => m.content).join('\n');
      expect(all).toContain('以后都用手写 SQL');
      expect(all).toContain('统一用 pnpm');
      expect(all).toContain('接口一律走 /api/v2');
      expect(all).not.toContain('system-reminder');
      expect(all).not.toContain('should-skip-thinking-marker');
      expect(all).not.toContain('tool-result-marker-xyz');
      expect(all).not.toContain('tool_use');
      expect(all).not.toContain('sidechain-marker-xyz');
      expect(all).not.toContain('最后输入'); // last-prompt 行不是对话消息
      // 字段映射：uuid / ts / cwd / gitBranch
      expect(digest.messages[0].msg_uuid).toBe('u1');
      expect(digest.messages[0].ts).toBe('2026-10-20T08:00:01.000Z');
      expect(digest.messages[0].cwd).toBe('X:/demo/qwenwork');
      expect(digest.messages[0].git_branch).toBe('main');
      expect(digest.started_ts).toBe('2026-10-20T08:00:01.000Z');
      expect(digest.ended_ts).toBe('2026-10-20T08:00:08.000Z');
      // 规则抽取入口可用
      const candidates = extractFromDigest(digest);
      expect(candidates.some((c) => c.content.includes('手写 SQL'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty after filtering → null', () => {
    const dir = join(tmpdir(), 'omem-qw-empty-' + Date.now());
    const path = join(dir, 'qw-none.jsonl');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, ['{"type":"active-leaf","sessionId":"qw-none"}', '{"type":"user","uuid":"u1","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}'].join('\n'));
      expect(parseQwenworkFile(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes from Claude Code sessions by agent id (same line shape parses fine)', () => {
    const dir = join(tmpdir(), 'omem-qw-claude-' + Date.now());
    const path = join(dir, 'qw-fixture-1.jsonl');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, FIXTURE);
      // QwenWork 行与 Claude Code 同构，Claude 解析器也能读出正文，但 agent 归属必须是 qwenwork
      const d = parseQwenworkFile(path)!;
      expect(d.messages.every((m) => m.agent === 'qwenwork')).toBe(true);
      expect(parseSessionFile(path)).not.toBeNull(); // 同构格式可解析，互不排斥
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
