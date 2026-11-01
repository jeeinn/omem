// omem topics：主题是身份也是文件名，所以「改名」= 移动文件（D1-B′）。
//
// 这组断言钉住三件事：改名确实搬了文件且不留旧副本、重名会被拒绝而不是加后缀、
// dry-run 不动磁盘。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { writeEntry, readEntryFile } from '../../src/core/store.js';
import { newFrontmatter, serializeEntry } from '../../src/core/entry.js';
import type { Frontmatter } from '../../src/core/entry.js';
import { makeHome, cleanupHome } from './helpers.js';
import { cmdTopics } from '../../src/commands/topic.js';

let home: string;
let index: OmemIndex;

beforeEach(() => {
  home = makeHome();
  vi.stubEnv('OMEM_HOME', home);
  index = new OmemIndex(home);
});
afterEach(() => {
  index.close();
  vi.unstubAllEnvs();
  cleanupHome(home);
});

function seed(topic: string, fm: Partial<Frontmatter> = {}, body = `正文 ${topic}`): string {
  const entry = {
    fm: newFrontmatter({ topic, type: 'fact', domain: 'coding', verified: true, confidence: 0.9, ...fm }),
    body,
  };
  const { path, content } = writeEntry(home, entry);
  index.upsert(entry, path, content);
  return path;
}

const pathOf = (topic: string, domain = 'coding'): string => join(home, 'knowledge', domain, `${topic}.md`);

describe('omem topics rename', () => {
  it('改名 = 移动文件：新路径存在、旧路径消失、正文与置信度不变', async () => {
    const oldPath = seed('knee-rehab', {}, '先做静蹲，每天三组');

    const rc = await cmdTopics({ _: ['rename', 'knee-rehab', 'knee-recovery'], flags: {} });

    expect(rc).toBe(0);
    expect(existsSync(pathOf('knee-recovery'))).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
    const entry = readEntryFile(pathOf('knee-recovery'))!;
    expect(entry.fm.topic).toBe('knee-recovery');
    expect(entry.body).toBe('先做静蹲，每天三组');
    expect(entry.fm.confidence).toBe(0.9);
  });

  it('新名字会规范化（小写、空白折连字符）', async () => {
    seed('raw');

    const rc = await cmdTopics({ _: ['rename', 'raw', 'Fancy  New   Name'], flags: {} });

    expect(rc).toBe(0);
    expect(existsSync(pathOf('fancy-new-name'))).toBe(true);
    expect(existsSync(pathOf('raw'))).toBe(false);
  });

  it('目标名已存在时拒绝（不加后缀，否则一个主题会有两份）', async () => {
    seed('src-topic');
    seed('occupied');

    await expect(cmdTopics({ _: ['rename', 'src-topic', 'occupied'], flags: {} }))
      .rejects.toThrow(/already exists/);
    expect(existsSync(pathOf('src-topic'))).toBe(true);
  });

  it('旧主题不存在时报错', async () => {
    await expect(cmdTopics({ _: ['rename', 'nope', 'any'], flags: {} }))
      .rejects.toThrow(/Topic not found/);
  });

  it('dry-run 不动物磁盘', async () => {
    seed('preview-me');

    const rc = await cmdTopics({ _: ['rename', 'preview-me', 'renamed'], flags: { 'dry-run': true } });

    expect(rc).toBe(0);
    expect(existsSync(pathOf('preview-me'))).toBe(true);
    expect(existsSync(pathOf('renamed'))).toBe(false);
  });

  it('归档主题也能改名（在 archive/ 里移动）', async () => {
    seed('old-plan');
    const { moveToArchive } = await import('../../src/core/store.js');
    moveToArchive(home, 'old-plan');

    const rc = await cmdTopics({ _: ['rename', 'old-plan', 'retired-plan'], flags: {} });

    expect(rc).toBe(0);
    expect(existsSync(join(home, 'archive', 'coding', 'retired-plan.md'))).toBe(true);
    expect(existsSync(join(home, 'archive', 'coding', 'old-plan.md'))).toBe(false);
  });
});

describe('omem topics list', () => {
  it('列出主题名与标题，不再输出 id', async () => {
    seed('pool-tuning', {}, '连接池上限设为 20');
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      const rc = await cmdTopics({ _: [], flags: {} });
      expect(rc).toBe(0);
    } finally {
      console.log = orig;
    }
    const text = logs.join('\n');
    expect(text).toContain('pool-tuning');
    expect(text).toContain('TOPIC');
    // 不再有 id 列（身份就是 topic 本身）
    expect(text).not.toMatch(/\b\d{4}-\d{2}-\d{2}-[a-z0-9]{6}\b/);
  });
});
