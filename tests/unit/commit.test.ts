// commitEntry：三条写入路径的唯一提交点，以及 supersede 显式入口。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
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
  it('正常写入并刷新热层', () => {
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

  it('refreshIndex=false 不刷热层', () => {
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

  it('重复内容去重', () => {
    const input = { content: '同一句话只记一次 dedup-marker', type: 'fact' as const, source: 'manual' as const, confidence: 0.9, verified: true };
    const a = commitEntry(home, base(), index, input);
    const b = commitEntry(home, base(), index, { ...input, source: 'agent', confidence: 0.6, verified: false });
    expect(a.status).toBe('written');
    expect(b.status).toBe('deduped');
    expect(b.id).toBe(a.id);
  });

  it('禁区关键词排除，force 可绕过', () => {
    const config = withConfig(home, (c) => { c.collect.exclude_keywords = ['薪资']; });
    const blocked = commitEntry(home, config, index, {
      content: '讨论薪资结构时不要写进记忆',
      type: 'fact',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    });
    expect(blocked.status).toBe('excluded');
    expect(blocked.reason).toContain('薪资');
    const forced = commitEntry(home, config, index, {
      content: '讨论薪资结构时不要写进记忆',
      type: 'fact',
      source: 'manual',
      confidence: 0.9,
      verified: true,
    }, { force: true });
    expect(forced.status).toBe('written');
  });

  it('work profile 排除代码，home 与 force 不排除', () => {
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
      expect(blocked.reason).toContain('代码');
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

  it('整条密钥丢弃；force 仍脱敏且不绕过去重', () => {
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

  it('dry-run 不落盘', () => {
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

  it('supersedes 把旧条目标成 superseded，默认检索排除，--all 带回', () => {
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

describe('三条写入路径同通道', () => {
  it('add 与 save_memory 二次写入去重', async () => {
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
      expect(r.content.map((c) => c.text).join('\n')).toContain('未重复写入');
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
      expect(saved.content[0].text).toContain('已取代');
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
      expect(logs.join('\n')).toContain('已取代');
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
