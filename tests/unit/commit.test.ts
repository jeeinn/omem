// commitEntry：三条写入路径的唯一提交点。
//
// D1-B′ 之后的不变量（这组断言就是它们）：
//   - topic 是身份也是文件名：knowledge/<domain>/<topic>.md
//   - 同一 topic 再写一次 = 覆盖同一份文件（磁盘上永远 1 个），不再有 supersede 状态机
//   - 覆盖时继承 created / source_sessions / evidence，但置信度由本次写入决定
//   - topic 缺失 = 拒绝（不静默生成一个名字）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry, isRedactionShell } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { files, dirs } from '../../src/core/paths.js';
import { findByTopic, listEntries, moveToArchive } from '../../src/core/store.js';
import { searchEntries } from '../../src/core/search.js';
import { makeHome, cleanupHome, withConfig } from './helpers.js';
import { cmdAdd } from '../../src/commands/add.js';
import { handleTool } from '../../src/mcp/tools.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  process.env.OMEM_HOME = home;
  index = new OmemIndex(home);
});
afterEach(() => {
  try { index.close(); } catch { /* 个别用例已关闭 */ }
  delete process.env.OMEM_HOME;
  cleanupHome(home);
});

const CODE = 'function save() {\n  return 1;\n}\n';

describe('commitEntry: 基本写入', () => {
  it('写入落在 knowledge/<domain>/<topic>.md 并刷新热层', () => {
    const r = commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '部署时改用国内镜像源',
      type: 'experience',
      topic: 'Deploy Mirror',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    expect(r.status).toBe('written');
    expect(r.topic).toBe('deploy-mirror');
    expect(r.updated).toBe(false);
    expect(r.path!.startsWith(dirs.knowledge(home))).toBe(true);
    expect(r.path!.endsWith('deploy-mirror.md')).toBe(true);
    expect(existsSync(r.path!)).toBe(true);
    expect(existsSync(files.memoryIndex(home))).toBe(true);
    expect(listEntries(home)).toHaveLength(1);
  });

  it('topic 必填：缺了就拒绝，并给出可执行的下一步', () => {
    const r = commitEntry(home, defaultConfig(), index, {
      content: '没有主题的一句话',
      type: 'fact',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    } as any);
    expect(r.status).toBe('excluded');
    expect(r.reason).toContain('topic');
    expect(listEntries(home)).toHaveLength(0);
  });

  it('refreshIndex=false 不刷新热层', () => {
    const r = commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '只落盘不刷新热层的句子',
      type: 'fact',
      topic: 'hot-layer-skip',
      source: 'rules',
      confidence: 0.4,
      verified: false,
    }, { refreshIndex: false });
    expect(r.status).toBe('written');
    expect(existsSync(files.memoryIndex(home))).toBe(false);
  });
});

