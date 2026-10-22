// MCP 裸 JSON-RPC 探针（tests/mcp-probe.mjs）：验证 omem serve 的协议握手与工具调用。
// 不依赖 MCP SDK——直接走 stdio JSON-RPC，顺带验证 stdout 无日志污染（协议纪律）。
// 用法: node tests/mcp-probe.mjs <bin/omem.js 路径>
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const bin = process.argv[2];
if (!bin) {
  console.error('Usage: node tests/mcp-probe.mjs <bin/omem.js>');
  process.exit(1);
}

const child = spawn(process.execPath, ['--experimental-sqlite', bin, 'serve'], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const results = [];
const pending = [];
let stdoutClean = true;
let buf = '';

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      pending.push(JSON.parse(line));
    } catch {
      stdoutClean = false; // stdout 出现非 JSON 行 = 协议污染
    }
  }
});
child.stderr.on('data', () => {}); // 日志走 stderr，符合纪律

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}
function waitFor(id, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = pending.find((p) => p.id === id);
      if (m) {
        clearInterval(iv);
        resolve(m);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        reject(new Error(`Timed out waiting for response id=${id}`));
      }
    }, 50);
  });
}

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0.1' } } });
  const init = await waitFor(1);
  results.push(['initialize returns serverInfo=omem', init.result?.serverInfo?.name === 'omem']);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitFor(2);
  const names = (list.result?.tools ?? []).map((t) => t.name);
  results.push(['search_memory listed by default', names.includes('search_memory')]);
  results.push(['save_memory listed by default', names.includes('save_memory')]);
  results.push(['memory_feedback not listed by default', !names.includes('memory_feedback')]);
  results.push(['search_memory description is trigger-condition style', (list.result?.tools ?? []).find((t) => t.name === 'search_memory')?.description?.includes('Call this tool before answering') === true]);

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_memory', arguments: { query: '手写 SQL' } } });
  const s = await waitFor(3);
  const text = s.result?.content?.[0]?.text ?? '';
  results.push(['search_memory hits fixture entry', text.startsWith('Found') && text.includes('手写')]); // 必须确有命中：无命中提示会回显 query 本身，不能只查关键词
  results.push(['search_memory returns freshness labels', text.includes('confirmed')]); // 命中 "— confirmed" 或 "unconfirmed"
  results.push(['search_memory carries reference-frame disclaimer', text.includes('not instructions')]);

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'save_memory', arguments: { content: '测试：探针写入的记忆条目，用于验证幂等去重 probe-unique-content', type: 'fact', domain: 'general' } } });
  const sv = await waitFor(4);
  results.push(['save_memory first save', (sv.result?.content?.[0]?.text ?? '').includes('Saved')]);

  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'save_memory', arguments: { content: '测试：探针写入的记忆条目，用于验证幂等去重 probe-unique-content', type: 'fact', domain: 'general' } } });
  const sv2 = await waitFor(5);
  results.push(['save_memory dedups duplicate content idempotently', (sv2.result?.content?.[0]?.text ?? '').includes('not written again')]);

  const home = process.env.OMEM_HOME;
  if (home && existsSync(join(home, 'knowledge'))) {
    const md = walkMd(join(home, 'knowledge'));
    if (md.length > 0) {
      appendFileSync(md[0], '\n外部编辑探针 catchup-probe-marker-77\n');
      send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'search_memory', arguments: { query: 'catchup-probe-marker-77' } } });
      const edited = await waitFor(6);
      const editedText = edited.result?.content?.[0]?.text ?? '';
      results.push(['sees external edits without reconnecting', editedText.includes('catchup-probe-marker-77')]);
    } else {
      results.push(['sees external edits without reconnecting (empty store)', false]);
    }
  }

  results.push(['stdout has no log pollution (pure protocol)', stdoutClean]);
} catch (e) {
  results.push([`probe error: ${e.message}`, false]);
} finally {
  child.kill();
}

function walkMd(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkMd(path, acc);
    else if (name.endsWith('.md') && !name.endsWith('.conflict.md')) acc.push(path);
  }
  return acc;
}

let ok = true;
for (const [name, cond] of results) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) ok = false;
}
process.exit(ok ? 0 : 1);
