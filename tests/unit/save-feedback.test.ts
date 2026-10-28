// 写入反馈的契约（2026-10-27）：一次写入必须能回答「写没写、锚没锚上、为什么被挡、下一步怎么走」。
// 这里锁的是文案里的可执行信息，不是措辞本身——但每条断言都对应一个曾经踩过的坑。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmemIndex } from '../../src/core/index.js';
import { handleTool } from '../../src/mcp/tools.js';
import { defaultConfig } from '../../src/core/config.js';
import type { ToolCtx } from '../../src/mcp/tools.js';
import { writeSessionFile } from '../../src/collect/session-store.js';
import { readEntryFile } from '../../src/core/store.js';
import { tailLog } from '../../src/core/log.js';
import { makeHome, cleanupHome } from './helpers.js';

const QUOTE = '服务注册失败时要回到开通流程重新走一遍';
let home: string;
let index: OmemIndex;
let ctx: ToolCtx;

function textOf(r: Awaited<ReturnType<typeof handleTool>>): string {
  return r.content.map((c) => c.text).join('\n');
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  ctx = { home, config: defaultConfig(), index };
  writeSessionFile(
    home,
    {
      session_id: 'probe-0001',
      agent: 'claude-code',
      project_fp: 'local:abcd1234',
      started_ts: '2026-10-27T00:00:00.000Z',
      ended_ts: '2026-10-27T00:10:00.000Z',
      cwd: 'X:/x',
      messages: [
        {
          session_id: 'probe-0001', agent: 'claude-code', ts: '2026-10-27T00:00:00.000Z',
          project_fp: 'local:abcd1234', role: 'user', content: QUOTE,
        },
      ],
    },
    `## user\n${QUOTE}`,
    'hash-probe-0001',
  );
  index.catchUp();
});

afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('save_memory: 锚定结果必须出现在响应里', () => {
  it('锚定成功时报出命中了几条、命中在哪个会话', async () => {
    const r = await handleTool('save_memory', {
      content: '注册失败要回开通流程', session_id: 'probe-0001', evidence: [QUOTE], topic: 'reg-flow',
    }, ctx);
    const text = textOf(r);
    expect(text).toContain('Grounded 1/1');
    expect(text).toContain('probe-0001');
    expect((r.structuredContent as any).anchors).toEqual({ total: 1, matched: 1 });
  });

  it('带 collector 前缀的 session_id 不再静默降档', async () => {
    const r = await handleTool('save_memory', {
      content: '带前缀的会话引用', session_id: 'claude-code:probe-0001', evidence: [QUOTE], topic: 'prefix-case',
    }, ctx);
    expect(textOf(r)).toContain('Grounded 1/1');
    expect((r.structuredContent as any).confidence).toBe(0.55);
    expect((r.structuredContent as any).session_found).toBe(true);
  });

  it('会话不存在时明确说出来，而不是只降分', async () => {
    const r = await handleTool('save_memory', {
      content: '引用了不存在的会话', session_id: 'probe-9999', evidence: [QUOTE], topic: 'ghost-case',
    }, ctx);
    const text = textOf(r);
    expect(text).toContain('is not in the collected set');
    expect((r.structuredContent as any).session_found).toBe(false);
  });

  it('逗号拼接的 session_id 被拆成主会话 + source_sessions', async () => {
    const r = await handleTool('save_memory', {
      content: '多会话吸收', session_id: 'probe-0001, probe-0002', evidence: [QUOTE], topic: 'multi-absorb',
    }, ctx);
    expect(textOf(r)).toContain('used the first as the primary session');
    const id = (r.structuredContent as any).id as string;
    const saved = readEntryFile(index.pathById(id)!);
    expect(saved?.fm.session_id).toBe('probe-0001');
    expect(saved?.fm.source_sessions).toContain('probe-0002');
  });
});

describe('save_memory: 拒绝与去重的文案要能执行', () => {
  it('topic 冲突时 MCP 文案只给 supersedes 形式，不出现 -- 前缀', async () => {
    const first = await handleTool('save_memory', { content: '第一版正文 alpha', topic: 'conflict-topic' }, ctx);
    expect(first.isError).toBeFalsy();
    const r = await handleTool('save_memory', { content: '第二版正文 beta', topic: 'conflict-topic' }, ctx);
    const text = textOf(r);
    expect(text).toContain('already has an active document');
    expect(text).toContain('supersedes: ["');
    expect(text).not.toContain('--force');
    expect(text).not.toContain('--supersedes');
  });

  it('supersedes 指向不存在的 id 时，同时给了 topic 就指出当前活文档', async () => {
    const first = await handleTool('save_memory', { content: '当前活文档正文 gamma', topic: 'hint-topic' }, ctx);
    const activeId = (first.structuredContent as any).id as string;
    const r = await handleTool('save_memory', {
      content: '内容不同 delta', topic: 'hint-topic', supersedes: ['2099-01-01-zzzzzz'],
    }, ctx);
    expect(textOf(r)).toContain('Old entries not found');
    expect(textOf(r)).toContain(activeId);
  });

  it('dedup 命中但 topic 不同时，说明元数据没写进去并给出两条出路', async () => {
    const first = await handleTool('save_memory', { content: '完全相同的正文 epsilon' }, ctx);
    const id = (first.structuredContent as any).id as string;
    const r = await handleTool('save_memory', { content: '完全相同的正文 epsilon', topic: 'wanted-topic' }, ctx);
    const text = textOf(r);
    expect(text).toContain('nothing was written again');
    expect(text).toContain('wanted-topic');
    expect(text).toContain(`supersedes: ["${id}"]`);
    expect((r.structuredContent as any).status).toBe('deduped');
  });

  it('未知参数被点名，并对看起来对的错名字给出别名', async () => {
    const r = await handleTool('save_memory', {
      content: '带臆造参数的写入 zeta', session_ids: ['x'], force: true,
    }, ctx);
    const text = textOf(r);
    expect(text).toContain('Ignored unknown argument(s)');
    expect(text).toContain('session_ids');
    expect(text).toContain('source_sessions');
  });

  it('非法 type 提示回落，不静默存成 fact', async () => {
    const r = await handleTool('save_memory', { content: '类型写错了 eta', type: 'note' }, ctx);
    expect(textOf(r)).toContain('stored as fact');
  });

  it('超长内容给出截断说明', async () => {
    const long = '很长'.repeat(1500);
    const r = await handleTool('save_memory', { content: long }, ctx);
    expect(textOf(r)).toContain('Truncated');
    expect((r.structuredContent as any).truncated).toBe(true);
  });
});

