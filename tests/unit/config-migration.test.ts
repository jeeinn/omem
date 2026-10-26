// 配置残留与补写：用户以为的和实际的不一样，两种方向都要处理。
//
// 方向一（早已有）：config.toml 里留着已经失效的键（exclude_keywords、
// default_tier = "rules"）。处理方式是点名提示，不自动改文件——自动改会
// 丢掉用户手写的未知键。
//
// 方向二（本文件新增）：config.toml 是旧版本写的，缺了新加的键（比如新采集器
// 的 *_projects）。运行时靠默认值兜底，功能正常，但用户看不见这个选项——
// 他不知道可以改，也不知道改的是什么。init 现在把缺失的键补写进去。
//
// 补写必须遵守项目的 TOML 纪律：文本级插入，不做 parse→serialize 全量往返
// （那会改键名语义、丢未知键、丢空表段）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { files } from '../../src/core/paths.js';
import {
  loadConfig,
  appendMissingConfigKeys,
  findMissingConfigKeys,
  findRemovedConfigKeys,
  serializeConfig,
} from '../../src/core/config.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;

beforeEach(() => {
  home = makeHome();
});
afterEach(() => {
  cleanupHome(home);
});

function writeConfig(text: string): void {
  mkdirSync(join(home), { recursive: true });
  writeFileSync(files.config(home), text, 'utf8');
}

describe('config: missing keys are reported', () => {
  it('reports every collector key missing from an old config', () => {
    writeConfig('[general]\nprofile = "home"\n\n[collect]\nclaude_projects = "~/.claude/projects"\n');
    const missing = findMissingConfigKeys(home);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((m) => m.includes('collect.catpaw_projects'))).toBe(true);
    expect(missing.some((m) => m.includes('collect.doubao_projects'))).toBe(true);
    expect(missing.some((m) => m.includes('collect.qoder_projects'))).toBe(true);
    // 已经存在的键不该被报成缺失。
    expect(missing.some((m) => m.includes('collect.claude_projects'))).toBe(false);
  });

  it('reports nothing for a current config', () => {
    const config = loadConfig(home);
    writeConfig(serializeConfig(config));
    expect(findMissingConfigKeys(home)).toEqual([]);
  });
});

describe('config: missing keys are appended without rewriting the file', () => {
  it('adds the missing collector keys', () => {
    writeConfig('[general]\nprofile = "home"\n\n[collect]\nclaude_projects = "~/.claude/projects"\n');
    const added = appendMissingConfigKeys(home);
    expect(added).toContain('collect.catpaw_projects');
    const text = readFileSync(files.config(home), 'utf8');
    expect(text).toContain('catpaw_projects = "~/.catpaw/projects"');
    expect(text).toContain('doubao_projects = "~/.doubao/sessions"');
    expect(text).toContain('qoder_cn_projects = "~/.qoder-cn"');
  });

  it('preserves the user hand-written unknown keys and their order', () => {
    // 项目纪律：TOML 写入必须文本级合并，禁止全量往返。
    const original = [
      '# 我的手写备注',
      '[general]',
      'profile = "home"',
      'my_custom_thing = "keep me"',
      '',
      '[collect]',
      'claude_projects = "~/.claude/projects"',
      'another_custom = 42',
      '',
      '[process]',
      'default_tier = "agent"',
      '',
      '[my_own_section]',
      'key = "value"',
      '',
    ].join('\n');
    writeConfig(original);
    appendMissingConfigKeys(home);
    const text = readFileSync(files.config(home), 'utf8');
    // 手写的东西一个都不能少，位置也不能乱。
    expect(text).toContain('# 我的手写备注');
    expect(text).toContain('my_custom_thing = "keep me"');
    expect(text).toContain('another_custom = 42');
    expect(text).toContain('[my_own_section]');
    expect(text).toContain('key = "value"');
    // 原有内容相对顺序不变。
    expect(text.indexOf('my_custom_thing')).toBeLessThan(text.indexOf('[collect]'));
    expect(text.indexOf('[collect]')).toBeLessThan(text.indexOf('[process]'));
    expect(text.indexOf('[process]')).toBeLessThan(text.indexOf('[my_own_section]'));
  });

  it('does not touch a config that already has every key', () => {
    const config = loadConfig(home);
    const original = serializeConfig(config);
    writeConfig(original);
    expect(appendMissingConfigKeys(home)).toEqual([]);
    expect(readFileSync(files.config(home), 'utf8')).toBe(original);
  });

  it('is idempotent: running twice adds nothing the second time', () => {
    writeConfig('[general]\nprofile = "home"\n\n[collect]\nclaude_projects = "~/.claude/projects"\n');
    const first = appendMissingConfigKeys(home);
    expect(first.length).toBeGreaterThan(0);
    const afterFirst = readFileSync(files.config(home), 'utf8');
    const second = appendMissingConfigKeys(home);
    expect(second).toEqual([]);
    expect(readFileSync(files.config(home), 'utf8')).toBe(afterFirst);
  });

  it('leaves the file alone when the target section is missing', () => {
    // 结构异常时不新建段——交给 init 的提示告诉用户缺什么。
    const original = '[general]\nprofile = "home"\n';
    writeConfig(original);
    expect(appendMissingConfigKeys(home)).toEqual([]);
    expect(readFileSync(files.config(home), 'utf8')).toBe(original);
  });

  it('the appended config still parses and loads correctly', () => {
    writeConfig('[general]\nprofile = "home"\n\n[collect]\nclaude_projects = "~/.claude/projects"\n');
    appendMissingConfigKeys(home);
    const loaded = loadConfig(home);
    expect(loaded.collect.catpaw_projects).toBe('~/.catpaw/projects');
    expect(loaded.collect.doubao_projects).toBe('~/.doubao/sessions');
    expect(loaded.collect.claude_projects).toBe('~/.claude/projects');
    expect(findMissingConfigKeys(home)).toEqual([]);
  });
});

describe('config: removed keys are still reported, not rewritten', () => {
  it('flags exclude_keywords and default_tier = "rules"', () => {
    writeConfig([
      '[general]',
      'profile = "home"',
      '',
      '[collect]',
      'exclude_keywords = ["foo"]',
      '',
      '[process]',
      'default_tier = "rules"',
      '',
    ].join('\n'));
    const removed = findRemovedConfigKeys(home);
    expect(removed.some((r) => r.includes('exclude_keywords'))).toBe(true);
    expect(removed.some((r) => r.includes('default_tier'))).toBe(true);
    // 方向一不改文件：失效的键留着，由用户自己删。
    expect(readFileSync(files.config(home), 'utf8')).toContain('exclude_keywords = ["foo"]');
  });
});
