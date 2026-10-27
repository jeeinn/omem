// 主题级审阅策略生效：once 自动 assent 且不进队列、never 静默、低置信仍是安全阀。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { reconfirm } from '../../src/core/lifecycle.js';
import { findById } from '../../src/core/store.js';
import { loadTopicPolicies, policyPath, saveTopicPolicy } from '../../src/core/review-policy.js';
import { main } from '../../src/cli.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;
let index: OmemIndex;

function write(opts: {
  content: string;
  topic: string;
  confidence?: number;
  tags?: string[];
  supersedes?: string[];
}): string {
  const r = commitEntry(home, defaultConfig(), index, {
    content: opts.content,
    type: 'fact',
    source: 'agent',
    confidence: opts.confidence ?? 0.55,
    verified: false,
    topic: opts.topic,
    tags: opts.tags,
    supersedes: opts.supersedes,
  }, { refreshIndex: false, refreshGuide: false });
  expect(r.status).toBe('written');
  return r.id!;
}

function fmOf(id: string) {
  return findById(home, id, { includeArchived: true })!.entry.fm;
}

/** 捕获 cmdReview 的输出并走一遍 CLI 分发。 */
async function reviewOutput(): Promise<string> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  };
  process.env.OMEM_HOME = home;
  try {
    await main(['review']);
    return logs.join('\n');
  } finally {
    console.log = orig;
  }
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});

afterEach(() => {
  index.close();
  delete process.env.OMEM_HOME;
  cleanupHome(home);
});

describe('once 策略：自动 assent', () => {
  it('主题被审过之后，新版本置信度提底 0.8 并打 assent tag，但不设 verified', () => {
    const v1 = write({ content: '第一版内容', topic: 'pool' });
    reconfirm(home, index, v1);
    saveTopicPolicy(home, 'pool', 'once');

    const v2 = write({ content: '第二版内容', topic: 'pool', supersedes: [v1] });

    const fm = fmOf(v2);
    expect(fm.confidence).toBe(0.8);
    expect(fm.verified).toBe(false);
    expect(fm.tags).toContain('assent');
  });

  it('主题还没被审过时不做任何提分', () => {
    saveTopicPolicy(home, 'pool', 'once');

    const v1 = write({ content: '第一版内容', topic: 'pool' });

    const fm = fmOf(v1);
    expect(fm.confidence).toBe(0.55);
    expect(fm.tags).not.toContain('assent');
  });

  it('低置信条目即使主题审过也不自动提分（安全阀）', () => {
    const v1 = write({ content: '第一版内容', topic: 'pool' });
    reconfirm(home, index, v1);
    saveTopicPolicy(home, 'pool', 'once');

    const v2 = write({ content: '第二版内容', topic: 'pool', confidence: 0.28, supersedes: [v1] });

    const fm = fmOf(v2);
    expect(fm.confidence).toBe(0.28);
    expect(fm.tags).not.toContain('assent');
  });

  it('默认策略（always）下不自动提分', () => {
    const v1 = write({ content: '第一版内容', topic: 'pool' });
    reconfirm(home, index, v1);

    const v2 = write({ content: '第二版内容', topic: 'pool', supersedes: [v1] });

    expect(fmOf(v2).confidence).toBe(0.55);
  });
});

describe('审阅队列按策略静默', () => {
  it('once + 审过 → 新版本不进队列，并给出静默提示', async () => {
    const v1 = write({ content: '第一版内容', topic: 'pool' });
    reconfirm(home, index, v1);
    saveTopicPolicy(home, 'pool', 'once');
    const v2 = write({ content: '第二版内容', topic: 'pool', supersedes: [v1] });

    const text = await reviewOutput();

    expect(text).not.toContain(v2);
    expect(text).toContain('silenced by review.toml policy');
  });

  it('never → 无论是否审过都不进队列', async () => {
    saveTopicPolicy(home, 'noisy', 'never');
    const id = write({ content: '噪音主题内容', topic: 'noisy' });

    const text = await reviewOutput();

    expect(text).not.toContain(id);
  });

  it('once + 低置信 → 仍然进队列（安全阀优先于策略）', async () => {
    const v1 = write({ content: '第一版内容', topic: 'risky' });
    reconfirm(home, index, v1);
    saveTopicPolicy(home, 'risky', 'once');
    const v2 = write({ content: '低置信内容', topic: 'risky', confidence: 0.28, supersedes: [v1] });

    const text = await reviewOutput();

    expect(text).toContain(v2);
  });

  it('策略不涉及的主题照常进队列', async () => {
    saveTopicPolicy(home, 'other', 'never');
    const id = write({ content: '普通主题内容', topic: 'ordinary' });

    const text = await reviewOutput();

    expect(text).toContain(id);
  });
});

describe('cli: omem topic policy', () => {
  async function run(args: string[]): Promise<string> {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    };
    process.env.OMEM_HOME = home;
    try {
      await main(args);
      return logs.join('\n');
    } finally {
      console.log = orig;
    }
  }

  it('写入策略并回显', async () => {
    const out = await run(['topic', 'policy', 'pool', 'once']);

    expect(out).toContain('Policy for "pool": once');
    expect(loadTopicPolicies(home).get('pool')).toBe('once');
  });

  it('default 删除策略', async () => {
    saveTopicPolicy(home, 'pool', 'once');

    const out = await run(['topic', 'policy', 'pool', 'default']);

    expect(out).toContain('default (always)');
    expect(loadTopicPolicies(home).has('pool')).toBe(false);
  });

  it('非法策略值被拒绝', async () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(' '));
    };
    process.env.OMEM_HOME = home;
    try {
      const code = await main(['topic', 'policy', 'pool', 'sometimes']);
      expect(code).toBe(1);
      expect(errs.join('\n')).toContain('Unknown policy');
    } finally {
      console.error = origErr;
    }
  });

  it('topic list 的表格里带 POLICY 列', async () => {
    write({ content: '连接池内容', topic: 'pool' });
    saveTopicPolicy(home, 'pool', 'once');

    const out = await run(['topic', 'list']);

    expect(out).toContain('POLICY');
    expect(out).toContain('once');
  });
});

describe('review.toml 落在 OMEM_HOME 根目录', () => {
  it('路径可预测且随数据仓一起备份', () => {
    saveTopicPolicy(home, 'pool', 'never');
    expect(policyPath(home).startsWith(home)).toBe(true);
    expect(readFileSync(policyPath(home), 'utf8')).toContain('"pool" = "never"');
  });
});
