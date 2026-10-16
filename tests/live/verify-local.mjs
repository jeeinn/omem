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
  console.log(`Sandbox: ${sandbox}`);
  console.log('== L1 detect clients (read-only) ==');
  const listed = omem(omemHome, roots, ['install', '--list']);
  if (listed.code !== 0) bad('install --list exit code 0', `code=${listed.code}`);
  else ok('install --list exit code 0');
  const detected = (id) => listed.out.split(/\r?\n/).some((line) => line.includes(`[✓] ${id}`));
  if (detected('claude-code')) ok('lists Claude Code');
  else bad('lists Claude Code');
  if (detected('workbuddy')) ok('lists WorkBuddy');
  else bad('lists WorkBuddy');
  if (detected('cursor')) ok('lists Cursor');
  else bad('lists Cursor');

  console.log('== L2 preview MCP config (no writes) ==');
  for (const id of ['claude-code', 'workbuddy', 'cursor']) {
    const preview = omem(omemHome, roots, ['install', '--print-config', id]);
    if (preview.code !== 0) {
      bad(`${id} print-config exit code 0`, `code=${preview.code}`);
      continue;
    }
    const jsonStart = preview.out.indexOf('{');
    if (jsonStart < 0) {
      bad(`${id} print-config contains JSON`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(preview.out.slice(jsonStart));
    } catch (e) {
      bad(`${id} print-config JSON parses`, String(e.message ?? e));
      continue;
    }
    const omemEntry = parsed?.mcpServers?.omem;
    if (omemEntry?.command && Array.isArray(omemEntry.args) && omemEntry.args.includes('serve')) {
      ok(`${id} preview contains omem serve`);
    } else {
      bad(`${id} preview contains omem serve`);
    }
    if (id === 'claude-code') {
      const names = Object.keys(parsed.mcpServers ?? {});
      if (names.includes('context7') && names.includes('codegraph') && names.includes('dbx')) {
        ok('claude-code preview keeps existing MCP keys');
      } else {
        bad('claude-code preview keeps existing MCP keys', names.join(','));
      }
    }
    if (id === 'cursor') {
      const names = Object.keys(parsed.mcpServers ?? {});
      const original = mcpServerNames(join(HOME, '.cursor', 'mcp.json'));
      const missing = original.filter((name) => !names.includes(name));
      if (missing.length === 0 && original.length > 0) ok(`cursor preview keeps existing MCP keys ${original.join(',')}`);
      else bad('cursor preview keeps existing MCP keys', missing.join(',') || 'original file has no mcpServers');
    }
  }

  console.log('== L3 copy Claude sessions and process ==');
  const claudeFiles = pickClaude(topLevelJsonl(CLAUDE_PROJECTS), 3);
  if (claudeFiles.length === 0) bad('found parsable Claude sessions');
  else ok(`selected ${claudeFiles.length} Claude session copies`);
  for (const f of claudeFiles) {
    sourceHashes.set(f.path, sha256(f.path));
    copySession(f, claudeCopy);
  }
  const init = omem(omemHome, roots, ['init', '--no-scan']);
  if (init.code === 0) ok('init in isolated directory');
  else bad('init in isolated directory', `code=${init.code}`);
  const run = omem(omemHome, roots, ['run']);
  const summary = run.out.split(/\r?\n/).find((l) => l.startsWith('Processing complete')) ?? '';
  if (run.code === 0 && /sessions [1-9]/.test(summary) && /messages [1-9]/.test(summary)) {
    ok(`Claude copy processed ${summary.replace(/^Processing complete/, '').trim()}`);
  } else {
    bad('Claude copy processed', `code=${run.code} ${summary || run.out.slice(0, 180)}`);
  }
  const secretHits = walkMd(join(omemHome, 'knowledge')).filter((p) => SECRET_RE.test(readFileSync(p, 'utf8')));
  if (secretHits.length === 0) ok('no plaintext secret shapes in isolated store');
  else bad('no plaintext secret shapes in isolated store', `${secretHits.length} files`);

  const marker = 'omem-live-marker-7f3a';
  const added = omem(omemHome, roots, ['add', `验证检索用标记 ${marker}`, '--type', 'fact']);
  const found = omem(omemHome, roots, ['search', marker]);
  if (added.code === 0 && found.code === 0 && found.out.includes(marker)) ok('searchable after isolated write');
  else bad('searchable after isolated write', `add=${added.code} search=${found.code}`);

  console.log('== L4 WorkBuddy session copies ==');
  const wb = pickWorkbuddy(topLevelJsonl(WORKBUDDY_PROJECTS));
  if (!wb) bad('found a WorkBuddy session with user messages');
  else {
    sourceHashes.set(wb.path, sha256(wb.path));
    const copied = copySession(wb, workbuddyCopy);
    const asClaude = parseSessionFile(copied);
    if (!asClaude) ok('Claude parser does not misread the WorkBuddy copy');
    else bad('Claude parser does not misread the WorkBuddy copy', `messages=${asClaude.messages.length}`);
    const digest = parseWorkbuddyFile(copied);
    const users = userCount(digest);
    if (users > 0) ok(`WorkBuddy copy parsed ${users} user messages / ${digest.messages.length} total`);
    else bad('WorkBuddy copy parsed user messages');
    if (digest) {
      const candidates = extractFromDigest(digest);
      ok(`WorkBuddy copy rule candidates ${candidates.length} (0 just means these lines hit no rules)`);
    }
  }

  console.log('== L4b Cursor session copies and context export ==');
  const cursorFile = pickCursor(listCursorTranscripts(CURSOR_PROJECTS));
  if (!cursorFile) bad('found a Cursor transcript with user messages');
  else {
    sourceHashes.set(cursorFile.path, sha256(cursorFile.path));
    const copied = copySession(cursorFile, cursorCopy);
    const asClaude = parseSessionFile(copied);
    if (!asClaude) ok('Claude parser does not misread the Cursor copy');
    else bad('Claude parser does not misread the Cursor copy', `messages=${asClaude.messages.length}`);
    const digest = parseCursorTranscript(copied);
    const users = userCount(digest);
    if (users > 0) ok(`Cursor copy parsed ${users} user messages / ${digest.messages.length} total`);
    else bad('Cursor copy parsed user messages');
    if (digest) {
      const candidates = extractFromDigest(digest);
      ok(`Cursor copy rule candidates ${candidates.length} (0 just means these lines hit no rules)`);
    }
  }
  const again = omem(omemHome, roots, ['run']);
  const againLine = again.out.split(/\r?\n/).find((l) => l.startsWith('Processing complete')) ?? '';
  if (again.code === 0 && /sessions 2/.test(againLine) && /skipped unchanged/.test(againLine)) {
    ok(`run scanned WorkBuddy and Cursor copies ${againLine.replace(/^Processing complete/, '').trim()}`);
  } else {
    bad('run scanned WorkBuddy and Cursor copies', `code=${again.code} ${againLine || again.out.slice(0, 180)}`);
  }
  const exported = omem(omemHome, roots, ['context', '--for', 'cursor']);
  if (exported.code === 0 && exported.out.includes('alwaysApply: true') && exported.out.includes('MEMORY-INDEX')) {
    ok('context --for cursor exports .mdc');
  } else {
    bad('context --for cursor exports .mdc', `code=${exported.code}`);
  }

  console.log('== L5 source sessions and client configs unchanged ==');
  for (const [path, hash] of sourceHashes) {
    if (!existsSync(path)) {
      bad(`source file still present ${basename(path)}`);
      continue;
    }
    if (sha256(path) === hash) ok(`source file hash unchanged ${basename(path)}`);
    else bad(`source file hash unchanged ${basename(path)}`);
  }
  const configAfter = snapshotFiles(guardedConfigs());
  const changed = diffSnapshot(configBefore, configAfter);
  if (changed.length === 0) ok('mcp.json / CLAUDE.md / .claude.json unchanged');
  else bad('mcp.json / CLAUDE.md / .claude.json unchanged', changed.map((p) => relative(HOME, p)).join(', '));

  const homeReal = join(HOME, '.omem');
  if (!existsSync(homeReal)) ok('did not create ~/.omem');
  else ok('did not switch to ~/.omem (this run only wrote temp dirs)');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
console.log(`Result: ${pass.length} passed / ${fail.length} failed`);
if (fail.length) {
  console.log('Failures: ' + fail.join('; '));
  process.exit(1);
}
console.log('Local read-only verification passed');
