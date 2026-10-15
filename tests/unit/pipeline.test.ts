// 加工流水线测试（评估 4.5 加工器）：抽取→脱敏→过滤→去重→落盘。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { runPipeline } from '../../src/process/pipeline.js';
import { searchEntries } from '../../src/core/search.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { listEntries } from '../../src/core/store.js';
import { files } from '../../src/core/paths.js';
import { makeHome, cleanupHome, withConfig } from './helpers.js';

const FIXTURE_ROOT = join(process.cwd(), 'tests', 'fixtures', 'claude-projects');

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
});
afterEach(() => {
  index.close();
  cleanupHome(home);
});

function cfgWithFixture() {
  const config = defaultConfig();
  config.collect.claude_projects = FIXTURE_ROOT;
  saveConfig(home, config);
  return config;
}

describe('pipeline: runPipeline（档 0）', () => {
  it('抽取候选并落盘（verified:false, source: rules）', () => {
    const config = cfgWithFixture();
    const report = runPipeline(home, config, index, {});
    expect(report.sessions).toBe(1);
    expect(report.candidates).toBeGreaterThanOrEqual(6);
    expect(report.written.length).toBeGreaterThanOrEqual(6);
    const entries = listEntries(home);
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const l of entries) {
      expect(l.entry.fm.verified).toBe(false);
      expect(l.entry.fm.source).toBe('rules');
      expect(l.entry.fm.status).toBe('active');
      expect(l.entry.fm.session_id).toBe('sess-fixture-1');
    }
  });

  it('密钥被脱敏后入库', () => {
    const config = cfgWithFixture();
    const report = runPipeline(home, config, index, {});
    expect(report.redacted).toBe(1);
    const bodies = listEntries(home).map((l) => l.entry.body).join('\n');
    expect(bodies).not.toContain('sk-ant-abc123');
    expect(bodies).toContain('REDACTED');
  });

  it('候选可被检索（trigram）', () => {
    const config = cfgWithFixture();
    runPipeline(home, config, index, {});
    const hits = searchEntries(index, { query: '手写 SQL' });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('二次运行：未变化会话被跳过（sessions 台账）', () => {
    const config = cfgWithFixture();
    runPipeline(home, config, index, {});
    const r2 = runPipeline(home, config, index, {});
    expect(r2.sessions).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.written).toHaveLength(0);
  });

  it('paused 时直接返回', () => {
    const config = withConfig(home, (c) => {
      c.general.paused = true;
      c.collect.claude_projects = FIXTURE_ROOT;
    });
    const report = runPipeline(home, config, index, {});
    expect(report.sessions).toBe(0);
    expect(report.notes[0]).toContain('暂停');
  });

  it('禁区关键词排除', () => {
    const config = withConfig(home, (c) => {
      c.collect.claude_projects = FIXTURE_ROOT;
      c.collect.exclude_keywords = ['踩坑'];
    });
    const report = runPipeline(home, config, index, {});
    expect(report.excluded).toBeGreaterThan(0);
    const bodies = listEntries(home).map((l) => l.entry.body).join('\n');
    expect(bodies).not.toContain('踩坑');
  });

  it('会话目录不存在时给出可操作提示', () => {
    const config = withConfig(home, (c) => {
      c.collect.claude_projects = join(FIXTURE_ROOT, 'nonexistent');
    });
    const report = runPipeline(home, config, index, {});
    expect(report.sessions).toBe(0);
    expect(report.notes[0]).toContain('OMEM_CLAUDE_PROJECTS');
  });

  it('MEMORY-INDEX 在 run 后重生成', () => {
    const config = cfgWithFixture();
    runPipeline(home, config, index, {});
    const text = readFileSync(files.memoryIndex(home), 'utf8');
    expect(text).toContain('MEMORY-INDEX');
    expect(text).toContain('active');
  });
});