describe('commitEntry: 同一 topic 再写一次 = 覆盖', () => {
  it('磁盘上只有一个文件，回执说 updated，git 负责历史', () => {
    const first = commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '车贷利率 4.2%，1990 年起的旧合同',
      type: 'fact',
      topic: 'car-loan',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    const second = commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '车贷利率已降到 3.6%，2026 年重签',
      type: 'fact',
      topic: 'car-loan',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });

    expect(first.status).toBe('written');
    expect(second.status).toBe('written');
    expect(second.updated).toBe(true);
    expect(second.path).toBe(first.path);
    expect(listEntries(home)).toHaveLength(1);

    const body = readFileSync(second.path!, 'utf8');
    expect(body).toContain('3.6%');
    expect(body).not.toContain('4.2%');
  });

  it('覆盖继承 created / source_sessions / evidence，但置信度不继承', () => {
    commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '膝盖康复：先做静蹲，每天三组',
      type: 'experience',
      topic: 'knee-rehab',
      source: 'agent',
      confidence: 0.9,
      verified: true,
      session_id: 'session-a',
      source_sessions: ['session-a'],
      evidence: ['先做静蹲，每天三组'],
    });
    const before = findByTopic(home, 'knee-rehab')!;

    commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '膝盖康复：静蹲改为隔天，加单腿硬拉',
      type: 'experience',
      topic: 'knee-rehab',
      source: 'agent',
      confidence: 0.35,
      verified: false,
    });
    const after = findByTopic(home, 'knee-rehab')!;

    expect(after.entry.fm.created).toBe(before.entry.fm.created);
    expect(after.entry.fm.source_sessions).toContain('session-a');
    expect(after.entry.fm.evidence.join(' ')).toContain('先做静蹲');
    // 置信度与 verified 属于「这次写入」，不随主题继承
    expect(after.entry.fm.confidence).toBe(0.35);
    expect(after.entry.fm.verified).toBe(false);
  });

  it('归档后再写同一 topic：搬回 knowledge/，不留两份', () => {
    commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '旧计划：每周三次长跑',
      type: 'decision',
      topic: 'training-plan',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    const archived = findByTopic(home, 'training-plan')!;
    // 直接把它挪进 archive/ 并置 archived，模拟 omem review --dismiss
    moveToArchive(home, 'training-plan');
    expect(findByTopic(home, 'training-plan')).toBeNull();
    expect(findByTopic(home, 'training-plan', { includeArchived: true })).not.toBeNull();

    commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '新计划：每周两次长跑 + 一次游泳',
      type: 'decision',
      topic: 'training-plan',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });

    const after = findByTopic(home, 'training-plan', { includeArchived: true })!;
    expect(after.location).toBe('knowledge');
    expect(existsSync(archived.path)).toBe(true); // 回到了原来的 knowledge 路径
    expect(listEntries(home)).toHaveLength(1);
    expect(listEntries(home, { includeArchived: true })).toHaveLength(1);
  });
});

describe('commitEntry: 过滤与去重', () => {
  it('正文相同则去重，并报出既有 topic', () => {
    const input = {
      content: '同一句话只记一次 dedup-marker',
      type: 'fact' as const,
      source: 'manual' as const,
      confidence: 0.9,
      verified: true,
    };
    const a = commitEntry(home, defaultConfig(), index, { topic: 'auto',  ...input, topic: 'dedup-a' });
    const b = commitEntry(home, defaultConfig(), index, { topic: 'auto',  ...input, topic: 'dedup-b', source: 'agent', confidence: 0.6, verified: false });

    expect(a.status).toBe('written');
    expect(b.status).toBe('deduped');
    expect(b.topic).toBe(a.topic);
    expect(b.existing?.topic).toBe('dedup-a');
  });

  it('脱敏保留其它词；整条是密钥则丢弃；force 不绕过脱敏与去重', () => {
    const r = commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '部署用 OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345',
      type: 'experience',
      topic: 'deploy-secret',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    expect(r.status).toBe('written');
    expect(r.redacted).toBeGreaterThan(0);
    const body = readFileSync(r.path!, 'utf8');
    expect(body).toContain('部署用');
    expect(body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');

    const shell = commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789',
      type: 'fact',
      topic: 'only-secret',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    expect(shell.status).toBe('redacted-empty');
    expect(isRedactionShell('sk-ant-***REDACTED***')).toBe(true);

    const dup = commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: body.replace(/^---[\s\S]*?---\n/, '').trim(),
      type: 'experience',
      topic: 'deploy-secret',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    }, { force: true });
    expect(dup.status).toBe('deduped');
  });

  it('work profile 排除代码密集条目，force 可以放行', () => {
    const config = withConfig(home, (c) => { c.general.profile = 'work'; });
    const blocked = commitEntry(home, config, index, { topic: 'auto', 
      content: CODE,
      type: 'fact',
      topic: 'code-block',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    expect(blocked.status).toBe('excluded');

    const forced = commitEntry(home, config, index, { topic: 'auto', 
      content: CODE,
      type: 'fact',
      topic: 'code-block',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    }, { force: true });
    expect(forced.status).toBe('written');
  });

  it('dry-run 不落盘', () => {
    const r = commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '预演不写盘',
      type: 'fact',
      topic: 'dry-run',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    }, { dryRun: true });
    expect(r.status).toBe('written');
    expect(r.dryRun).toBe(true);
    expect(listEntries(home)).toHaveLength(0);
  });
});

