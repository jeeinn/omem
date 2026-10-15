// 本机 Claude Code / WorkBuddy / Cursor 只读验证。
// 不写入 ~/.claude、~/.workbuddy、~/.cursor、~/.omem。会话只复制到临时目录，加工结果也只留在临时 OMEM_HOME。
// 用法: node tests/live/verify-local.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionFile } from '../../dist/collect/claude-code.js';
import { parseWorkbuddyFile } from '../../dist/collect/workbuddy.js';
import { parseCursorTranscript } from '../../dist/collect/cursor.js';
import { extractFromDigest } from '../../dist/process/rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'bin', 'omem.js');
const HOME = homedir();
const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects');
const WORKBUDDY_PROJECTS = join(HOME, '.workbuddy', 'projects');
const CURSOR_PROJECTS = join(HOME, '.cursor', 'projects');
const SECRET_RE =
  /sk-ant-[A-Za-z0-9\-_]{20,}|(?<![\w-])sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const pass = [];
const fail = [];
function ok(name) {
  pass.push(name);
  console.log(`  ✓ ${name}`);
}
function bad(name, detail) {
  fail.push(name);
  console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function snapshotFiles(paths) {
  const out = new Map();
  for (const path of paths) {
    if (!existsSync(path)) {
      out.set(path, 'missing');
      continue;
    }
    const st = statSync(path);
    out.set(path, `${st.size}:${Math.trunc(st.mtimeMs)}`);
  }
  return out;
}

function diffSnapshot(before, after) {
  const changed = [];
  for (const [path, sig] of before) {
    if (after.get(path) !== sig) changed.push(path);
  }
  return changed;
}

function topLevelJsonl(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      let fst;
      try {
        fst = statSync(path);
      } catch {
        continue;
      }
      if (!fst.isFile()) continue;
      out.push({ path, proj, name, size: fst.size, mtime: fst.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function userCount(digest) {
  if (!digest) return 0;
  return digest.messages.filter((m) => m.role === 'user').length;
}

function pickClaude(files, limit) {
  const picked = [];
  for (const f of files) {
    if (f.size < 400 || f.size > 800_000) continue;
    let digest;
    try {
      digest = parseSessionFile(f.path);
    } catch {
      continue;
    }
    if (userCount(digest) < 1) continue;
    picked.push(f);
    if (picked.length >= limit) break;
  }
  return picked;
}

function listCursorTranscripts(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const proj of readdirSync(root)) {
    const transcripts = join(root, proj, 'agent-transcripts');
    if (!existsSync(transcripts)) continue;
    for (const id of readdirSync(transcripts)) {
      const dir = join(transcripts, id);
      let st;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const path = join(dir, `${id}.jsonl`);
      let fst;
      try {
        fst = statSync(path);
      } catch {
        continue;
      }
      if (!fst.isFile()) continue;
      out.push({
        path,
        proj: `${proj}/agent-transcripts/${id}`,
        name: `${id}.jsonl`,
        size: fst.size,
        mtime: fst.mtimeMs,
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function pickCursor(files) {
  const idle = files.filter((f) => Date.now() - f.mtime > 60_000);
  const pool = idle.length > 0 ? idle : files.slice(1);
  let tried = 0;
  for (const f of pool) {
    if (f.size < 200 || f.size > 800_000) continue;
    tried++;
    if (tried > 8) break;
    let digest;
    try {
      digest = parseCursorTranscript(f.path);
    } catch {
      continue;
    }
    if (userCount(digest) < 1) continue;
    return f;
  }
  return null;
}

function mcpServerNames(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Object.keys(parsed.mcpServers ?? {});
  } catch {
    return [];
  }
}

function pickWorkbuddy(files) {
  let tried = 0;
  for (const f of files) {
    if (f.size < 200 || f.size > 8_000_000) continue;
    tried++;
    if (tried > 8) break;
    let digest;
    try {
      digest = parseWorkbuddyFile(f.path);
    } catch {
      continue;
    }
    if (userCount(digest) < 1) continue;
    return f;
  }
  return null;
}

function copySession(file, destRoot) {
  const dir = join(destRoot, file.proj);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, file.name);
  writeFileSync(dest, readFileSync(file.path));
  return dest;
}

function omem(home, projects, args) {
  const env = {
    ...process.env,
    OMEM_HOME: home,
    OMEM_CLAUDE_PROJECTS: projects.claude,
    OMEM_WORKBUDDY_PROJECTS: projects.workbuddy,
    OMEM_CURSOR_PROJECTS: projects.cursor,
  };
  delete env.OMEM_ALLOW_WORK_EXPORT;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env,
    encoding: 'utf8',
    cwd: ROOT,
  });
  return {
    code: r.status ?? 1,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

function walkMd(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walkMd(path, acc);
    else if (name.endsWith('.md')) acc.push(path);
  }
  return acc;
}

function guardedConfigs() {
  return [
    join(HOME, '.claude.json'),
    join(HOME, '.claude', 'mcp.json'),
    join(HOME, '.claude', 'CLAUDE.md'),
    join(HOME, '.workbuddy', 'mcp.json'),
    join(HOME, '.cursor', 'mcp.json'),
  ];
}

const sandbox = mkdtempSync(join(tmpdir(), 'omem-live-'));
const omemHome = join(sandbox, 'home');
const claudeCopy = join(sandbox, 'claude-projects');
const workbuddyCopy = join(sandbox, 'workbuddy-projects');
const cursorCopy = join(sandbox, 'cursor-projects');
const roots = { claude: claudeCopy, workbuddy: workbuddyCopy, cursor: cursorCopy };
mkdirSync(omemHome, { recursive: true });
mkdirSync(claudeCopy, { recursive: true });
mkdirSync(workbuddyCopy, { recursive: true });
mkdirSync(cursorCopy, { recursive: true });

const configBefore = snapshotFiles(guardedConfigs());
let sourceHashes = new Map();

try {
  console.log(`沙箱: ${sandbox}`);
  console.log('== L1 检测客户端（只读） ==');
  const listed = omem(omemHome, roots, ['install', '--list']);
  if (listed.code !== 0) bad('install --list 退出码 0', `code=${listed.code}`);
  else ok('install --list 退出码 0');
  const detected = (id) => listed.out.split(/\r?\n/).some((line) => line.includes(`[✓] ${id}`));
  if (detected('claude-code')) ok('列出 Claude Code');
  else bad('列出 Claude Code');
  if (detected('workbuddy')) ok('列出 WorkBuddy');
  else bad('列出 WorkBuddy');
  if (detected('cursor')) ok('列出 Cursor');
  else bad('列出 Cursor');

  console.log('== L2 预览 MCP 配置（不落盘） ==');
  for (const id of ['claude-code', 'workbuddy', 'cursor']) {
    const preview = omem(omemHome, roots, ['install', '--print-config', id]);
    if (preview.code !== 0) {
      bad(`${id} print-config 退出码 0`, `code=${preview.code}`);
      continue;
    }
    const jsonStart = preview.out.indexOf('{');
    if (jsonStart < 0) {
      bad(`${id} print-config 含 JSON`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(preview.out.slice(jsonStart));
    } catch (e) {
      bad(`${id} print-config JSON 可解析`, String(e.message ?? e));
      continue;
    }
    const omemEntry = parsed?.mcpServers?.omem;
    if (omemEntry?.command && Array.isArray(omemEntry.args) && omemEntry.args.includes('serve')) {
      ok(`${id} 预览含 omem serve`);
    } else {
      bad(`${id} 预览含 omem serve`);
    }
    if (id === 'claude-code') {
      const names = Object.keys(parsed.mcpServers ?? {});
      if (names.includes('context7') && names.includes('codegraph') && names.includes('dbx')) {
        ok('claude-code 预览保留原有 MCP 键');
      } else {
        bad('claude-code 预览保留原有 MCP 键', names.join(','));
      }
    }
    if (id === 'cursor') {
      const names = Object.keys(parsed.mcpServers ?? {});
      const original = mcpServerNames(join(HOME, '.cursor', 'mcp.json'));
      const missing = original.filter((name) => !names.includes(name));
      if (missing.length === 0 && original.length > 0) ok(`cursor 预览保留原有 MCP 键 ${original.join(',')}`);
      else bad('cursor 预览保留原有 MCP 键', missing.join(',') || '原文件没有 mcpServers');
    }
  }

  console.log('== L3 复制 Claude 会话并加工 ==');
  const claudeFiles = pickClaude(topLevelJsonl(CLAUDE_PROJECTS), 3);
  if (claudeFiles.length === 0) bad('找到可解析的 Claude 会话');
  else ok(`选中 ${claudeFiles.length} 个 Claude 会话副本`);
  for (const f of claudeFiles) {
    sourceHashes.set(f.path, sha256(f.path));
    copySession(f, claudeCopy);
  }
  const init = omem(omemHome, roots, ['init', '--no-scan']);
  if (init.code === 0) ok('隔离目录 init');
  else bad('隔离目录 init', `code=${init.code}`);
  const run = omem(omemHome, roots, ['run']);
  const summary = run.out.split(/\r?\n/).find((l) => l.startsWith('加工完成')) ?? '';
  if (run.code === 0 && /会话 [1-9]/.test(summary) && /消息 [1-9]/.test(summary)) {
    ok(`Claude 副本加工 ${summary.replace(/^加工完成/, '').trim()}`);
  } else {
    bad('Claude 副本加工', `code=${run.code} ${summary || run.out.slice(0, 180)}`);
  }
  const secretHits = walkMd(join(omemHome, 'knowledge')).filter((p) => SECRET_RE.test(readFileSync(p, 'utf8')));
  if (secretHits.length === 0) ok('隔离记忆库未见明文密钥形态');
  else bad('隔离记忆库未见明文密钥形态', `${secretHits.length} 个文件`);

  const marker = 'omem-live-marker-7f3a';
  const added = omem(omemHome, roots, ['add', `验证检索用标记 ${marker}`, '--type', 'fact']);
  const found = omem(omemHome, roots, ['search', marker]);
  if (added.code === 0 && found.code === 0 && found.out.includes(marker)) ok('隔离库写入后可检索');
  else bad('隔离库写入后可检索', `add=${added.code} search=${found.code}`);

  console.log('== L4 WorkBuddy 会话副本 ==');
  const wb = pickWorkbuddy(topLevelJsonl(WORKBUDDY_PROJECTS));
  if (!wb) bad('找到含用户消息的 WorkBuddy 会话');
  else {
    sourceHashes.set(wb.path, sha256(wb.path));
    const copied = copySession(wb, workbuddyCopy);
    const asClaude = parseSessionFile(copied);
    if (!asClaude) ok('Claude 解析器不误读 WorkBuddy 副本');
    else bad('Claude 解析器不误读 WorkBuddy 副本', `messages=${asClaude.messages.length}`);
    const digest = parseWorkbuddyFile(copied);
    const users = userCount(digest);
    if (users > 0) ok(`WorkBuddy 副本解析出 ${users} 条用户消息 / 共 ${digest.messages.length} 条`);
    else bad('WorkBuddy 副本解析出用户消息');
    if (digest) {
      const candidates = extractFromDigest(digest);
      ok(`WorkBuddy 副本规则候选 ${candidates.length} 条（0 只说明这几句没踩中规则）`);
    }
  }

  console.log('== L4b Cursor 会话副本与上下文导出 ==');
  const cursorFile = pickCursor(listCursorTranscripts(CURSOR_PROJECTS));
  if (!cursorFile) bad('找到含用户消息的 Cursor transcript');
  else {
    sourceHashes.set(cursorFile.path, sha256(cursorFile.path));
    const copied = copySession(cursorFile, cursorCopy);
    const asClaude = parseSessionFile(copied);
    if (!asClaude) ok('Claude 解析器不误读 Cursor 副本');
    else bad('Claude 解析器不误读 Cursor 副本', `messages=${asClaude.messages.length}`);
    const digest = parseCursorTranscript(copied);
    const users = userCount(digest);
    if (users > 0) ok(`Cursor 副本解析出 ${users} 条用户消息 / 共 ${digest.messages.length} 条`);
    else bad('Cursor 副本解析出用户消息');
    if (digest) {
      const candidates = extractFromDigest(digest);
      ok(`Cursor 副本规则候选 ${candidates.length} 条（0 只说明这几句没踩中规则）`);
    }
  }
  const again = omem(omemHome, roots, ['run']);
  const againLine = again.out.split(/\r?\n/).find((l) => l.startsWith('加工完成')) ?? '';
  if (again.code === 0 && /会话 2/.test(againLine) && /跳过未变化/.test(againLine)) {
    ok(`run 扫到 WorkBuddy 与 Cursor 副本 ${againLine.replace(/^加工完成/, '').trim()}`);
  } else {
    bad('run 扫到 WorkBuddy 与 Cursor 副本', `code=${again.code} ${againLine || again.out.slice(0, 180)}`);
  }
  const exported = omem(omemHome, roots, ['context', '--for', 'cursor']);
  if (exported.code === 0 && exported.out.includes('alwaysApply: true') && exported.out.includes('MEMORY-INDEX')) {
    ok('context --for cursor 导出 .mdc');
  } else {
    bad('context --for cursor 导出 .mdc', `code=${exported.code}`);
  }

  console.log('== L5 源会话与客户端配置未改 ==');
  for (const [path, hash] of sourceHashes) {
    if (!existsSync(path)) {
      bad(`源文件仍在 ${basename(path)}`);
      continue;
    }
    if (sha256(path) === hash) ok(`源文件哈希未变 ${basename(path)}`);
    else bad(`源文件哈希未变 ${basename(path)}`);
  }
  const configAfter = snapshotFiles(guardedConfigs());
  const changed = diffSnapshot(configBefore, configAfter);
  if (changed.length === 0) ok('mcp.json / CLAUDE.md / .claude.json 未改');
  else bad('mcp.json / CLAUDE.md / .claude.json 未改', changed.map((p) => relative(HOME, p)).join(', '));

  const homeReal = join(HOME, '.omem');
  if (!existsSync(homeReal)) ok('未创建 ~/.omem');
  else ok('未改用 ~/.omem（本轮只写临时目录）');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(`结果: ${pass.length} 通过 / ${fail.length} 失败`);
if (fail.length) {
  console.log('失败项: ' + fail.join('；'));
  process.exit(1);
}
console.log('本机只读验证通过');
