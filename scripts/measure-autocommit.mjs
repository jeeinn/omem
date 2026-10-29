// autoCommit 写入延迟增量测量（beta.9.1 / P1-1）。
// 用法：node scripts/measure-autocommit.mjs [sessions=1101]
// 复刻真实仓的「文件数」压力：sessions/ 下 N 份会议记录 + 一个已提交的 git 数据仓。
// 只调 handleTool（不经 server.ts 的 catchUp），因此测到的是纯写入 + 提交增量。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { OmemIndex } from 'file:///X:/omem/dist/core/index.js';
import { defaultConfig, saveConfig } from 'file:///X:/omem/dist/core/config.js';
import { ensureHome } from 'file:///X:/omem/dist/core/paths.js';
import { handleTool } from 'file:///X:/omem/dist/mcp/tools.js';

const SESSIONS = Number(process.argv[2] ?? 1101);
const home = mkdtempSync(join(tmpdir(), 'omem-perf-'));

function git(args) {
  return execFileSync('git', args, { cwd: home, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

ensureHome(home);
saveConfig(home, defaultConfig());
// 造 N 份会话文件（每份 ~1.5 KB），模拟真实仓的 sessions/ 规模
const dir = join(home, 'sessions', 'local');
mkdirSync(dir, { recursive: true });
const body = '## user\n随便一句话。\n\n## assistant\n回答。\n';
for (let i = 0; i < SESSIONS; i++) {
  writeFileSync(join(dir, `sess-${i}.md`), `---\nagent: local\nsession_id: s-${i}\nproject: local:x\nstarted: t\nended: t\nmessages: 2\ncontent_hash: h${i}\n---\n\n${body}`);
}
git(['init', '-q']);
git(['config', 'user.name', 'perf']);
git(['config', 'user.email', 'perf@localhost']);
writeFileSync(join(home, '.gitignore'), 'index/\nsnapshots/\nlogs/\nPROCESS.md\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'chore: omem init']);

const index = new OmemIndex(home);

async function timeWrites(label, autoCommit, runs) {
  const config = defaultConfig();
  config.process.auto_commit = autoCommit;
  index.catchUp();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await handleTool('save_memory', { content: `${label} 第 ${i} 条结论 probe-marker-${label}-${i}`, type: 'fact' }, { home, config, index });
    samples.push(Math.round(performance.now() - t0));
    if (r.isError) throw new Error(JSON.stringify(r.content));
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples, median: sorted[Math.floor(sorted.length / 2)] };
}

const off = await timeWrites('off', 'off', 4);
const on = await timeWrites('on', 'session', 4);
const commits = Number(git(['rev-list', '--count', 'HEAD']));

console.log(JSON.stringify({
  sessions: SESSIONS,
  'auto_commit=off': off,
  'auto_commit=session': on,
  deltaMedianMs: on.median - off.median,
  commitCount: commits,
}, null, 1));

index.close();
rmSync(home, { recursive: true, force: true });