describe('commitEntry: 主题护栏', () => {
  it('近似主题给警告但照常写入（拒绝会打断 Agent）', () => {
    commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: 'omem 的索引是可删除的派生物',
      type: 'fact',
      topic: 'omem-index',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    const r = commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: 'omem 的索引重建只要一条命令',
      type: 'fact',
      topic: 'omem-index-rebuild',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    expect(r.status).toBe('written');
    expect((r.warnings ?? []).join(' ')).toContain('close to');
  });

  it('超过字数上限：拒绝写入，旧文档逐字未变，回执指出它是谁', () => {
    const config = withConfig(home, (c) => { c.process.max_content_chars = 2000; });
    const first = commitEntry(home, config, index, { topic: 'auto', 
      content: '车贷'.repeat(1000), // 2000 字，正好在上限
      type: 'fact',
      topic: 'car-loan',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    const before = readFileSync(first.path!, 'utf8');

    const over = commitEntry(home, config, index, { topic: 'auto', 
      content: `${'车贷'.repeat(1000)}${'新增'.repeat(100)}`,
      type: 'fact',
      topic: 'car-loan',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });

    expect(over.status).toBe('excluded');
    expect(over.overCap?.limit).toBe(2000);
    expect(over.overCap?.activeTopic).toBe('car-loan');
    expect(readFileSync(first.path!, 'utf8')).toBe(before);
  });
});

describe('三条写路径共用一个提交点', () => {
  it('omem add 必须带 --topic；同 topic 第二次写入是覆盖', async () => {
    await expect(cmdAdd({ _: ['随手一记'], flags: {} } as any)).rejects.toThrow(/--topic/);

    const ok = await cmdAdd({ _: ['随手一记'], flags: { topic: 'scratch' } } as any);
    expect(ok).toBe(0);
    expect(listEntries(home)).toHaveLength(1);

    // 新开一个 index（add 自己开会话），再写同一 topic
    index.close();
    index = new OmemIndex(home);
    await cmdAdd({ _: ['随手一记，改过的版本'], flags: { topic: 'scratch' } } as any);
    expect(listEntries(home)).toHaveLength(1);
    expect(readFileSync(findByTopic(home, 'scratch')!.path, 'utf8')).toContain('改过');
  });

  it('save_memory 的 topic 必填，并且同一 topic 覆盖同一文件', async () => {
    const ctx = { home, config: defaultConfig(), index };
    const missing = await handleTool('save_memory', { content: '没有主题' }, ctx);
    expect(missing.isError).toBe(true);

    const first = await handleTool('save_memory', { content: 'Memory is markdown', topic: 'omem-shape' }, ctx);
    expect(first.isError).toBeFalsy();
    expect((first.structuredContent as any).topic).toBe('omem-shape');

    const second = await handleTool('save_memory', { content: 'Memory is markdown plus git', topic: 'omem-shape' }, ctx);
    expect((second.structuredContent as any).updated).toBe(true);
    expect(listEntries(home)).toHaveLength(1);
  });

  it('已删除的 supersedes 参数只作为未知参数提示，不影响写入', async () => {
    const ctx = { home, config: defaultConfig(), index };
    const r = await handleTool('save_memory', {
      content: 'topic 即身份',
      topic: 'd1-summary',
      supersedes: ['2026-10-15-a1b2c3'],
    }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content.map((c: any) => c.text).join(' ')).toContain('supersedes');
    expect((r.structuredContent as any).status).toBe('written');
  });

  it('检索以 topic 为句柄', () => {
    commitEntry(home, defaultConfig(), index, { topic: 'auto', 
      content: '主题就是文件名 search-handle',
      type: 'fact',
      topic: 'search-handle',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    expect(searchEntries(index, { topic: 'search-handle' }).map((r) => r.topic)).toEqual(['search-handle']);
    expect(searchEntries(index, { query: 'search-handle' }).map((r) => r.topic)).toContain('search-handle');
  });
});
