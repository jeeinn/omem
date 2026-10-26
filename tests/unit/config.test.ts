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
        c.general.profile = 'work';
      });
      expect(readFileSync(configPath(home), 'utf8')).toContain('profile = "work"');
      expect(loadConfig(home).general.profile).toBe('work');
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

  it('flags default_tier = "rules", which is silently read as agent', () => {
    const home = makeHome();
    try {
      saveConfig(home, defaultConfig());
      const p = `${home}/config.toml`;
      // beta.3 之前的默认值：rules 档已移除，pipeline 会静默按 agent 处理
      writeFileSync(p, readFileSync(p, 'utf8').replace('default_tier = "agent"', 'default_tier = "rules"'));
      const found = findRemovedConfigKeys(home);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('default_tier');
  // 运行时确实按 agent 走——这条提示只是提醒，不改变行为
      const cfg = loadConfig(home);
      expect(cfg.process.default_tier).toBe('agent');
    } finally {
      cleanupHome(home);
    }
  });

  it('says nothing once default_tier is the honest value', () => {
    const home = makeHome();
    try {
      const c = defaultConfig();
      c.process.default_tier = 'agent';
      saveConfig(home, c);
      expect(findRemovedConfigKeys(home)).toEqual([]);
    } finally {
      cleanupHome(home);
    }
  });
});

describe('config: [api] section (档 3 文档 §3.1)', () => {
  it('defaults: loopback base, empty key/model, locality-dependent fields unset, limit 20', () => {
    const api = defaultConfig().api;
    expect(api.base).toBe('http://localhost:11434/v1');
    expect(api.key).toBe('');
    expect(api.model).toBe('');
    expect(api.timeout_ms).toBe(0); // 0 = per-endpoint default
    expect(api.max_input_chars).toBe(0);
    expect(api.limit).toBe(20);
  });

  it('round-trips through serialize → load', () => {
    const home = makeHome();
    try {
      const c = defaultConfig();
      c.api.base = 'https://api.deepseek.com/v1';
      c.api.key = 'sk-abc123';
      c.api.model = 'deepseek-chat';
      c.api.timeout_ms = 60_000;
      c.api.max_input_chars = 12_000;
      c.api.limit = 50;
      saveConfig(home, c);
      const back = loadConfig(home);
      expect(back.api.base).toBe('https://api.deepseek.com/v1');
      expect(back.api.key).toBe('sk-abc123');
      expect(back.api.model).toBe('deepseek-chat');
      expect(back.api.timeout_ms).toBe(60_000);
      expect(back.api.max_input_chars).toBe(12_000);
      expect(back.api.limit).toBe(50);
    } finally {
      cleanupHome(home);
    }
  });

  it('V33: non-empty [api].key survives a pause/resume-style load → save rewrite', () => {
    const home = makeHome();
    try {
      const c = defaultConfig();
      c.api.key = 'sk-must-survive';
      saveConfig(home, c);
      // profile use / sync use 都走 loadConfig → 改一个无关字段 → saveConfig
      const again = loadConfig(home);
      again.general.profile = 'work';
      saveConfig(home, again);
      const third = loadConfig(home);
      expect(third.api.key).toBe('sk-must-survive');
      expect(third.api.base).toBe('http://localhost:11434/v1');
    } finally {
      cleanupHome(home);
    }
  });

  it('V33: hand-written [api] key in config.toml survives saveConfig rewrite', () => {
    const home = makeHome();
    try {
      const p = configPath(home);
      writeFileSync(p, readFileSync(p, 'utf8').replace('[search]', '[api]\nkey = "sk-handwritten"\nbase = "https://example.com/v1"\n\n[search]'));
      const parsed = loadConfig(home);
      expect(parsed.api.key).toBe('sk-handwritten');
      expect(parsed.api.base).toBe('https://example.com/v1');
      const again = loadConfig(home);
      again.general.profile = 'work';
      saveConfig(home, again);
      expect(loadConfig(home).api.key).toBe('sk-handwritten');
    } finally {
      cleanupHome(home);
    }
  });

  it('invalid numbers fall back to defaults; limit floor is 1', () => {
    const home = makeHome();
    try {
      const p = configPath(home);
      writeFileSync(p, readFileSync(p, 'utf8').replace('[search]', '[api]\ntimeout_ms = -5\nlimit = 0\nmax_input_chars = "oops"\n\n[search]'));
      const parsed = loadConfig(home);
      expect(parsed.api.timeout_ms).toBe(0);
      expect(parsed.api.limit).toBe(20);
      expect(parsed.api.max_input_chars).toBe(0);
    } finally {
      cleanupHome(home);
    }
  });

  it('unset timeout_ms / max_input_chars are written as comments, explicit values as lines', () => {
    const home = makeHome();
    try {
      const c = defaultConfig();
      saveConfig(home, c);
      const text = readFileSync(configPath(home), 'utf8');
      expect(text).toContain('# timeout_ms');
      expect(text).toContain('# max_input_chars');
      expect(text).not.toMatch(/^timeout_ms = /m);
      c.api.timeout_ms = 300_000;
      saveConfig(home, c);
      expect(readFileSync(configPath(home), 'utf8')).toMatch(/^timeout_ms = 300000/m);
    } finally {
      cleanupHome(home);
    }
  });
});
