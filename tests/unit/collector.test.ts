// 采集器测试：Claude Code JSONL 解析、过滤规则、项目指纹（评估 4.5 采集器）。
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionFile, listSessionFiles, resolveProjectFp } from '../../src/collect/claude-code.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'claude-projects', '-x-demo-project', 'sess-fixture-1.jsonl');

describe('collector: Claude Code JSONL', () => {
  it('解析合成 fixture：消息数、角色、过滤', () => {
    const d = parseSessionFile(FIXTURE)!;
    expect(d).not.toBeNull();
    expect(d.session_id).toBe('sess-fixture-1');
    expect(d.agent).toBe('claude-code');
    // 8 行中：1 条 summary + 1 条 sidechain 被过滤 → 6 条消息
    expect(d.messages).toHaveLength(6);
    // sidechain 与 summary 内容不得出现
    const all = d.messages.map((m) => m.content).join('\n');
    expect(all).not.toContain('sidechain-marker-xyz');
    expect(all).not.toContain('会话摘要');
  });

  it('assistant 的 tool_use 块被剔除，只留 text', () => {
    const d = parseSessionFile(FIXTURE)!;
    const assistant = d.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe('好的，以后手写 SQL。');
    expect(assistant[0].content).not.toContain('tool_use');
  });

  it('msg_uuid / ts / project_fp 完整', () => {
    const d = parseSessionFile(FIXTURE)!;
    const first = d.messages[0];
    expect(first.msg_uuid).toBe('u1');
    expect(first.ts).toBe('2026-10-10T09:00:00.000Z');
    expect(first.project_fp).toMatch(/^(?:local:[0-9a-f]{8}|[0-9a-f]{12}|unknown)$/);
  });

  it('listSessionFiles 按 --since 过滤', () => {
    const dir = join(tmpdir(), 'omem-collect-test-' + Date.now());
    try {
      mkdirSync(join(dir, 'proj'), { recursive: true });
      writeFileSync(join(dir, 'proj', 's1.jsonl'), '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u","timestamp":"2026-10-10T09:00:00Z","sessionId":"s1"}\n');
      expect(listSessionFiles(dir)).toHaveLength(1);
      expect(listSessionFiles(dir, { since: new Date('2030-01-01') })).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏行被容忍（跳过不抛）', () => {
    const dir = join(tmpdir(), 'omem-collect-bad-' + Date.now());
    try {
      mkdirSync(join(dir, 'proj'), { recursive: true });
      writeFileSync(
        join(dir, 'proj', 'bad.jsonl'),
        ['这不是 JSON', '{"type":"user","message":{"role":"user","content":"有效消息"},"uuid":"u1","timestamp":"2026-10-10T09:00:00Z","sessionId":"bad"}', '{"broken'].join('\n'),
      );
      const d = parseSessionFile(join(dir, 'proj', 'bad.jsonl'))!;
      expect(d.messages).toHaveLength(1);
      expect(d.messages[0].content).toBe('有效消息');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveProjectFp：无 cwd → unknown；无 git → local: 前缀', () => {
    expect(resolveProjectFp(undefined)).toBe('unknown');
    const fp = resolveProjectFp(tmpdir());
    expect(fp.startsWith('local:')).toBe(true);
  });
});
