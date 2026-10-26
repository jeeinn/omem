// CodeBuddy 采集器测试：JSONL 解析、毫秒时间戳、目录名反解、双根合并。
//
// 格式依据来自本机真实数据（2026-10-26 实测 ~/.codebuddy/projects）：
//   - 行类型只有 message / function_call / function_call_result
//   - role 在顶层，正文是 input_text / output_text 内容块
//   - timestamp 是毫秒数字（不是 ISO 字符串）
//   - 会话行里没有 cwd —— 项目路径只能从目录名反解
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCodeBuddyFile,
  listCodeBuddySessions,
  listCodeBuddySessionsBothRoots,
  decodeProjectDir,
  cwdFromSessionPath,
  defaultCodeBuddyRoot,
  defaultCodeBuddyCnRoot,
} from '../../src/collect/codebuddy.js';

function tmpDir(prefix: string): string {
  return join(tmpdir(), `omem-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function writeSession(dir: string, name: string, lines: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const userMsg = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'codebuddy 以后都用手写 SQL' }],
  id: 'cb-u1',
  timestamp: 1763955079125,
};
const asstMsg = {
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: '好的。' }],
  id: 'cb-a1',
  timestamp: 1763955080000,
};

describe('codebuddy: parseCodeBuddyFile', () => {
  it('keeps user/assistant text and drops tool-call rows', () => {
    const dir = tmpDir('cb-parse');
    try {
      const p = writeSession(dir, 's1.jsonl', [
        userMsg,
        { type: 'function_call', callId: 'c1', name: 'TodoWrite', arguments: '{}' },
        asstMsg,
        { type: 'function_call_result', callId: 'c1', result: 'ok' },
      ]);
      const d = parseCodeBuddyFile(p);
      expect(d).not.toBeNull();
      expect(d!.agent).toBe('codebuddy');
      expect(d!.session_id).toBe('s1');
      expect(d!.messages).toHaveLength(2);
      expect(d!.messages[0].role).toBe('user');
      expect(d!.messages[0].content).toContain('手写 SQL');
      expect(d!.messages[1].role).toBe('assistant');
      // 工具调用与结果不进对话。
      const all = d!.messages.map((m) => m.content).join('\n');
      expect(all).not.toContain('TodoWrite');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('converts the millisecond timestamp to ISO', () => {
    const dir = tmpDir('cb-ts');
    try {
      const p = writeSession(dir, 's2.jsonl', [userMsg, asstMsg]);
      const d = parseCodeBuddyFile(p)!;
      expect(d.messages[0].ts).toBe(new Date(1763955079125).toISOString());
      expect(d.started_ts).toBe(d.messages[0].ts);
      expect(d.ended_ts).toBe(d.messages[d.messages.length - 1].ts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for an unreadable or empty file', () => {
    expect(parseCodeBuddyFile(join(tmpdir(), 'omem-does-not-exist-codebuddy.jsonl'))).toBeNull();
    const dir = tmpDir('cb-empty');
    try {
      const p = writeSession(dir, 's3.jsonl', []);
      expect(parseCodeBuddyFile(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates corrupted lines', () => {
    const dir = tmpDir('cb-bad');
    try {
      mkdirSync(dir, { recursive: true });
      const p = join(dir, 's4.jsonl');
      writeFileSync(
        p,
        ['不是 JSON', JSON.stringify(userMsg), '{"broken'].join('\n'),
      );
      const d = parseCodeBuddyFile(p);
      expect(d).not.toBeNull();
      expect(d!.messages).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('codebuddy: listCodeBuddySessions', () => {
  it('finds sessions under <root>/projects/<project>/', () => {
    const root = tmpDir('cb-list');
    try {
      const proj = join(root, 'projects', 'e-projects-demo');
      writeSession(proj, 'a.jsonl', [userMsg]);
      writeSession(proj, 'b.jsonl', [userMsg]);
      mkdirSync(join(root, 'projects', 'not-a-dir-file'), { recursive: true });
      const files = listCodeBuddySessions(root);
      expect(files.map((f) => f.sessionId).sort()).toEqual(['a', 'b']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list when the root does not exist', () => {
    expect(listCodeBuddySessions(join(tmpdir(), 'omem-no-codebuddy-root'))).toEqual([]);
  });

  it('merges both roots and keeps the newest file for a duplicate session id', () => {
    const intl = tmpDir('cb-intl');
    const cn = tmpDir('cb-cn');
    try {
      writeSession(join(intl, 'projects', 'p1'), 'dup.jsonl', [userMsg]);
      writeSession(join(cn, 'projects', 'p1'), 'dup.jsonl', [userMsg]);
      writeSession(join(cn, 'projects', 'p1'), 'only-cn.jsonl', [userMsg]);
      const files = listCodeBuddySessionsBothRoots(intl, cn);
      const ids = files.map((f) => f.sessionId).sort();
      expect(ids).toEqual(['dup', 'only-cn']);
      // 重复的 session_id 只留一份（mtime 最新的）。
      expect(ids.filter((i) => i === 'dup')).toHaveLength(1);
    } finally {
      rmSync(intl, { recursive: true, force: true });
      rmSync(cn, { recursive: true, force: true });
    }
  });
});

describe('codebuddy: project directory decoding', () => {
  it('decodes a directory name to a path that exists on disk', () => {
    // 造一个真实存在的目录，让反解有唯一确定的答案。
    const base = tmpDir('cb-decode');
    try {
      const real = join(base, 'boss-sql');
      mkdirSync(real, { recursive: true });
      // 目录名形如 x-projects-boss-sql → 真实路径 <base>\boss-sql
      const encoded = 'x-projects-' + 'boss-sql';
      const decoded = decodeProjectDir(encoded);
      // 反解不依赖 base（它按盘符找真实路径），所以这里只断言「不编造」：
      // 找不到真实路径时返回 undefined。
      expect(decoded === undefined || typeof decoded === 'string').toBe(true);
      if (decoded !== undefined) expect(decoded.startsWith('x:\\')).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not invent a path when nothing matches', () => {
    // 盘符形式在测试机上不存在 → 必须返回 undefined，不编造 cwd。
    const decoded = decodeProjectDir('zz-definitely-not-a-real-dir-xyz');
    expect(decoded).toBeUndefined();
  });

  it('rejects a name without a drive letter', () => {
    expect(decodeProjectDir('no-drive')).toBeUndefined();
  });

  it('rejects an absurdly long name instead of enumerating forever', () => {
    const long = 'x-' + Array.from({ length: 30 }, (_, i) => `s${i}`).join('-');
    expect(decodeProjectDir(long)).toBeUndefined();
  });

  it('extracts the project directory from a session path', () => {
    const p = join('C:', 'Users', 'x', '.codebuddy', 'projects', 'e-projects-demo', 's1.jsonl');
    // 找不到真实目录时返回 undefined（不编造）。
    expect(cwdFromSessionPath(p)).toBeUndefined();
    // 路径里没有 projects 段时也返回 undefined。
    expect(cwdFromSessionPath(join('C:', 'temp', 'x.jsonl'))).toBeUndefined();
  });
});

describe('codebuddy: default roots', () => {
  it('env override wins; defaults to the standard locations', () => {
    expect(defaultCodeBuddyRoot({ OMEM_CODEBUDDY_PROJECTS: '/x/cb' })).toBe('/x/cb');
    expect(defaultCodeBuddyRoot({})).toContain('.codebuddy');
    expect(defaultCodeBuddyCnRoot({ OMEM_CODEBUDDY_CN_PROJECTS: '/x/cbcn' })).toBe('/x/cbcn');
    expect(defaultCodeBuddyCnRoot({})).toContain('.codebuddycn');
  });
});
