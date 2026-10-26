// DeepSeek Harness（dsh-desktop）zstd-JSONL 只读解析。源文件不得被改写。
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Encoder } from '@toondepauw/node-zstd';
import { parseDeepSeekFile, listDeepSeekSessions, defaultDeepSeekRoot } from '../../src/collect/deepseek.js';
import type { SessionDigest } from '../../src/collect/types.js';

const ZSTD = new Encoder(3);

// 合成一个最小 DeepSeek v4 JSONL 正文（类型/行顺序与本地产出一致）
function v4Loose(userUtterances: string[], assistantReplies: string[]): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'session',
      version: 4,
      id: 'session-demo-1',
      createdAt: 1_700_000_000_000,
      cwd: 'X:/demo/deepseek',
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
    }),
  ];
  for (let i = 0; i < userUtterances.length; i++) {
    lines.push(JSON.stringify({ type: 'user/message', data: { content: userUtterances[i] } }));
    if (assistantReplies[i]) {
      lines.push(JSON.stringify({
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: assistantReplies[i] }],
          },
        },
      }));
    }
  }
  return lines.join('\n');
}

function writeCompressed(root: string, project: string, sid: string, body: string, version: 'v4' | 'v0' = 'v4'): string {
  const dir = join(root, project, sid);
  mkdirSync(dir, { recursive: true });
  const name = version === 'v4' ? 'session.v4.jsonl.zstd' : 'session.jsonl.zstd';
  const p = join(dir, name);
  writeFileSync(p, ZSTD.encodeSync(Buffer.from(body, 'utf8')));
  return p;
}

