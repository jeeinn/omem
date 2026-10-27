// omem review --ui 的编排：提示 → 等 Enter → 开浏览器 → 阻塞等提交 → 快照 → 落盘 → 打印。
//
// 交互语义（用户 2026-10-27 定案）：
// - 终端 Enter 只是「授权打开浏览器」，不是提交。提交的唯一入口是页面按钮。
// - Ctrl+C 任何时刻都是关闭服务、零写入、退出码 0。
// - 超时同样是零写入。
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import type { OmemIndex } from '../core/index.js';
import type { Located } from '../core/store.js';
import { applyReviewDecisions } from '../core/lifecycle.js';
import type { ReviewOutcome } from '../core/lifecycle.js';
import { runSnapshot } from '../core/snapshot.js';
import { appendLog } from '../core/log.js';
import { buildReviewItem, buildSessionIndex } from '../web/review-data.js';
import { startReviewServer } from '../web/review-server.js';

export interface RunReviewUiArgs {
  home: string;
  index: OmemIndex;
  /** 已按 --source / --topic 过滤后的队列。页面全量展示，不受 CLI 的 PAGE 限制。 */
  entries: Located[];
  noOpen: boolean;
  port: number;
  timeoutMs: number;
}

export const DEFAULT_UI_TIMEOUT_MS = 600_000;

/**
 * 等一次回车。非 TTY 环境（远程 SSH、CI）直接放行：
 * 此时浏览器可能在别的机器上，用户需要自己打开打印出来的 URL。
 */
function waitForEnter(prompt: string): Promise<boolean> {
  process.stdout.write(`${prompt} `);
  if (!process.stdin.isTTY) {
    console.log('(non-interactive: continuing without waiting)');
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', onSigint);
      rl.close();
      if (!value) console.log('');
      resolve(value);
    };
    const onSigint = (): void => finish(false);
    process.once('SIGINT', onSigint);
    rl.once('line', () => finish(true));
    rl.once('close', () => finish(false));
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, argv, { stdio: 'ignore' });
    child.on('error', () => {
      console.log(`Could not launch a browser. Open this URL manually:\n${url}`);
    });
    child.unref();
  } catch {
    console.log(`Could not launch a browser. Open this URL manually:\n${url}`);
  }
}

function printOutcomes(outcomes: ReviewOutcome[]): void {
  let ok = 0;
  let skipped = 0;
  let missing = 0;
  for (const o of outcomes) {
    if (o.status === 'ok') {
      ok++;
      const tail = o.verified ? 'verified' : o.confidence != null ? String(o.confidence) : '';
      console.log(`  ${o.applied.padEnd(8)} ${o.id}${tail ? `  ${tail}` : ''}`);
      continue;
    }
    if (o.status === 'missing') missing++;
    else skipped++;
    console.log(`  skipped  ${o.id}  — ${o.reason ?? o.status}`);
  }
  console.log('');
  console.log(`Applied ${ok} · skipped ${skipped} · missing ${missing}.`);
}

export async function runReviewUi(args: RunReviewUiArgs): Promise<number> {
  const items = args.entries.map((loc) => buildReviewItem(args.home, loc));
  const sessionIndex = buildSessionIndex(args.index);

  const server = await startReviewServer({
    home: args.home,
    items,
    sessionIndex,
    // 写盘前先打快照：批量确认一次能翻几十条 verified，留一个可回退点。
    onApply: (decisions) => {
      const snap = runSnapshot(args.home, 7);
      console.log(`Snapshot: ${snap.path}`);
      return applyReviewDecisions(args.home, args.index, decisions);
    },
    timeoutMs: args.timeoutMs,
    port: args.port,
  });

  console.log('');
  console.log(`Review UI is ready at ${server.url}`);
  console.log('(the token in the URL is one-time; closing this command invalidates it)');
  console.log('');

  const proceed = await waitForEnter('Press Enter to open it in your browser, Ctrl+C to cancel.');
  if (!proceed) {
    await server.close();
    console.log('Cancelled. Nothing was applied.');
    return 0;
  }

  if (args.noOpen) {
    console.log(`--no-open: open this URL yourself:\n${server.url}`);
  } else {
    openBrowser(server.url);
  }
  const minutes = Math.max(1, Math.round(args.timeoutMs / 60_000));
  console.log(`Waiting for your decisions in the browser… (timeout ${minutes}m)`);

  const result = await server.waitForResult();
  await server.close();

  if (!result) {
    console.log('Timed out. Nothing was applied.');
    return 0;
  }

  appendLog(args.home, 'review.ui.apply', {
    decisions: result.decisions.length,
    submitted_at: result.submittedAt,
  });
  console.log('');
  printOutcomes(result.outcomes);
  console.log('You can close the browser tab.');
  return 0;
}
