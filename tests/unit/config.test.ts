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
  splitTomlPath,
  findRemovedConfigKeys,
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
        'exclude_paths = ["node_modules", ".git"]',
        '[sync.git]',
        'remote = ""',
      ].join('\n'),
    );
    expect(p.general.profile).toBe('work');
    expect(p.general.paused).toBe(true);
    expect(p.collect.exclude_paths).toEqual(['node_modules', '.git']);
    expect(p.sync.git.remote).toBe('');
  });

  it('serialize → load round-trip is stable', () => {
    const home = makeHome();
    try {
      const c = defaultConfig();
      c.general.profile = 'work';
      c.process.stale_after_days = 90;
      c.collect.exclude_paths = ['机密', 'secret'];
      c.sync.git.remote = 'git@example.com:o/r.git';
      saveConfig(home, c);
      const back = loadConfig(home);
      expect(back.general.profile).toBe('work');
      expect(back.process.stale_after_days).toBe(90);
      expect(back.collect.exclude_paths).toEqual(['机密', 'secret']);
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
      expect(c.process.default_tier).toBe('agent');
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

describe('TOML subset: keys that real client configs actually use', () => {
  // codex config.toml 会写 `"gpt-5.2-codex" = "gpt-5.4"`，此前 key 正则不接受引号 → 整文件解析失败
  it('parses a double-quoted key', () => {
    const parsed = parseTomlSubset('"gpt-5.2-codex" = "gpt-5.4"\n');
    expect(parsed['gpt-5.2-codex']).toBe('gpt-5.4');
  });

  it('parses a single-quoted key and keeps bare keys working', () => {
    const parsed = parseTomlSubset("'weird key' = 1\nnormal_key = 2\n");
    expect(parsed['weird key']).toBe(1);
    expect(parsed.normal_key).toBe(2);
  });

  it('still rejects genuinely unparseable lines', () => {
    expect(() => parseTomlSubset('this is not toml\n')).toThrow(/cannot parse line/);
  });

  it('parses a full realistic snippet without throwing', () => {
    const text = [
      'model = "gpt-5"',
      '"gpt-5.2-codex" = "gpt-5.4"',
      '',
      '[model_providers.custom]',
      'base_url = "https://x"',
      '',
      "[projects.'E:\projects\boss-sql']",
      'trust_level = "trusted"',
    ].join('\n');
    const parsed = parseTomlSubset(text);
    expect(parsed.model).toBe('gpt-5');
    expect(parsed['gpt-5.2-codex']).toBe('gpt-5.4');
    expect(parsed.model_providers.custom.base_url).toBe('https://x');
    expect(parsed.projects['E:\projects\boss-sql'].trust_level).toBe('trusted');
  });
});

describe('splitTomlPath: quoted segments', () => {
  it('splits bare dotted paths', () => {
    expect(splitTomlPath('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('strips quotes and keeps dots inside them', () => {
    expect(splitTomlPath("projects.'E:\projects\my.app'")).toEqual(['projects', 'E:\projects\my.app']);
    expect(splitTomlPath('projects."a.b"')).toEqual(['projects', 'a.b']);
  });

  it('tolerates spaces around dots', () => {
    expect(splitTomlPath('a . b')).toEqual(['a', 'b']);
  });
});

describe('removed config keys are reported, not silently honoured', () => {
  it('flags a leftover exclude_keywords line', () => {
    const home = makeHome();
    try {
      saveConfig(home, defaultConfig());
      // 模拟 beta.1 用户升级后 config.toml 里的残留行
      const p = `${home}/config.toml`;
      const withLegacy = readFileSync(p, 'utf8').replace(
        '[collect]',
        '[collect]\nexclude_keywords = ["薪资"]',
      );
      writeFileSync(p, withLegacy);
      const found = findRemovedConfigKeys(home);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('exclude_keywords');
      // 关键：残留行不影响运行时——字段已从类型里移除，loadConfig 不再有它
      expect((loadConfig(home).collect as any).exclude_keywords).toBeUndefined();
    } finally {
      cleanupHome(home);
    }
  });

  it('reports nothing for a current config', () => {
    const home = makeHome();
    try {
      saveConfig(home, defaultConfig());
      expect(findRemovedConfigKeys(home)).toEqual([]);
    } finally {
      cleanupHome(home);
    }
  });
});
