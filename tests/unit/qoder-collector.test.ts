// Qoder / Qoder-CN conversation-history JSONL 只读解析。源文件不得被改写。
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQoderFile, listQoderSessions, defaultQoderRoot, defaultQoderCnRoot } from '../../src/collect/qoder.js';
import type { SessionDigest } from '../../src/collect/types.js';

// 合成 Qoder 风格 JSONL：user 消息带 <user_query> + <attached_files> + <system-reminder> 噪声
function makeQoderJSONL(lines: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  return lines
    .map((l) => JSON.stringify({ role: l.role, message: { content: [{ type: 'text', text: l.text }] } }))
    .join('\n');
}

function writeSession(root: string, project: string, cid: string, body: string): string {
  const dir = join(root, 'cache', 'projects', project, 'conversation-history', cid);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${cid}.jsonl`);
  writeFileSync(p, body);
  return p;
}

describe('collector: Qoder conversation-history JSONL', () => {
  it('extracts user_query content; strips attached_files / system-reminder / UltraPlan noise', () => {
    const dir = join(tmpdir(), 'omem-qoder-' + Date.now());
    try {
      const body = makeQoderJSONL([
        {
          role: 'user',
          text: [
            '<attached_files>',
            '#file:e:/projects/fm-cmp/docs/spec.md',
            '<file>',
            '```',
            '1→# 需求文档',
            '2→大量嵌入的源码内容……',
            '```',
            '</file>',
            '</attached_files>',
            '',
            '',
            '<system-reminder>',
            '[IMPORTANT] You must always respond in 中文.',
            '</system-reminder>',
            '',
            '<system-reminder>',
            '<system_reminder>',
            'UltraPlan mode is active, and there is no need to call the "SwitchMode" tool.',
            '== Phase 1: Parallel Plan Design ==',
            'Goal: Launch 3 independent plan-agents that each explore the codebase...',
            '</system_reminder>',
            '</system-reminder>',
            '',
            '<user_query>',
            "'e:/projects/fm-cmp/docs/spec.md'  需求：增加单独的\"提现账户配置\"模块，实现对提现账户的添加、审核、修改、删除操作。前端页面的筛选查询、导出等功能。需要新建配置表",
            '</user_query>',
          ].join('\n'),
        },
        { role: 'assistant', text: '我先阅读需求文档并探索代码库中类似模块的实现模式。' },
      ]);
      const p = writeSession(dir, 'proj-abc', 'cid-1', body);
      const before = statSync(p);
      const digest = parseQoderFile(p)!;
      const after = statSync(p);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs); // 源文件只读
      expect(digest).not.toBeNull();
      expect(digest.agent).toBe('qoder');
      expect(digest.session_id).toBe('cid-1');
      expect(digest.project_fp).toBe('proj-abc');
      expect(digest.messages).toHaveLength(2);
      expect(digest.messages[0].role).toBe('user');
      const userText = digest.messages[0].content;
      expect(userText).toContain('增加单独的');
      expect(userText).toContain('提现账户配置');
      expect(userText).not.toContain('attached_files');
      expect(userText).not.toContain('UltraPlan');
      expect(userText).not.toContain('system-reminder');
      expect(userText).not.toContain('需求文档');
      expect(userText).not.toContain('嵌入的源码');
      expect(digest.messages[1].role).toBe('assistant');
      expect(digest.messages[1].content).toContain('阅读需求文档');
      // msg_uuid 稳定
      expect(digest.messages[0].msg_uuid).toBe('cid-1#0');
      expect(digest.messages[1].msg_uuid).toBe('cid-1#1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles plain user content without user_query tags (strips system-reminder only)', () => {
    const dir = join(tmpdir(), 'omem-qoder-direct-' + Date.now());
    try {
      const body = makeQoderJSONL([
        {
          role: 'user',
          text: '<system-reminder>noise</system-reminder>这个项目以后都用手写 SQL',
        },
        { role: 'assistant', text: '好的，手写 SQL。' },
      ]);
      const p = writeSession(dir, 'proj-dir', 'cid-d', body);
      const digest = parseQoderFile(p)!;
      expect(digest.messages).toHaveLength(2);
      expect(digest.messages[0].content).toBe('这个项目以后都用手写 SQL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops lines that become empty after filtering', () => {
    const dir = join(tmpdir(), 'omem-qoder-empty-' + Date.now());
    try {
      const body = makeQoderJSONL([
        { role: 'user', text: '<system-reminder>only noise</system-reminder>' },
        { role: 'user', text: '<attached_files><file>x</file></attached_files>' },
        { role: 'assistant', text: 'some reply' },
      ]);
      const p = writeSession(dir, 'proj-em', 'cid-e', body);
      const digest = parseQoderFile(p)!;
      // 前两条 user 消息过滤后为空被丢弃，只剩 assistant
      expect(digest.messages).toHaveLength(1);
      expect(digest.messages[0].role).toBe('assistant');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no messages survive filtering', () => {
    const dir = join(tmpdir(), 'omem-qoder-allnoise-' + Date.now());
    try {
      const body = makeQoderJSONL([
        { role: 'user', text: '<system-reminder>纯噪声</system-reminder>' },
      ]);
      const p = writeSession(dir, 'proj-nn', 'cid-n', body);
      expect(parseQoderFile(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates broken JSON lines and missing files', () => {
    const dir = join(tmpdir(), 'omem-qoder-broken-' + Date.now());
    mkdirSync(dir, { recursive: true });
    try {
      // 1) 坏行 + 好行 混合
      const bp = join(dir, 'garbage.jsonl');
      writeFileSync(bp, '{"broken\n{"role":"user","message":{"content":[{"type":"text","text":"有效内容"}]}}\n');
      const digest = parseQoderFile(bp);
      // 路径不含 conversation-history/<cid> 结构，sessionId 取倒数第二段（目录名），不会 crash
      expect(digest).not.toBeNull();
      expect(digest!.messages).toHaveLength(1);
      // 2) 不存在的文件
      expect(parseQoderFile(join(dir, 'nonexistent.jsonl'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listQoderSessions: scans both intl and cn roots; dedup by session_id', () => {
    const dirI = join(tmpdir(), 'omem-qoder-intl-' + Date.now());
    const dirC = join(tmpdir(), 'omem-qoder-cn-' + Date.now());
    try {
      writeSession(dirI, 'projA', 'sid-1', makeQoderJSONL([{ role: 'user', text: 'intl session' }]));
      writeSession(dirC, 'projB', 'sid-2', makeQoderJSONL([{ role: 'user', text: 'cn session' }]));
      // 两边同名 session_id：CN 版 mtime 更新 → 应保留 CN
      writeSession(dirI, 'projC', 'sid-shared', makeQoderJSONL([{ role: 'user', text: 'OLD intl' }]));
      // 先把 intl 那份写到旧时间
      writeSession(dirC, 'projC', 'sid-shared', makeQoderJSONL([{ role: 'user', text: 'NEW cn' }]));

      const intl = listQoderSessions(dirI);
      expect(intl).toHaveLength(2); // sid-1, sid-shared (intl)
      const cn = listQoderSessions(dirC);
      expect(cn).toHaveLength(2); // sid-2, sid-shared (cn)
      expect(intl[0].sessionId).toBe('sid-1');
      expect(cn[0].sessionId).toBe('sid-2');
      // 不存在的根
      expect(listQoderSessions(join(dirI, 'nope'))).toEqual([]);
    } finally {
      rmSync(dirI, { recursive: true, force: true });
      rmSync(dirC, { recursive: true, force: true });
    }
  });

  it('default roots: env override wins; defaults to ~/.qoder and ~/.qoder-cn', () => {
    expect(defaultQoderRoot({ OMEM_QODER_PROJECTS: '/x/qoder' })).toBe('/x/qoder');
    expect(defaultQoderCnRoot({ OMEM_QODER_CN_PROJECTS: '/x/qoder-cn' })).toBe('/x/qoder-cn');
    expect(defaultQoderRoot({})).toMatch(/\.qoder$/);
    expect(defaultQoderCnRoot({})).toMatch(/\.qoder-cn$/);
  });
});
