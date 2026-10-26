// 豆包办公（Doubao）trajectory 只读解析。源文件不得被改写。
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDoubaoFile, listDoubaoSessions, defaultDoubaoRoot } from '../../src/collect/doubao.js';
import { extractFromDigest } from '../../src/process/rules.js';

// 合成 fixture：与真实豆包 trajectory.jsonl 的行结构一致
// （OpenAI messages 风格：role=user|assistant|tool，content 为 string；assistant 行可带 tool_calls；无 type/timestamp）。
const FIXTURE = [
  '{"role":"user","content":"<system-reminder>harness noise</system-reminder>这个项目以后都用手写 SQL，不要用 ORM"}',
  '{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{}"}}]}',
  '{"role":"tool","tool_call_id":"call_1","content":"tool-result-marker-xyz"}',
  '{"role":"assistant","content":"好的，以后手写 SQL。","tool_calls":[{"id":"call_2","type":"function","function":{"name":"Edit","arguments":"{}"}}]}',
  '{"role":"user","content":"部署时统一用 pnpm"}',
  '{"broken',
  '',
].join('\n');

function makeTrajectory(root: string, sid: string, agent: string, body: string): string {
  const dir = join(root, sid, 'agents', agent, 'system');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'trajectory.jsonl');
  writeFileSync(p, body);
  return p;
}

describe('collector: Doubao trajectory.jsonl', () => {
  it('keeps user/assistant text; drops tool rows, empty tool_calls rows, harness noise; tolerates broken lines', () => {
    const dir = join(tmpdir(), 'omem-doubao-' + Date.now());
    try {
      const p = makeTrajectory(dir, 'sess-demo-1', 'm_agent_a', FIXTURE);
      const before = statSync(p);
      const digest = parseDoubaoFile(p)!;
      const after = statSync(p);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs); // 源文件只读，不被改写
      expect(digest).not.toBeNull();
      expect(digest.agent).toBe('doubao');
      expect(digest.session_id).toBe('sess-demo-1');
      expect(digest.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      const all = digest.messages.map((m) => m.content).join('\n');
      expect(all).toContain('以后都用手写 SQL');
      expect(all).toContain('统一用 pnpm');
      expect(all).not.toContain('system-reminder');
      expect(all).not.toContain('harness noise');
      expect(all).not.toContain('tool-result-marker-xyz');
      expect(all).not.toContain('tool_calls');
      // 无时间戳：稳定占位 ISO，不随运行时间漂移
      expect(digest.messages[0].ts).toBe(new Date(0).toISOString());
      expect(digest.messages[0].msg_uuid).toBe('sess-demo-1#0');
      expect(digest.started_ts).toBe(new Date(0).toISOString());
      // 规则抽取入口可用
      const candidates = extractFromDigest(digest);
      expect(candidates.some((c) => c.content.includes('手写 SQL'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty after filtering → null', () => {
    const dir = join(tmpdir(), 'omem-doubao-empty-' + Date.now());
    try {
      const p = makeTrajectory(dir, 'sess-none', 'm_agent_b', [
        '{"role":"tool","tool_call_id":"x","content":"no dialogue"}',
        '{"role":"assistant","content":"","tool_calls":[{"id":"y"}]}',
      ].join('\n'));
      expect(parseDoubaoFile(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listDoubaoSessions: one entry per session; picks the newest agent trajectory when several exist', () => {
    const dir = join(tmpdir(), 'omem-doubao-list-' + Date.now());
    try {
      makeTrajectory(dir, 'sess-a', 'm_main', '{"role":"user","content":"会话 A 内容"}\n');
      const sub = makeTrajectory(dir, 'sess-a', 'm_subagent', '{"role":"user","content":"子代理内容"}');
      // 把子代理文件的 mtime 调旧，主 agent 保持最新 → 列表必须选主 agent 那份
      const old = 1_700_000_000_000;
      utimesSync(sub, new Date(old), new Date(old));
      makeTrajectory(dir, 'sess-b', 'm_main2', '{"role":"user","content":"会话 B 内容"}\n');
      // 非 trajectory 文件不进列表
      mkdirSync(join(dir, 'sess-c', 'agents', 'm_x', 'system'), { recursive: true });
      writeFileSync(join(dir, 'sess-c', 'agents', 'm_x', 'system', 'notes.md'), 'not a jsonl');

      const files = listDoubaoSessions(dir);
      expect(files).toHaveLength(2); // sess-a（最新那份）+ sess-b；sess-c 无 trajectory
      const ids = files.map((f) => f.sessionId).sort();
      expect(ids).toEqual(['sess-a', 'sess-b']);
      const digest = parseDoubaoFile(files[0].path);
      expect(digest).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listDoubaoSessions on a missing root returns [] (no throw)', () => {
    expect(listDoubaoSessions(join(tmpdir(), 'omem-doubao-absent-' + Date.now()))).toEqual([]);
  });

  it('defaultDoubaoRoot: env override wins; Windows default points at the real workspace .sessions', () => {
    expect(defaultDoubaoRoot({ OMEM_DOUBAO_PROJECTS: '/x/sessions' })).toBe('/x/sessions');
    const win = defaultDoubaoRoot({ LOCALAPPDATA: 'C:/Users/tester/AppData/Local' });
    expect(win).toContain(join('Doubao', 'User Data', 'Default', '.doubao', 'agent_mode', 'workspace', '.sessions'));
  });
});
