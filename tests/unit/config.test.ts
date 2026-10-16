// 配置测试：TOML 子集往返、枚举校验、默认值合并（规格 §2.1 config.toml）。
import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  defaultConfig,
  parseTomlSubset,
  serializeConfig,
  loadConfig,
  saveConfig,
  configPath,
} from '../../src/core/config.js';
import { makeHome, cleanupHome, withConfig } from './helpers.js';

describe('config: TOML subset', () => {
  it('parses sections / scalars / arrays / comments', () => {
    const p = parseTomlSubset(
      [
        '# 注释',
        '[general]',
        'profile = "work"  # 行尾注释',
        'paused = true',
        '[collect]',
        'exclude_keywords = ["薪资", "密码"]',
        '[sync.git]',
        'remote = ""',
      ].join('\n'),
    );
    expect(p.general.profile).toBe('work');
    expect(p.general.paused).toBe(true);
    expect(p.collect.exclude_keywords).toEqual(['薪资', '密码']);
    expect(p.sync.git.remote).toBe('');
  });

  it('serialize → load round-trip is stable', () => {
    const home = makeHome();
    try {
      const c = defaultConfig();
      c.general.profile = 'work';
      c.process.stale_after_days = 90;
      c.collect.exclude_keywords = ['机密', 'secret'];
      c.sync.git.remote = 'git@example.com:o/r.git';
      saveConfig(home, c);
      const back = loadConfig(home);
      expect(back.general.profile).toBe('work');
      expect(back.process.stale_after_days).toBe(90);
      expect(back.collect.exclude_keywords).toEqual(['机密', 'secret']);
      expect(back.sync.git.remote).toBe('git@example.com:o/r.git');
    } finally {
      cleanupHome(home);
    }
  });

  it('invalid enum values fall back to defaults (guards against config typos breaking runtime)', () => {
    const home = makeHome();
    try {
      writeFileSync(
        configPath(home),
        ['[general]', 'profile = "bogus"', '[process]', 'default_tier = "nope"', 'stale_after_days = -5', '[sync]', 'backend = "ftp"'].join('\n'),
      );
      const c = loadConfig(home);
      expect(c.general.profile).toBe('home');
      expect(c.process.default_tier).toBe('rules');
      expect(c.process.stale_after_days).toBe(180);
      expect(c.sync.backend).toBe('git');
    } finally {
      cleanupHome(home);
    }
  });

  it('missing config file returns defaults', () => {
    const home = makeHome();
    try {
      rmSync(configPath(home), { force: true });
      expect(loadConfig(home)).toEqual(defaultConfig());
    } finally {
      cleanupHome(home);
    }
  });

  it('withConfig helper write takes effect', () => {
    const home = makeHome();
    try {
      withConfig(home, (c) => {
        c.general.paused = true;
      });
      expect(readFileSync(configPath(home), 'utf8')).toContain('paused = true');
      expect(loadConfig(home).general.paused).toBe(true);
    } finally {
      cleanupHome(home);
    }
  });

  it('serializeConfig output round-trips through our own parser', () => {
    const c = defaultConfig();
    c.collect.exclude_paths = ['a', 'b'];
    const parsed = parseTomlSubset(serializeConfig(c));
    expect(parsed.collect.exclude_paths).toEqual(['a', 'b']);
    expect(parsed.general.profile).toBe('home');
    expect(parsed.sync.git.remote).toBe('');
  });
});
