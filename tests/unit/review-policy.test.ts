// review.toml 的读写：最小 TOML 子集，且必须能容忍用户手写内容。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadTopicPolicies, policyPath, saveTopicPolicy } from '../../src/core/review-policy.js';
import { makeHome, cleanupHome } from './helpers.js';

let home: string;

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe('loadTopicPolicies', () => {
  it('文件不存在时返回空表（等价于全部 always）', () => {
    expect(loadTopicPolicies(home).size).toBe(0);
  });

  it('解析 [topics] 段，带引号与裸键都认', () => {
    writeFileSync(policyPath(home), ['[topics]', '"pool-tuning" = "once"', 'matea = "never"'].join('\n'));

    const map = loadTopicPolicies(home);

    expect(map.get('pool-tuning')).toBe('once');
    expect(map.get('matea')).toBe('never');
  });

  it('忽略注释、空行、未知策略值与段外的键', () => {
    writeFileSync(
      policyPath(home),
      [
        '# 我的策略',
        '[other]',
        'x = "once"',
        '',
        '[topics]',
        '',
        '# 这条写错了',
        '"a" = "sometimes"',
        '"b" = "always"',
      ].join('\n'),
    );

    const map = loadTopicPolicies(home);

    expect(map.has('x')).toBe(false);
    expect(map.has('a')).toBe(false);
    expect(map.get('b')).toBe('always');
  });
});

describe('saveTopicPolicy', () => {
  it('文件不存在时创建 [topics] 段', () => {
    saveTopicPolicy(home, 'pool', 'once');

    const text = readFileSync(policyPath(home), 'utf8');
    expect(text).toContain('[topics]');
    expect(text).toContain('"pool" = "once"');
    expect(loadTopicPolicies(home).get('pool')).toBe('once');
  });

  it('改已有键是替换而不是追加', () => {
    saveTopicPolicy(home, 'pool', 'once');
    saveTopicPolicy(home, 'pool', 'never');

    const text = readFileSync(policyPath(home), 'utf8');
    expect((text.match(/"pool"/g) ?? []).length).toBe(1);
    expect(loadTopicPolicies(home).get('pool')).toBe('never');
  });

  it('传 null 删除该条（回到默认 always）', () => {
    saveTopicPolicy(home, 'pool', 'once');
    saveTopicPolicy(home, 'pool', null);

    expect(loadTopicPolicies(home).has('pool')).toBe(false);
    expect(existsSync(policyPath(home))).toBe(true);
  });

  it('保留用户手写的注释与其他段', () => {
    writeFileSync(
      policyPath(home),
      ['# 顶部注释', '[other]', 'keep = 1', '', '[topics]', '"a" = "once"', ''].join('\n'),
    );

    saveTopicPolicy(home, 'b', 'never');

    const text = readFileSync(policyPath(home), 'utf8');
    expect(text).toContain('# 顶部注释');
    expect(text).toContain('keep = 1');
    expect(text).toContain('"a" = "once"');
    expect(text).toContain('"b" = "never"');
    expect(loadTopicPolicies(home).get('a')).toBe('once');
  });

  it('删除段内一条时不影响同段其他条目', () => {
    saveTopicPolicy(home, 'a', 'once');
    saveTopicPolicy(home, 'b', 'never');
    saveTopicPolicy(home, 'a', null);

    const map = loadTopicPolicies(home);
    expect(map.has('a')).toBe(false);
    expect(map.get('b')).toBe('never');
  });

  it('topic 名里的正则特殊字符不影响匹配', () => {
    saveTopicPolicy(home, 'a.b+c', 'once');
    saveTopicPolicy(home, 'a.b+c', 'never');

    const text = readFileSync(policyPath(home), 'utf8');
    expect((text.match(/a\.b\+c/g) ?? []).length).toBe(1);
    expect(loadTopicPolicies(home).get('a.b+c')).toBe('never');
  });
});
