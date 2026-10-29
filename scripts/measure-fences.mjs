// P0-2 取证：复刻「围栏不在段首」的形状，逐段把围栏里的 JSON 当 evidence，
// 断言全部拿不到 grounding（0.35 + ungrounded）。用法：node scripts/measure-fences.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OmemIndex } from 'file:///X:/omem/dist/core/index.js';
import { defaultConfig, saveConfig } from 'file:///X:/omem/dist/core/config.js';
import { ensureHome } from 'file:///X:/omem/dist/core/paths.js';
import { handleTool } from 'file:///X:/omem/dist/mcp/tools.js';

const home = mkdtempSync(join(tmpdir(), 'omem-fence-'));
ensureHome(home);
saveConfig(home, defaultConfig());

const dir = join(home, 'sessions', 'workbuddy');
mkdirSync(dir, { recursive: true });

// 6 份会话，共 22 个「围栏在段中」的 ## user 段（段首是 System 行）——QA 实测的真实形状
const SESSIONS = 6;
const PER_SESSION = [4, 4, 4, 4, 3, 3];
let fenceNo = 0;
const cases = [];
for (let s = 0; s < SESSIONS; s++) {
  const sessionId = `fence-${String(s).padStart(2, '0')}`;
  const parts = [];
  for (let k = 0; k < PER_SESSION[s]; k++) {
    const id = `openclaw-weixin:1775663373${String(fenceNo).padStart(3, '0')}`;
    const json = `{ "message_id": "${id}", "timestamp": "Wed 2026-04-08 23:4${k} GMT+8" }`;
    parts.push([
      '## user',
      `System: [2026-04-08 23:4${k} GMT+8] Exec completed (rapid-fox, code 0) :: build ok`,
      '',
      'Conversation info (untrusted metadata):',
      '```json',
      json,
      '```',
      '',
      `这是第 ${fenceNo} 段真人话：第二排座椅能放平吗`,
    ].join('\n'));
    parts.push(['## assistant', `回答 ${fenceNo}：能放平。`].join('\n'));
    cases.push({ sessionId, json });
    fenceNo++;
  }
  const body = parts.join('\n\n');
  writeFileSync(join(dir, `${sessionId}.md`), [
    '---', `agent: workbuddy`, `session_id: ${sessionId}`, 'project: local:fence',
    'started: 2026-04-08T23:40:00.000Z', 'ended: 2026-04-08T23:59:00.000Z',
    `messages: ${PER_SESSION[s] * 2}`, `content_hash: h-${sessionId}`, '---', '', body, '',
  ].join('\n'), 'utf8');
}

const index = new OmemIndex(home);
index.catchUp();

const config = defaultConfig();
let grounded = 0;
const details = [];
for (const [i, c] of cases.entries()) {
  const r = await handleTool('save_memory', {
    content: `围栏伪证探测 ${i} probe-fence-${i}`,
    session_id: c.sessionId,
    evidence: c.json,
  }, { home, config, index });
  const sc = r.structuredContent;
  if (sc.confidence !== 0.35) {
    grounded++;
    details.push({ session: c.sessionId, confidence: sc.confidence });
  }
}
// 对照组：围栏之后的真人话仍能锚定
const okRun = await handleTool('save_memory', {
  content: '真话仍可锚定 probe-fence-control',
  session_id: cases[0].sessionId,
  evidence: '这是第 0 段真人话：第二排座椅能放平吗',
}, { home, config, index });

console.log(JSON.stringify({
  sessions: SESSIONS,
  midSectionFences: cases.length,
  evidenceStillGrounded: grounded,
  details,
  controlGrounded: okRun.structuredContent.confidence,
  note: 'evidenceStillGrounded 必须为 0；controlGrounded 必须是 0.55',
}, null, 1));

index.close();
rmSync(home, { recursive: true, force: true });
