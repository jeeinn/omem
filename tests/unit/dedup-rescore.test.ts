// 去重命中时的补分（2026-11-02 裁定）。
//
// 场景来源：`save_memory` 经常在会话被 `omem sync` 收进来**之前**执行，这时引文锚不上，
// 只能落 0.35 `ungrounded`。正文没变，分数却过时了；而补采之后重发同样的正文会被
// body_hash 去重挡回来，`omem verify` 又只报告不改写——那条记忆永远停在 0.35。
//
// 这个文件钉住那条口子，以及它四个边界（每一条都是防「自己给自己涨分」）：
//   ① topic 必须相同  ② 必须带 evidence  ③ 只升不降  ④ 人工过目过的不碰。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../../src/core/index.js';
import { defaultConfig } from '../../src/core/config.js';
import { findByTopic } from '../../src/core/store.js';
import { parseEntry } from '../../src/core/entry.js';
import { reconfirm } from '../../src/core/lifecycle.js';
import { verifyConfidence } from '../../src/process/score.js';
import { writeSessionFile } from '../../src/collect/session-store.js';
import { handleTool } from '../../src/mcp/tools.js';
import type { ToolCtx } from '../../src/mcp/tools.js';
import { makeHome, cleanupHome } from './helpers.js';

const QUOTE = '年终奖打算全部投指数基金，不买单只股票';
const CONTENT = '年终奖全部投指数基金，不买单只股票，理由是长期胜率高';
const TOPIC = 'finance-income-v3';
const SESSION = 'finance-session-0001';

let home: string;
let index: OmemIndex;
let ctx: ToolCtx;

/** 写一份合成的会话文件（等价于 `omem sync` 把这次对话收进来）。 */
function addSession(quote = QUOTE, sessionId = SESSION): void {
  const body = `## user\n${quote}\n\n## assistant\n记下了。`;
  writeSessionFile(home, {
    session_id: sessionId,
    agent: 'claude-code',
    project_fp: 'local:abcd1234',
    started_ts: '2026-11-02T00:00:00.000Z',
    ended_ts: '2026-11-02T00:10:00.000Z',
    cwd: 'X:/x',
    messages: [
      {
        session_id: sessionId, agent: 'claude-code', ts: '2026-11-02T00:00:00.000Z',
        project_fp: 'local:abcd1234', role: 'user', content: quote,
      },
      {
        session_id: sessionId, agent: 'claude-code', ts: '2026-11-02T00:01:00.000Z',
        project_fp: 'local:abcd1234', role: 'assistant', content: '记下了。',
      },
    ],
  }, body, `hash-${sessionId}`);
  index.catchUp();
}

async function save(args: Record<string, any>) {
  const r = await handleTool('save_memory', args, ctx);
  return {
    text: r.content.map((c) => c.text).join('\n'),
    sc: r.structuredContent as Record<string, any>,
  };
}

/** 先落一条「会话还没收录」的 0.35，再把会话补进来。 */
async function writeThenCollect(): Promise<void> {
  const first = await save({ content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION, evidence: [QUOTE] });
  expect(first.sc.status).toBe('written');
  expect(first.sc.confidence).toBe(0.35);
  expect(first.sc.session_found).toBe(false);
  addSession();
}

function stored() {
  return findByTopic(home, TOPIC)!.entry;
}

beforeEach(() => {
  home = makeHome();
  index = new OmemIndex(home);
  ctx = { home, config: defaultConfig(), index };
});
afterEach(() => {
  index.close();
  cleanupHome(home);
});