describe('collector: DeepSeek Harness session.jsonl.zstd', () => {
  it('decompresses, keeps user assistant text, drops reasoning and tool trace, tolerant to junk lines', () => {
    const dir = join(tmpdir(), 'omem-ds-' + Date.now());
    try {
      // 手动拼一个带噪声的正文：含 reasoning / image / 坏行
      const noisy = [
        JSON.stringify({
          type: 'session',
          version: 4,
          id: 'sess-demo-noise',
          createdAt: 1_700_000_000_000,
          cwd: 'E:/dev/project-x',
        }),
        JSON.stringify({ type: 'user/message', data: { content: '<system-reminder>harness noise</system-reminder>这个项目以后都用手写 SQL' } }),
        JSON.stringify({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，手写 SQL' }] } } }),
        JSON.stringify({ type: 'step/start', data: { step: { id: 's1' } } }),
        JSON.stringify({ type: 'tool/call', data: { toolCall: { name: 'Bash' } } }),
        '{"broken',
        '',
      ].join('\n');
      const p = writeCompressed(dir, 'myProj', 's-id-1', noisy);

      const before = statSync(p);
      const digest = parseDeepSeekFile(p)!;
      const after = statSync(p);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs); // 源文件只读
      expect(digest).not.toBeNull();
      expect(digest.agent).toBe('deepseek');
      expect(digest.session_id).toBe('sess-demo-noise');
      expect(digest.project_fp).toBe('E:/dev/project-x');
      expect(digest.cwd).toBe('E:/dev/project-x');
      expect(digest.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      const all = digest.messages.map((m) => m.content).join('\n');
      expect(all).toContain('以后都用手写 SQL');
      expect(all).toContain('好的，手写 SQL');
      expect(all).not.toContain('system-reminder');
      expect(all).not.toContain('harness noise');
      expect(all).not.toContain('step/start');
      expect(all).not.toContain('tool/call');
      // 无独立时间戳：稳定 ISO 占位
      expect(digest.messages[0].ts).toBe(digest.messages[0].ts); // 稳定
      expect(digest.messages[0].msg_uuid).toBe('sess-demo-noise#0');
      expect(digest.messages[1].msg_uuid).toBe('sess-demo-noise#1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles array-typed user content and filters non-text assistant blocks', () => {
    const dir = join(tmpdir(), 'omem-ds-array-' + Date.now());
    try {
      const body = [
        JSON.stringify({ type: 'session', version: 4, id: 'sess-array', createdAt: 0, cwd: 'Q:/arr' }),
        JSON.stringify({
          type: 'user/message',
          data: { content: [{ type: 'text', text: '部署用 pnpm' }, { type: 'image', url: 'x.png' }] },
        }),
        JSON.stringify({
          type: 'assistant/message',
          data: {
            message: {
              role: 'assistant',
              content: [
                { type: 'reasoning', text: '思考……' },
                { type: 'text', text: '已记录，部署用 pnpm' },
              ],
            },
          },
        }),
      ].join('\n');
      const p = writeCompressed(dir, 'arrProj', 'sid-2', body);
      const digest = parseDeepSeekFile(p)!;
      expect(digest.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      const all = digest.messages.map((m) => m.content).join('\n');
      expect(all).toContain('部署用 pnpm');
      expect(all).not.toContain('reasoning');
      expect(all).not.toContain('思考');
      expect(all).not.toContain('x.png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no user/assistant dialogue survives filtering', () => {
    const dir = join(tmpdir(), 'omem-ds-empty-' + Date.now());
    try {
      const body = [
        JSON.stringify({ type: 'session', version: 4, id: 's-empty', createdAt: 0, cwd: 'Z:/e' }),
        JSON.stringify({ type: 'step/start', data: { step: { id: 's1' } } }),
        // assistant 但只有推理块，没有 text
        JSON.stringify({
          type: 'assistant/message',
          data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'think' }] } },
        }),
      ].join('\n');
      const p = writeCompressed(dir, 'empProj', 'sid-e', body);
      expect(parseDeepSeekFile(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null on corrupt / non-zstd / non-json input', () => {
    const dir = join(tmpdir(), 'omem-ds-garbage-' + Date.now());
    mkdirSync(dir, { recursive: true });
    try {
      // 1) 非法 zstd字节
      const badZstd = join(dir, 'garbage1.zstd');
      writeFileSync(badZstd, Buffer.from([0x00, 0x01, 0x02, 0x03]));
      expect(parseDeepSeekFile(badZstd)).toBeNull();
      // 2) 合法 zstd 但正文不是 JSONL
      const plain = join(dir, 'garbage2.zstd');
      writeFileSync(plain, ZSTD.encodeSync(Buffer.from('plain text, not json lines', 'utf8')));
      expect(parseDeepSeekFile(plain)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listDeepSeekSessions: scans <project>/<session>/<file>; v4 wins over v0; missing root → []', () => {
    const dirA = join(tmpdir(), 'omem-ds-list-a-' + Date.now());
    const dirB = join(tmpdir(), 'omem-ds-list-b-' + Date.now());
    try {
      writeCompressed(dirA, 'prjA', 'sid-1', v4Loose(['你好'], ['你好，我是 DeepSeek']), 'v4');
      // 同一 project：v0 版本也出现
      writeCompressed(dirA, 'prjA', 'sid-2', v4Loose(['老版本 v0'], ['我是']), 'v0');
      writeCompressed(dirA, 'prjA', 'sid-3', v4Loose(['B 内容'], ['B']), 'v0');
      writeCompressed(dirA, 'prjB', 'sid-4', v4Loose(['C 内容'], ['C']), 'v4');

      const files = listDeepSeekSessions(dirA);
      expect(files).toHaveLength(4);
      const ids = files.map((f) => f.sessionId).sort();
      expect(ids).toEqual(['sid-1', 'sid-2', 'sid-3', 'sid-4']);

      // 异常路径
      expect(listDeepSeekSessions(join(dirA, 'non-existent'))).toEqual([]);
      expect(listDeepSeekSessions(dirB)).toEqual([]);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('defaultDeepSeekRoot: env override wins; default is ~/.dsh/sessions', () => {
    expect(defaultDeepSeekRoot({ OMEM_DEEPSEEK_PROJECTS: '/x/ds' })).toBe('/x/ds');
    const root = defaultDeepSeekRoot({});
    expect(root).toMatch(/\.dsh.sessions$/);
  });
});