describe('save_memory: dry_run 的「不落盘」承诺', () => {
  it('dry_run 带着 confirm_ids 只预告，不动既有条目的置信度', async () => {
    const first = await handleTool('save_memory', { content: '待预演的正文 theta' }, ctx);
    const id = (first.structuredContent as any).id as string;
    const before = index.getById(id)!.confidence;
    const r = await handleTool('save_memory', { content: '预演的新正文 iota', dry_run: true, confirm_ids: [id] }, ctx);
    const text = textOf(r);
    expect(text).toContain('[dry-run] Would record assent');
    expect(text).not.toContain('Assent recorded');
    expect(index.getById(id)!.confidence).toBe(before);
    expect((r.structuredContent as any).confirmed).toBeUndefined();
    expect((r.structuredContent as any).dry_run).toBe(true);
    // 预演同样不该把正文写进库
    expect(index.db.prepare('SELECT id FROM entries').all()).toHaveLength(1);
  });

  it('去掉 dry_run 后同样的 confirm_ids 才真的生效', async () => {
    const first = await handleTool('save_memory', { content: '待确认的正文 kappa' }, ctx);
    const id = (first.structuredContent as any).id as string;
    const r = await handleTool('save_memory', { confirm_ids: [id] }, ctx);
    expect(textOf(r)).toContain('Assent recorded');
    expect(index.getById(id)!.confidence).toBeGreaterThanOrEqual(0.8);
    expect((r.structuredContent as any).confirmed).toEqual([id]);
  });
});

describe('save_memory: 锚定归因进审计日志', () => {
  it('commit 事件带 confidence / session_found / anchors', async () => {
    await handleTool('save_memory', {
      content: '审计归因的正文 lambda', session_id: 'probe-0001', evidence: [QUOTE], topic: 'audit-case',
    }, ctx);
    const ev = tailLog(home, 30)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.event === 'commit' && e.status === 'written');
    expect(ev).toBeTruthy();
    expect(ev!.confidence).toBe(0.55);
    expect(ev!.session_found).toBe(true);
    expect(ev!.anchors).toEqual({ total: 1, matched: 1 });
  });

  it('锚不上时日志与响应给出同一个结论', async () => {
    const r = await handleTool('save_memory', {
      content: '锚不上的正文 mu', session_id: 'probe-0001', evidence: ['这段引号里的话根本没在会话里出现过'], topic: 'audit-miss',
    }, ctx);
    expect(textOf(r)).toContain('Evidence did not match');
    const ev = tailLog(home, 30)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.event === 'commit' && e.status === 'written');
    expect(ev!.anchors).toEqual({ total: 1, matched: 0 });
    expect((ev!.tags as string[])).toContain('ungrounded');
  });
});

describe('save_memory: 去重漂移的口径与误伤', () => {
  it('请求的 tags 没写进既有条目时说出来', async () => {
    await handleTool('save_memory', { content: '完全相同的正文 nu' }, ctx);
    const r = await handleTool('save_memory', { content: '完全相同的正文 nu', tags: ['wanted-tag'] }, ctx);
    expect(textOf(r)).toContain('wanted-tag');
    expect((r.structuredContent as any).metadata_drift)
      .toEqual([expect.stringContaining('wanted-tag')]);
  });

  it('元数据一致时不虚报漂移', async () => {
    await handleTool('save_memory', { content: '一致的正文 xi', topic: 'same-topic', tags: ['t1'], type: 'decision' }, ctx);
    const r = await handleTool('save_memory', { content: '一致的正文 xi', topic: 'same-topic', tags: ['t1'], type: 'decision' }, ctx);
    expect((r.structuredContent as any).status).toBe('deduped');
    expect((r.structuredContent as any).metadata_drift).toEqual([]);
  });

  it('没给 type 时不因回落成 fact 而误报漂移', async () => {
    await handleTool('save_memory', { content: '经验类型的正文 omicron', type: 'experience' }, ctx);
    const r = await handleTool('save_memory', { content: '经验类型的正文 omicron' }, ctx);
    expect((r.structuredContent as any).metadata_drift).toEqual([]);
  });

  it('dry_run 预演命中去重时也报出会丢哪些元数据', async () => {
    await handleTool('save_memory', { content: '预演去重的正文 pi' }, ctx);
    const r = await handleTool('save_memory', { content: '预演去重的正文 pi', topic: 'preview-topic', dry_run: true }, ctx);
    expect(textOf(r)).toContain('Metadata that would be lost to content dedup');
    expect(textOf(r)).toContain('preview-topic');
  });
});