describe('补分：会话补采之后，同正文重发即可自愈', () => {
  it('先落 0.35，补采后重发 → 0.55；正文一字不动，只刷新 frontmatter', async () => {
    await writeThenCollect();
    const bodyBefore = parseEntry(readFileSync(findByTopic(home, TOPIC)!.path, 'utf8'))!.body;

    const again = await save({ content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION, evidence: [QUOTE] });

    expect(again.sc.status).toBe('deduped');
    expect(again.sc.rescored).toMatchObject({ from: 0.35, to: 0.55, applied: true });
    expect(again.sc.confidence).toBe(0.55);
    expect(again.text).toContain('Confidence raised from 0.35 to 0.55');
    expect(again.text).toContain('the body was not written again');

    const after = stored();
    expect(after.fm.confidence).toBe(0.55);
    expect(after.fm.tags).not.toContain('ungrounded');
    expect(after.fm.evidence.join(' ')).toContain(QUOTE);
    // 正文没被重写（补分走的是元数据路径，不是整篇覆盖）
    expect(parseEntry(readFileSync(findByTopic(home, TOPIC)!.path, 'utf8'))!.body).toBe(bodyBefore);
  });

  it('补分之后账本就对上了：verify 从 understated 变成无差异', async () => {
    await writeThenCollect();

    // 补采之后、补分之前：账本能算出 0.55，落盘还是 0.35 —— 这正是「需要补分」的证据。
    const before = verifyConfidence(home, index);
    expect(before.drifts.map((d) => [d.topic, d.verdict])).toEqual([[TOPIC, 'understated']]);

    await save({ content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION, evidence: [QUOTE] });

    const after = verifyConfidence(home, index);
    expect(after.drifts).toEqual([]);
  });

  it('dry_run 只算分不写盘：报「会提到 0.55」，磁盘仍是 0.35', async () => {
    await writeThenCollect();

    const preview = await save({
      content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION, evidence: [QUOTE], dry_run: true,
    });

    expect(preview.sc.rescored).toMatchObject({ from: 0.35, to: 0.55, applied: false });
    expect(preview.text).toContain('Confidence would be raised from 0.35 to 0.55');
    expect(stored().fm.confidence).toBe(0.35);
  });
});

describe('补分的边界（防自助涨分）', () => {
  it('不带证据的重发不提分：pending-session 的 0.55 不能当跳板', async () => {
    await writeThenCollect();

    const again = await save({ content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION });

    expect(again.sc.status).toBe('deduped');
    expect(again.sc.rescored).toBeUndefined();
    // 落盘值没动，回执也不再报「假设分」
    expect(again.sc.confidence).toBe(0.35);
    expect(stored().fm.confidence).toBe(0.35);
  });

  it('写到另一个 topic 时不动原条目（写 A 不许改 B 的分数）', async () => {
    await writeThenCollect();

    const other = await save({
      content: CONTENT, topic: 'stock-picking', type: 'decision', session_id: SESSION, evidence: [QUOTE],
    });

    expect(other.sc.status).toBe('deduped');
    expect(other.sc.rescored).toBeUndefined();
    expect(other.sc.topic).toBe(TOPIC);
    expect(stored().fm.confidence).toBe(0.35);
  });

  it('人工过目过的 0.9 不会被覆盖，也不会被拉低', async () => {
    await writeThenCollect();
    await save({ content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION, evidence: [QUOTE] });
    reconfirm(home, index, TOPIC);
    expect(stored().fm.confidence).toBe(0.9);

    const again = await save({ content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION, evidence: [QUOTE] });

    expect(again.sc.rescored).toBeUndefined();
    expect(again.sc.confidence).toBe(0.9);
    expect(stored().fm.confidence).toBe(0.9);
    expect(stored().fm.confirmations).toBe(1);
  });

  it('分数不变的重发不写盘（同分不抖 git）', async () => {
    addSession();
    const first = await save({ content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION, evidence: [QUOTE] });
    expect(first.sc.confidence).toBe(0.55);

    const again = await save({ content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION, evidence: [QUOTE] });

    expect(again.sc.rescored).toBeUndefined();
    expect(again.text).toContain('nothing was written again');
  });
});

describe('补分要有版本历史（一次写入一个 commit）', () => {
  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: home, encoding: 'utf8' }).trim();
  }
  function initRepo(): void {
    git(['init']);
    git(['config', 'user.name', 'omem-test']);
    git(['config', 'user.email', 'omem-test@localhost']);
    writeFileSync(join(home, '.gitignore'), 'index/\nsnapshots/\nlogs/\nPROCESS.md\n', 'utf8');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'chore: omem init']);
  }
  const commits = (): number => Number(git(['rev-list', '--count', 'HEAD']));

  it('补分也进 commit，并且提交里确实带上了那个文件', async () => {
    initRepo();
    await writeThenCollect();
    const before = commits();

    const again = await save({ content: CONTENT, topic: TOPIC, type: 'decision', session_id: SESSION, evidence: [QUOTE] });

    expect(again.sc.vcs).toMatchObject({ status: 'committed' });
    expect(commits() - before).toBe(1);
    const committed = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    expect(committed.some((f) => f.endsWith(`${TOPIC}.md`))).toBe(true);
    expect(git(['status', '--porcelain', '--', 'knowledge'])).toBe('');
  });
});
