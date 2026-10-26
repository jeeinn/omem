// PROCESS.md 刷新：写入结论后，待办清单必须立刻反映新状态。
//
// 为什么需要这个文件（2026-10-26 审计发现的缺口）：PROCESS.md 是「还没被吸收的
// 会话」清单，但此前只在采集路径（omem sync）上重算。Agent 通过 MCP 的
// save_memory 吸收一个会话后，清单不会变——Agent 下次读到的是旧清单，会重复
// 处理已经吸收过的会话。
//
// 现在 commitEntry 在写入成功后重算清单（core/commit.ts → process/guide.ts）。
// 这里验证三件事：写入后清单立刻更新、批量路径不重复刷、刷新失败不影响写入。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { commitEntry } from '../../src/core/commit.js';
import { defaultConfig } from '../../src/core/config.js';
import { sessionKey } from '../../src/collect/session-store.js';
import { files } from '../../src/core/paths.js';
import { makeHome, cleanupHome } from './helpers.js';

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

function put(id: string, project: string): void {
  index.putSession({
    session_id: sessionKey('cursor', id),
    agent: 'cursor',
    path: `${home}/sessions/cursor/${id}.md`,
    content_hash: id,
    project_fp: project,
    msg_count: 1,
    last_ts: '2026-10-16T00:00:00.000Z',
    processed_at: '2026-10-16T00:00:00.000Z',
  }, `## user\n${id}`);
}

function guideText(): string {
  const p = files.processGuide(home);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

describe('PROCESS.md refresh after a write', () => {
  it('is rewritten after save_memory absorbs a session', () => {
    put('sess-1', 'proj-a');
    // 先跑一次采集路径，让清单存在并包含待办会话。
    commitEntry(home, defaultConfig(), index, {
      content: '一个还没吸收任何会话的占位结论',
      type: 'fact',
      source: 'agent',
      confidence: 0.5,
      verified: false,
    });
    expect(guideText()).toContain('sess-1');

    // 现在吸收它——清单必须立刻不再列出这个会话。
    commitEntry(home, defaultConfig(), index, {
      content: '吸收 sess-1 的结论',
      type: 'fact',
      session_id: 'sess-1',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    expect(guideText()).not.toContain('sess-1');
  });

  it('creates PROCESS.md on the first write when it does not exist yet', () => {
    expect(existsSync(files.processGuide(home))).toBe(false);
    commitEntry(home, defaultConfig(), index, {
      content: '第一条结论',
      type: 'fact',
      source: 'agent',
      confidence: 0.5,
      verified: false,
    });
    expect(existsSync(files.processGuide(home))).toBe(true);
    expect(guideText()).toContain('No topics are waiting');
  });

  it('refreshGuide: false leaves the guide untouched (batch path)', () => {
    put('sess-batch', 'proj-b');
    const before = guideText();
    commitEntry(home, defaultConfig(), index, {
      content: '批量路径写入的结论',
      type: 'fact',
      session_id: 'sess-batch',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    }, { refreshGuide: false });
    // 清单没有被重算：文件不存在（首次也没写）且内容不含新会话。
    expect(guideText()).toBe(before);
    expect(guideText()).not.toContain('sess-batch');
  });

  it('a failing guide refresh does not fail the write', () => {
    // 把 PROCESS.md 路径占成目录，让 atomicWrite 必然失败。
    const guidePath = files.processGuide(home);
    const { mkdirSync, rmSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(guidePath, { recursive: true });
    const result = commitEntry(home, defaultConfig(), index, {
      content: '清单刷新会失败的结论',
      type: 'fact',
      source: 'agent',
      confidence: 0.5,
      verified: false,
    });
    expect(result.status).toBe('written');
    expect(result.id).toBeTruthy();
    // 记忆确实落盘了。
    expect(existsSync(join(home, 'knowledge'))).toBe(true);
    rmSync(guidePath, { recursive: true, force: true });
  });

  it('the guide points at the newest document after a superseding write', () => {
    // 分组里留一个未吸收的会话，清单才会列出这一组；
    // 此时 Current document 应指向最新那份活文档（不是被 supersede 掉的旧版）。
    put('sess-old', 'proj-c');
    put('sess-pending', 'proj-c');
    const first = commitEntry(home, defaultConfig(), index, {
      content: 'proj-c 的第一版活文档',
      type: 'fact',
      topic: 'proj-c-topic',
      session_id: 'sess-old',
      source: 'agent',
      confidence: 0.55,
      verified: false,
    });
    expect(first.id).toBeTruthy();
    const second = commitEntry(home, defaultConfig(), index, {
      content: 'proj-c 的第二版活文档，覆盖第一版',
      type: 'fact',
      topic: 'proj-c-topic',
      session_id: 'sess-old',
      source: 'agent',
      confidence: 0.55,
      verified: false,
      supersedes: [first.id!],
    });
    expect(second.id).toBeTruthy();
    const text = guideText();
    expect(text).toContain('sess-pending');
    expect(text).toContain(second.id!);
    expect(text).not.toContain('Current document: none');
  });
});
