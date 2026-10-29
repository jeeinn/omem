// commitEntry：三条写入路径的唯一提交点，以及 supersede 显式入口。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry, isRedactionShell } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { files } from '../../src/core/paths.js';
import { findById, listEntries } from '../../src/core/store.js';
import { searchEntries } from '../../src/core/search.js';
import { makeHome, cleanupHome, withConfig } from './helpers.js';
import { cmdAdd } from '../../src/commands/add.js';
import { cmdReview } from '../../src/commands/review.js';
import { handleTool } from '../../src/mcp/tools.js';
import { writeSessionFile } from '../../src/collect/session-store.js';
import type { OmemConfig } from '../../src/core/config.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  try { index.close(); } catch { /* 个别用例已关闭 */ }
  cleanupHome(home);
});

const CODE = 'function save() {\n  return 1;\n}\n';

function base(config?: OmemConfig) {
  return config ?? defaultConfig();
}

describe('commitEntry', () => {
  it('writes normally and refreshes the hot layer', () => {
    const r = commitEntry(home, base(), index, {
      content: '部署时改用国内镜像源',
      type: 'experience',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    expect(r.status).toBe('written');
    expect(r.id).toBeTruthy();
    expect(existsSync(files.memoryIndex(home))).toBe(true);
    expect(listEntries(home)).toHaveLength(1);
  });

  it('refreshIndex=false does not refresh the hot layer', () => {
    const r = commitEntry(home, base(), index, {
      content: '只落盘不刷新热层的句子',
      type: 'fact',
      source: 'rules',
      confidence: 0.4,
      verified: false,
    }, { refreshIndex: false });
    expect(r.status).toBe('written');
    expect(existsSync(files.memoryIndex(home))).toBe(false);
  });

  it('duplicate content is deduped', () => {
    const input = { content: '同一句话只记一次 dedup-marker', type: 'fact' as const, source: 'manual' as const, confidence: 0.9, verified: true };
    const a = commitEntry(home, base(), index, input);
    const b = commitEntry(home, base(), index, { ...input, source: 'agent', confidence: 0.6, verified: false });
    expect(a.status).toBe('written');
    expect(b.status).toBe('deduped');
    expect(b.id).toBe(a.id);
  });

  it('redacts secrets but leaves domain-sensitive words (no keyword filter remains)', () => {
    const saved = commitEntry(home, base(), index, {
      content: '我的 key 是 sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456，另外记下了薪资结构',
      type: 'fact',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    expect(saved.status).toBe('written');
    const stored = listEntries(home).find((l) => l.entry.fm.id === saved.id);
    expect(stored?.entry.body).toContain('***REDACTED***');
    expect(stored?.entry.body).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456');
    // exclude_keywords 已从配置移除：脱敏只覆盖密钥形态，中文业务敏感词原样落盘
    expect(stored?.entry.body).toContain('薪资结构');
  });

  it('work profile excludes code; home and force do not', () => {
    const config = withConfig(home, (c) => { c.general.profile = 'work'; });
    const prev = process.env.OMEM_PROFILE;
    delete process.env.OMEM_PROFILE;
    try {
      const blocked = commitEntry(home, config, index, {
        content: CODE,
        type: 'fact',
        source: 'agent',
        confidence: 0.6,
        verified: false,
      });
      expect(blocked.status).toBe('excluded');
      expect(blocked.reason).toContain('Code-heavy');
      const forced = commitEntry(home, config, index, {
        content: CODE,
        type: 'fact',
        source: 'agent',
        confidence: 0.6,
        verified: false,
      }, { force: true });
      expect(forced.status).toBe('written');
      const homeWrite = commitEntry(home, defaultConfig(), index, {
        content: 'function other() {\n  return 2;\n}\n',
        type: 'fact',
        source: 'manual',
        confidence: 0.9,
        verified: true,
        profile: 'home',
      });
      expect(homeWrite.status).toBe('written');
    } finally {
      if (prev === undefined) delete process.env.OMEM_PROFILE;
      else process.env.OMEM_PROFILE = prev;
    }
  });

  it('whole-secret entries dropped; force still redacts and does not bypass dedup', () => {
    expect(isRedactionShell('sk-ant-***REDACTED***')).toBe(true);
    const key = 'sk-ant-abc123def456ghi789jkl012mno345pqr678';
    const dropped = commitEntry(home, base(), index, {
      content: key,
      type: 'fact',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    }, { force: true });
    expect(dropped.status).toBe('redacted-empty');
    expect(listEntries(home)).toHaveLength(0);

    const kept = commitEntry(home, base(), index, {
      content: `注意 key 是 ${key} 别提交`,
      type: 'fact',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    }, { force: true });
    expect(kept.status).toBe('written');
    expect(kept.redacted).toBeGreaterThan(0);
    const body = listEntries(home)[0].entry.body;
    expect(body).not.toContain('abc123def456');
    expect(body).toContain('REDACTED');

    const again = commitEntry(home, base(), index, {
      content: `注意 key 是 ${key} 别提交`,
      type: 'fact',
      source: 'agent',
      confidence: 0.6,
      verified: false,
    }, { force: true });
    expect(again.status).toBe('deduped');
  });

  it('dry-run does not write to disk', () => {
    const r = commitEntry(home, base(), index, {
      content: '演练一条不会落盘的记忆',
      type: 'fact',
      source: 'rules',
      confidence: 0.4,
      verified: false,
    }, { dryRun: true });
    expect(r.status).toBe('written');
    expect(r.dryRun).toBe(true);
    expect(r.id).toBeUndefined();
    expect(listEntries(home)).toHaveLength(0);
  });

  it('a second write to the same topic must supersede the active document', () => {
    const first = commitEntry(home, base(), index, {
      content: '主题 omem 的第一版结论：事实源是 Markdown',
      type: 'decision',
      topic: 'omem',
      session_id: 's1',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    expect(first.status).toBe('written');
    const blocked = commitEntry(home, base(), index, {
      content: '主题 omem 的第二版结论：索引只是派生的',
      type: 'decision',
      topic: 'omem',
      session_id: 's2',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    expect(blocked.status).toBe('excluded');
    expect(blocked.id).toBe(first.id);
    const next = commitEntry(home, base(), index, {
      content: '主题 omem 的第二版结论：索引只是派生的',
      type: 'decision',
      topic: 'omem',
      session_id: 's2',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      supersedes: [first.id!],
    });
    expect(next.status).toBe('written');
    expect(findById(home, first.id!)!.entry.fm.status).toBe('superseded');
    expect(findById(home, next.id!)!.entry.fm.source_sessions.sort()).toEqual(['s1', 's2']);
    expect(searchEntries(index, { query: '事实源是 Markdown' })).toHaveLength(0);
    expect(searchEntries(index, { query: '索引只是派生' }).map((r) => r.id)).toContain(next.id);
  });

  it('project alone does not block a second memory, and topic is slugified', () => {
    const a = commitEntry(home, base(), index, {
      content: '项目 p1 的认证决策用短令牌',
      type: 'decision',
      project: 'p1',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    const b = commitEntry(home, base(), index, {
      content: '项目 p1 的部署踩坑改用国内源',
      type: 'experience',
      project: 'p1',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    expect(a.status).toBe('written');
    expect(b.status).toBe('written');
    expect(findById(home, a.id!)!.entry.fm.topic).toBeUndefined();
    const named = commitEntry(home, base(), index, {
      content: '膝盖康复每周两次力量训练',
      type: 'fact',
      topic: 'Knee Rehab',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    expect(findById(home, named.id!)!.entry.fm.topic).toBe('knee-rehab');
    const forced = commitEntry(home, base(), index, {
      content: '膝盖康复改成每周三次',
      type: 'fact',
      topic: 'knee rehab',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    }, { force: true });
    expect(forced.status).toBe('excluded');
    expect(forced.reason).toContain('--supersedes');
    expect(forced.reason).toContain('--force does not bypass');
    const text = readFileSync(files.memoryIndex(home), 'utf8');
    expect(text).toContain('topic:knee-rehab');
    expect(text).not.toContain('#knee');
  });

  it('supersedes marks old entries superseded; excluded by default, --all brings them back', () => {
    const old = commitEntry(home, base(), index, {
      content: '旧约定甲乙丙使用本地磁盘',
      type: 'decision',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    const neu = commitEntry(home, base(), index, {
      content: '新约定甲乙丙改用标准输出',
      type: 'decision',
      source: 'manual',
      confidence: 0.9,
      verified: true,
      supersedes: [old.id!],
    });
    expect(neu.status).toBe('written');
    expect(findById(home, old.id!)!.entry.fm.status).toBe('superseded');
    expect(findById(home, old.id!)!.entry.fm.superseded_by).toBe(neu.id);
    expect(searchEntries(index, { query: '甲乙丙使用本地磁盘' })).toHaveLength(0);
    expect(searchEntries(index, { query: '磁盘', all: false })).toHaveLength(0);
    expect(searchEntries(index, { query: '甲乙丙使用本地磁盘', all: true }).map((r) => r.id)).toContain(old.id);
    expect(searchEntries(index, { query: '磁盘', all: true }).map((r) => r.id)).toContain(old.id);
    expect(searchEntries(index, { query: '改用标准输出' }).map((r) => r.id)).toContain(neu.id);
  });
});

describe('three write paths share one channel', () => {
  it('add and save_memory dedup a second write', async () => {
    const prev = process.env.OMEM_HOME;
    process.env.OMEM_HOME = home;
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      const code = await cmdAdd({ _: ['通道去重句子 channel-dedup-xyz'], flags: {} });
      expect(code).toBe(0);
      const r = await handleTool('save_memory', { content: '通道去重句子 channel-dedup-xyz' }, {
        home, config: defaultConfig(), index,
      });
      expect(r.content.map((c) => c.text).join('\n')).toContain('nothing was written again');
    } finally {
      console.log = orig;
      if (prev === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prev;
    }
  });

  it('omem add 命中去重时说明元数据没写进去，并指路 topic set', async () => {
    // 审查二-2：CLI 侧此前只说 "already exists"，用户会以为 --topic 生效了。
    const prev = process.env.OMEM_HOME;
    process.env.OMEM_HOME = home;
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      await cmdAdd({ _: ['CLI 漂移句子 cli-drift-xyz'], flags: {} });
      logs.length = 0;
      const code = await cmdAdd({ _: ['CLI 漂移句子 cli-drift-xyz'], flags: { topic: 'cli-wanted', tags: 'tag-wanted' } });
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toContain('Metadata not applied');
      expect(out).toContain('cli-wanted');
      expect(out).toContain('tag-wanted');
      expect(out).toContain('omem topic set');
      // 没给 --topic / --tags 时不该误报
      logs.length = 0;
      await cmdAdd({ _: ['CLI 漂移句子 cli-drift-xyz'], flags: {} });
      expect(logs.join('\n')).not.toContain('Metadata not applied');
    } finally {
      console.log = orig;
      if (prev === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prev;
    }
  });

  it('save_memory.supersedes 与 review --confirm --supersedes', async () => {
    const prev = process.env.OMEM_HOME;
    process.env.OMEM_HOME = home;
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      const old = commitEntry(home, base(), index, {
        content: '将被 save 取代的旧偏好 save-old-marker',
        type: 'preference',
        source: 'manual',
        confidence: 0.9,
        verified: true,
      }, { refreshIndex: false });
      const saved = await handleTool('save_memory', {
        content: 'save 写入的新偏好 save-new-marker',
        supersedes: [old.id],
      }, { home, config: defaultConfig(), index });
      expect(saved.content[0].text).toContain('Superseded');
      expect(findById(home, old.id!)!.entry.fm.status).toBe('superseded');

      const candidate = commitEntry(home, base(), index, {
        content: '待确认后才取代的候选 review-new-marker',
        type: 'decision',
        source: 'rules',
        confidence: 0.4,
        verified: false,
      }, { refreshIndex: false });
      const target = commitEntry(home, base(), index, {
        content: 'review 要取代的旧条目 review-old-marker',
        type: 'decision',
        source: 'manual',
        confidence: 0.9,
        verified: true,
      }, { refreshIndex: false });
      const code = await cmdReview({
        _: [],
        flags: { confirm: candidate.id!, supersedes: target.id! },
      });
      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('Superseded');
      expect(findById(home, target.id!)!.entry.fm.status).toBe('superseded');
      expect(findById(home, candidate.id!)!.entry.fm.verified).toBe(true);
      expect(findById(home, candidate.id!)!.entry.fm.supersedes).toContain(target.id);
    } finally {
      console.log = orig;
      if (prev === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prev;
    }
  });
});

describe('commitEntry: 跨 topic 合并告警', () => {
  function writeTopic(content: string, topic: string): string {
    const r = commitEntry(home, base(), index, {
      content,
      type: 'fact',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      topic,
    }, { refreshIndex: false, refreshGuide: false });
    expect(r.status).toBe('written');
    return r.id!;
  }

  it('把两个旧主题合并进一个新主题时给出告警，列出消失的主题名', () => {
    const a = writeTopic('旧主题 A 的内容', 'matea-build-facts');
    const b = writeTopic('旧主题 B 的内容', 'matea-setup-wizard');

    const r = commitEntry(home, base(), index, {
      content: '合并后的新内容',
      type: 'fact',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      topic: 'matea-overview',
      supersedes: [a, b],
    }, { refreshIndex: false, refreshGuide: false });

    expect(r.status).toBe('written');
    const warnings = (r.warnings ?? []).join('\n');
    expect(warnings).toContain('Merged 2 topic(s)');
    expect(warnings).toContain('matea-build-facts');
    expect(warnings).toContain('matea-setup-wizard');
    expect(warnings).toContain('omem topic list --all');
  });

  it('同 topic 正常更新（supersede 自己那一版）不告警', () => {
    const old = writeTopic('第一版内容', 'pool-tuning');

    const r = commitEntry(home, base(), index, {
      content: '第二版内容',
      type: 'fact',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      topic: 'pool-tuning',
      supersedes: [old],
    }, { refreshIndex: false, refreshGuide: false });

    expect(r.status).toBe('written');
    expect(r.warnings ?? []).toEqual([]);
  });

  it('新文档不给 topic 却取代了有 topic 的旧文档 → 告警提示主题降级', () => {
    const old = writeTopic('有主题的旧内容', 'fm-cmp-rules');

    const r = commitEntry(home, base(), index, {
      content: '没主题的新内容',
      type: 'fact',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      supersedes: [old],
    }, { refreshIndex: false, refreshGuide: false });

    expect(r.status).toBe('written');
    const warnings = (r.warnings ?? []).join('\n');
    expect(warnings).toContain('without giving the new document a topic');
    expect(warnings).toContain('fm-cmp-rules');
  });

  it('未被取代的既有主题不受影响（无告警）', () => {
    writeTopic('另一个主题', 'other-topic');
    const r = commitEntry(home, base(), index, {
      content: '独立的新内容',
      type: 'fact',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      topic: 'brand-new',
    }, { refreshIndex: false, refreshGuide: false });

    expect(r.status).toBe('written');
    expect(r.warnings ?? []).toEqual([]);
  });

  it('omem add 把合并告警打到终端', async () => {
    const a = writeTopic('旧 A 内容', 'merge-a');
    const b = writeTopic('旧 B 内容', 'merge-b');
    index.close();

    const logs: string[] = [];
    const origLog = console.log;
    const prev = process.env.OMEM_HOME;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
    process.env.OMEM_HOME = home;
    try {
      const code = await cmdAdd({ _: ['合并后的新内容'], flags: { topic: 'merged', supersedes: `${a},${b}` } });
      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('Note: Merged 2 topic(s)');
    } finally {
      console.log = origLog;
      if (prev === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prev;
    }
  });
});

describe('commitEntry: 近似主题告警（Agent 路径同样有护栏）', () => {
  function seedTopic(content: string, topic: string): void {
    const r = commitEntry(home, base(), index, {
      content,
      type: 'fact',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      topic,
    }, { refreshIndex: false, refreshGuide: false });
    expect(r.status).toBe('written');
  }

  function writeWithTopic(topic: string) {
    return commitEntry(home, base(), index, {
      content: `关于 ${topic} 的结论`,
      type: 'fact',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      topic,
    }, { refreshIndex: false, refreshGuide: false });
  }

  it('新主题是既有主题的前缀扩展 → 告警，但照常写入', () => {
    seedTopic('既有主题的结论', 'fm-cmp-rules');

    const r = writeWithTopic('fm-cmp-rules-v2');

    expect(r.status).toBe('written');
    expect((r.warnings ?? []).join('\n')).toContain('is close to existing "fm-cmp-rules"');
  });

  it('去掉分隔符后相同 → 告警', () => {
    seedTopic('短横线主题', 'cost-log');

    const r = writeWithTopic('costlog');

    expect(r.status).toBe('written');
    const warnings = (r.warnings ?? []).join('\n');
    expect(warnings).toContain('is close to existing "cost-log"');
  });

  it('语义无关的新主题不告警', () => {
    seedTopic('连接池主题', 'pool-tuning');

    const r = writeWithTopic('deploy-pipeline');

    expect(r.warnings ?? []).toEqual([]);
  });

  it('同主题正常更新不触发近似检查（走 supersede 分支）', () => {
    seedTopic('第一版', 'fm-cmp-rules');
    const old = index.findActiveByTopic('fm-cmp-rules')!;

    const r = commitEntry(home, base(), index, {
      content: '第二版内容',
      type: 'fact',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      topic: 'fm-cmp-rules',
      supersedes: [old.id],
    }, { refreshIndex: false, refreshGuide: false });

    expect(r.status).toBe('written');
    expect(r.warnings ?? []).toEqual([]);
  });
});

describe('save_memory 回执与落盘一致（2026-10-28 实测回归）', () => {
  // 背景：驻留的旧 MCP 构建曾出现回执 0.4717/0.70 vs 落盘 0.35/0.55、
  // 全角标点证据静默 ungrounded、INSTRUCTION_TONE 减半三类症状。
  // 当前代码已无 tone 罚则（ad6305f），这里钉住新契约防止回归。
  const QUOTE_COMMA = '媳妇说想要大一点的车，六座或者七座的';

  function addCommaSession(sessionId: string): void {
    const body = `## user\n${QUOTE_COMMA}\n\n## assistant\n这是助手的回答。`;
    writeSessionFile(home, {
      session_id: sessionId, agent: 'workbuddy', project_fp: 'local:abcd1234',
      started_ts: '2026-10-27T00:00:00.000Z', ended_ts: '2026-10-27T00:10:00.000Z',
      cwd: 'X:/x',
      messages: [{
        session_id: sessionId, agent: 'workbuddy', ts: '2026-10-27T00:00:00.000Z',
        project_fp: 'local:abcd1234', role: 'user', content: QUOTE_COMMA,
      }],
    }, body, `hash-${sessionId}`);
    index.catchUp();
  }

  it('evidence 含全角标点仍锚定成功，回执与 frontmatter 同为 0.55', async () => {
    addCommaSession('punct-0001');
    const r = await handleTool('save_memory', {
      content: '全角标点证据回归测试 punctuation-regression-marker',
      session_id: 'punct-0001',
      evidence: QUOTE_COMMA,
    }, { home, config: defaultConfig(), index });
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status).toBe('written');
    expect(sc.confidence).toBe(0.55);
    expect(sc.tags).not.toContain('ungrounded');
    const fm = findById(home, sc.id)!.entry.fm;
    expect(fm.confidence).toBe(sc.confidence);
    expect(fm.tags).not.toContain('ungrounded');
  });

  it('锚定失败分支：回执 0.35 与 frontmatter 一致并带 ungrounded', async () => {
    addCommaSession('punct-0002');
    const r = await handleTool('save_memory', {
      content: '锚定失败分支回归测试 ungrounded-branch-marker',
      session_id: 'punct-0002',
      evidence: '这句话在会话里根本不存在 fake-evidence-xyz',
    }, { home, config: defaultConfig(), index });
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.confidence).toBe(0.35);
    expect(sc.tags).toContain('ungrounded');
    const fm = findById(home, sc.id)!.entry.fm;
    expect(fm.confidence).toBe(0.35);
    expect(fm.tags).toContain('ungrounded');
  });
});

// ── T02 / N2：2000 字上限只有一处裁决点，超限拒绝而不是截断 ──
describe('cap: over-limit content is rejected, never truncated', () => {
  const LIMIT = 2000;

  function textOf(r: Awaited<ReturnType<typeof handleTool>>): string {
    return r.content.map((c) => c.text).join('\n');
  }

  /** 造一份恰好 1990 字的活文档（cap 之下，允许写入）。 */
  function seedLiveDoc(topic: string): { id: string; body: string } {
    const base = '既存事实行。'.repeat(400).slice(0, LIMIT - 10);
    const r = commitEntry(home, base0(), index, {
      content: base,
      type: 'decision',
      topic,
      source: 'agent',
      confidence: 0.55,
      verified: false,
      overCap: 'reject',
    });
    expect(r.status).toBe('written');
    return { id: r.id!, body: base };
  }

  function base0(): OmemConfig {
    return defaultConfig();
  }

  it('N2 回归：1,990 字活文档追加 73 字新事实 → excluded，旧文档仍 active 且逐字未变', async () => {
    const topic = 'full-doc';
    const { id, body } = seedLiveDoc(topic);
    expect([...body].length).toBe(LIMIT - 10);

    // Agent 读到 1,990 字文档后把新事实并进去整篇重发（2063 字）
    const merged = `${body}\n99. 新增事实：指数退避与重试预算，失败三次后进入熔断并告警。`;
    expect([...merged].length).toBeGreaterThan(LIMIT);

    const r = await handleTool('save_memory', {
      content: merged, topic, supersedes: [id],
    }, { home, config: defaultConfig(), index });
    const sc = r.structuredContent as Record<string, any>;
    const text = textOf(r);

    // ① 拒绝，不是 Truncated
    expect(sc.status).toBe('excluded');
    expect(text).toContain(`Not written: content is ${[...merged].length.toLocaleString('en-US')} characters`);
    expect(text).not.toContain('Truncated');
    // ② 回执说清旧文档没被动过
    expect(text).toContain(`Nothing was superseded; ${id} is still active and unchanged.`);
    // ③ 溢出片段预览（仅回执，不落盘）
    expect(text).toContain('Over-cap preview (not written)');
    // ④ 两个出口
    expect(text).toContain('Options: (a) tighten the body');

    // 旧文档仍然 active，正文逐字未变，且没有被 supersede
    const live = findById(home, id)!;
    expect(live.entry.fm.status).toBe('active');
    expect(live.entry.body).toBe(body);
    expect(live.entry.fm.superseded_by).toBeUndefined();
    // 库里只有这一份，没有半截事实
    expect(listEntries(home)).toHaveLength(1);
  });

  it('2,800 字单次写入同样被拒绝，落盘 0 条', async () => {
    const r = await handleTool('save_memory', {
      content: '长'.repeat(2800), topic: 'over-cap-single',
    }, { home, config: defaultConfig(), index });
    expect((r.structuredContent as any).status).toBe('excluded');
    expect((r.structuredContent as any).over_cap).toMatchObject({ chars: 2800, limit: 2000, overflow: 800 });
    expect(listEntries(home)).toHaveLength(0);
    expect(textOf(r)).toContain('Not written: content is 2,800 characters, over the 2,000 limit by 800.');
  });

  it('全库扫描：没有 body 长度 == cap+1 且以 … 结尾的 active 文档（半截事实落盘数 = 0）', async () => {
    seedLiveDoc('scan-topic');
    await handleTool('save_memory', { content: '短正文正常写入 scan-marker' }, { home, config: defaultConfig(), index });
    const limit = defaultConfig().process.max_content_chars;
    const suspicious = listEntries(home).filter((l) => {
      const n = [...l.entry.body].length;
      return l.entry.fm.status === 'active' && (n === limit + 1 || n > limit) && l.entry.body.endsWith('…');
    });
    expect(suspicious).toHaveLength(0);
  });

  it('supersede 掉 verified 文档时回执写明旧 confidence 与旧 id（QA W4）', async () => {
    // omem add 写出 verified / 0.9 / source: manual
    const add = commitEntry(home, base0(), index, {
      content: '用户口头确认过的车贷方案 manual-verified-marker',
      type: 'decision',
      topic: 'car-loan',
      source: 'manual',
      confidence: 0.9,
      verified: true,
      overCap: 'reject',
    });
    expect(add.status).toBe('written');
    const oldId = add.id!;

    const r = await handleTool('save_memory', {
      content: '补充：4S 店承诺首保免费 supersede-verified-marker',
      topic: 'car-loan',
      supersedes: [oldId],
    }, { home, config: defaultConfig(), index });
    const text = textOf(r);
    expect(text).toContain('Saved');
    expect(text).toContain('Previous verified status (0.9) was dropped');
    expect(text).toContain(oldId);
    expect((r.structuredContent as any).superseded_verified).toEqual([{ id: oldId, confidence: 0.9 }]);
  });

  it('omem add 对超长内容改为拒绝（CLI 行为变更），--force 才截断', async () => {
    const long = '长'.repeat(2100);
    const prevHome = process.env.OMEM_HOME;
    process.env.OMEM_HOME = home;
    try {
      expect(await cmdAdd({ _: [long], flags: { topic: 'cli-cap' } })).toBe(0);
      expect(listEntries(home)).toHaveLength(0);

      expect(await cmdAdd({ _: [long], flags: { topic: 'cli-cap', force: true } })).toBe(0);
      const written = listEntries(home);
      expect(written).toHaveLength(1);
      expect([...written[0].entry.body].length).toBe(defaultConfig().process.max_content_chars + 1);
    } finally {
      if (prevHome === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prevHome;
    }
  });
});

// ── P1-6（beta.9.1）：--force 截断必须在磁盘之外留审计痕迹 ──
describe('force-truncate 的审计痕迹（不加 frontmatter、不加 tags）', () => {
  it('回执带 Force-truncated 说明，logs/omem.log 的 commit 事件带 id 与截断量', async () => {
    const long = '长'.repeat(2137);
    const result = commitEntry(home, defaultConfig(), index, {
      content: long,
      type: 'fact',
      source: 'manual',
      confidence: 0.9,
      verified: true,
      overCap: 'truncate',
    });

    expect(result.status).toBe('written');
    expect(result.truncated).toEqual({ chars: 2137, limit: 2000 });
    expect((result.warnings ?? []).join('\n')).toContain('Force-truncated: 137 character(s) were cut from the tail');

    // 日志里有 id + 截断量（审计入口），frontmatter 里没有新字段
    const logLines = readFileSync(files.usageLog(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const written = logLines.find((e) => e.event === 'commit' && e.id === result.id);
    expect(written?.truncated).toEqual({ chars: 2137, limit: 2000 });

    const fmKeys = Object.keys(findById(home, result.id!)!.entry.fm);
    expect(fmKeys).not.toContain('truncated');
    expect(findById(home, result.id!)!.entry.fm.tags).not.toContain('truncated');
  });

  it('omem add --force 在终端里把 id 指出来', async () => {
    const prevHome = process.env.OMEM_HOME;
    process.env.OMEM_HOME = home;
    try {
      const long = '冗'.repeat(2100);
      expect(await cmdAdd({ _: [long], flags: { topic: 'cli-force-audit', force: true } })).toBe(0);
      const [loc] = listEntries(home);
      const log = readFileSync(files.usageLog(home), 'utf8');
      expect(log).toContain(loc.entry.fm.id);
      expect(log).toContain('"truncated":{"chars":2100,"limit":2000}');
    } finally {
      if (prevHome === undefined) delete process.env.OMEM_HOME;
      else process.env.OMEM_HOME = prevHome;
    }
  });
});
