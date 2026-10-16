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
const ABSENT = join(FIXTURE_ROOT, 'nonexistent');

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

function isolateOthers(config: ReturnType<typeof defaultConfig>) {
  config.collect.workbuddy_projects = ABSENT;
  config.collect.cursor_projects = ABSENT;
}

function cfgWithFixture() {
  const config = defaultConfig();
  config.collect.claude_projects = FIXTURE_ROOT;
  isolateOthers(config);
  saveConfig(home, config);
  return config;
}

describe('pipeline: runPipeline (ingest only)', () => {
  it('does not write rule fragments into knowledge', () => {
    const config = cfgWithFixture();
    const report = runPipeline(home, config, index, { tier: 'rules' });
    expect(report.tier).toBe('agent');
    expect(report.sessions).toBe(1);
    expect(report.candidates).toBe(0);
    expect(report.written).toHaveLength(0);
    expect(listEntries(home)).toHaveLength(0);
  });

  it('secrets are redacted in the session file', () => {
    const config = cfgWithFixture();
    runPipeline(home, config, index, {});
    const text = readFileSync(join(home, 'sessions', 'claude-code', 'sess-fixture-1.md'), 'utf8');
    expect(text).not.toContain('sk-ant-abc123');
    expect(text).toContain('REDACTED');
  });

  it('dialogue is searchable via --sessions, not as a conclusion', () => {
    const config = cfgWithFixture();
    runPipeline(home, config, index, {});
    expect(searchEntries(index, { query: '手写 SQL' })).toHaveLength(0);
  });

  it('second run: unchanged sessions skipped (sessions ledger)', () => {
    const config = cfgWithFixture();
    runPipeline(home, config, index, {});
    const r2 = runPipeline(home, config, index, {});
    expect(r2.sessions).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.written).toHaveLength(0);
  });

  it('returns immediately when paused', () => {
    const config = withConfig(home, (c) => {
      c.general.paused = true;
      c.collect.claude_projects = FIXTURE_ROOT;
      isolateOthers(c);
    });
    const report = runPipeline(home, config, index, {});
    expect(report.sessions).toBe(0);
    expect(report.notes[0]).toContain('Collection paused');
  });

  it('missing session directories give actionable hints', () => {
    const config = withConfig(home, (c) => {
      c.collect.claude_projects = ABSENT;
      isolateOthers(c);
    });
    const report = runPipeline(home, config, index, {});
    expect(report.sessions).toBe(0);
    expect(report.notes.some((n) => n.includes('OMEM_CLAUDE_PROJECTS'))).toBe(true);
    expect(report.notes.some((n) => n.includes('OMEM_WORKBUDDY_PROJECTS'))).toBe(true);
    expect(report.notes.some((n) => n.includes('OMEM_CURSOR_PROJECTS'))).toBe(true);
  });

  it('MEMORY-INDEX regenerated after run', () => {
    const config = cfgWithFixture();
    runPipeline(home, config, index, {});
    const text = readFileSync(files.memoryIndex(home), 'utf8');
    expect(text).toContain('MEMORY-INDEX');
    expect(text).toContain('active');
  });
});
