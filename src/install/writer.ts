// install 写入器：规格 §6.5 六条写入纪律。
// 1. 只 merge 不覆盖（仅 mcpServers.omem 一个键）
// 2. 先备份（<file>.omem-backup-<ts>）
// 3. 原子写（临时文件 + rename）
// 4. 幂等（已存在则更新 command/args）
// 5. 格式保留（JSONC 容错解析；TOML 子集往返；解析失败降级为打印手工片段）
// 6. 收尾提示（重启 client）
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ClientSpec } from './clients.js';
import { serializeOmemToml, upsertTomlSection } from './toml-bridge.js';

export interface WriteOutcome {
  ok: boolean;
  client: string;
  path: string;
  backup?: string;
  reason?: string;
  manual?: string; // 降级时给用户的手工片段
}

export interface RenderOutcome {
  text?: string; // 写入后的完整文件内容（纯内存生成，无副作用）
  manual?: string; // 降级：手工片段
  reason?: string;
}

export function omemEntry(command: string): { command: string; args: string[] } {
  return { command, args: ['serve'] };
}

/**
 * 通用 MCP 片段（规格 §6.3）：未在注册表内的客户端统一用 `mcpServers` 形态——这是社区事实标准
 * （Claude Desktop / Cursor / Cline / Windsurf / Continue 等均为此结构），只打印不写文件。
 */
export function renderGenericMcpSnippet(command: string): string {
  return (
    '# Generic MCP snippet — paste into your client\'s MCP config file.\n' +
    '# Most clients (Claude Desktop, Cursor, Cline, Windsurf, Continue, ...) use this "mcpServers" shape;\n' +
    '# check your client\'s docs for the exact file path and key name.\n' +
    JSON.stringify({ mcpServers: { omem: omemEntry(command) } }, null, 2) +
    '\n'
  );
}

/**
 * manual-connector 片段：MCP 配置在应用内部，无用户可编辑文件。
 * 走纪律 5 的降级路径——打印应用内添加指引，不写任何文件。文案按客户端 id 分发。
 */
export function renderManualConnectorSnippet(command: string, spec: ClientSpec): string {
  const entry = JSON.stringify({ command, args: ['serve'] }, null, 2);
  if (spec.id === 'doubao') {
    return [
      'Doubao manages MCP servers inside the app; there is no user-editable config file.',
      'Add omem as a local stdio MCP server in Doubao (open the app\'s MCP/connector settings, 设置 → MCP/连接器),',
      'or just ask the agent in a chat:',
      '  "add a local stdio MCP server named omem, command ' + command + ', args [serve]"',
      'Server config:',
      entry,
      '',
    ].join('\n');
  }
  // qwenwork 及其他 manual-connector
  return [
    'QwenWork keeps MCP server configs inside the app; there is no user-editable config file.',
    'Add omem as a custom MCP server inside QwenWork:',
    '  Settings → Connectors → Custom MCP (设置 → 连接器 → 自定义 MCP), or just ask the agent in a chat:',
    '    "add a custom MCP server named omem, command ' + command + ', args [serve]"',
    'Server config:',
    entry,
    '',
  ].join('\n');
}

/** JSONC 容错解析：去行/块注释与尾随逗号。 */
export function parseJsonc(text: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return { ok: true, value: JSON.parse(stripped) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function mergeInto(obj: any, spec: ClientSpec, command: string): void {
  const entry = omemEntry(command);
  switch (spec.kind) {
    case 'json-mcp':
      obj.mcpServers ??= {};
      obj.mcpServers.omem = entry;
      break;
    case 'json-array-mcp':
      obj.mcpServers ??= [];
      if (!Array.isArray(obj.mcpServers)) throw new Error('mcpServers exists and is not an array; skipping to avoid corrupting the config');
      {
        const found = obj.mcpServers.find((x: any) => x && x.name === 'omem');
        if (found) {
          found.command = entry.command;
          found.args = entry.args;
        } else {
          obj.mcpServers.push({ name: 'omem', ...entry });
        }
      }
      break;
    case 'json-zed':
      obj.context_servers ??= {};
      obj.context_servers.omem = { command: { path: entry.command, args: entry.args }, settings: {} };
      break;
    case 'toml-mcp':
      obj.mcp_servers ??= {};
      obj.mcp_servers.omem = { command: entry.command, args: entry.args };
      break;
  }
}

/**
 * 纯函数：生成"写入 omem 条目后"的完整文件内容（raw = 原文件内容，null = 文件不存在）。
 * writeClientConfig 与 install --print-config 共用；后者只读不写。
 */
export function renderClientConfig(spec: ClientSpec, command: string, raw: string | null): RenderOutcome {
  const entry = omemEntry(command);
  if (spec.kind === 'manual-connector') {
    // 千问办公 / 豆包办公无文件形态配置：永远走降级路径，打印应用内添加指引
    return { reason: 'This client manages MCP servers inside the app; omem cannot write its config file.', manual: renderManualConnectorSnippet(command, spec) };
  }
  const manual =
    spec.kind === 'toml-mcp'
      ? `[mcp_servers.omem]\ncommand = "${entry.command}"\nargs = ["serve"]`
      : JSON.stringify({ [spec.kind === 'json-zed' ? 'context_servers' : 'mcpServers']: { omem: entry } }, null, 2);

  if (raw === null) {
    // 新文件：按客户端形态生成最小配置
    const fresh: any = spec.kind === 'json-array-mcp' ? { mcpServers: [] } : {};
    mergeInto(fresh, spec, command);
    return { text: spec.kind === 'toml-mcp' ? serializeOmemToml(fresh) : JSON.stringify(fresh, null, 2) + '\n' };
  }

  if (spec.kind === 'toml-mcp') {
    // 文本级段合并：只动 [mcp_servers.omem]，用户文件的注释/格式/带引号段名全部原样保留
    const res = upsertTomlSection(raw, 'mcp_servers.omem', omemEntry(command));
    if ('error' in res) return { reason: res.error, manual };
    return { text: res.text };
  }

  const parsed = parseJsonc(raw);
  if (!parsed.ok) {
    // 纪律 5：解析失败 → 降级，给手工片段
    return { reason: `Parse failed (possibly a JSON5/JSONC variant): ${parsed.error}`, manual };
  }
  try {
    mergeInto(parsed.value, spec, command);
  } catch (e: any) {
    return { reason: e.message, manual };
  }
  return { text: JSON.stringify(parsed.value, null, 2) + '\n' };
}

/**
 * --print-config 预览（规格 §6.3）：只打印 omem 段本身 + 目标文件里将保留的其他键名，
 * 不回显整个目标文件内容——claude-code 的 ~/.claude.json 含 machineID、使用统计等隐私字段，
 * 整文件打印等于把用户隐私泄进终端/重定向文件。实际写入仍走 renderClientConfig 的完整合并视图。
 */
export function previewClientConfig(spec: ClientSpec, command: string, raw: string | null): string {
  const entry = omemEntry(command);
  if (spec.kind === 'manual-connector') {
    return renderManualConnectorSnippet(command, spec);
  }
  const lines: string[] = [];
  if (spec.kind === 'toml-mcp') {
    lines.push('[mcp_servers.omem]', `command = "${entry.command}"`, 'args = ["serve"]');
  } else if (spec.kind === 'json-array-mcp') {
    lines.push(JSON.stringify({ name: 'omem', ...entry }, null, 2));
  } else {
    const container = spec.kind === 'json-zed' ? 'context_servers' : 'mcpServers';
    lines.push(JSON.stringify({ [container]: { omem: entry } }, null, 2));
  }
  if (raw === null) {
    lines.push('', '(target file does not exist yet; install will create it with this entry)');
    return lines.join('\n') + '\n';
  }
  if (spec.kind === 'toml-mcp') {
    const sections = [...raw.matchAll(/^\s*\[([^\]]+)\]/gm)]
      .map((m) => m[1].trim())
      .filter((s) => s !== 'mcp_servers.omem');
    lines.push('', `Other sections in the target file are left untouched (${sections.length} found):`);
    lines.push(...sections.slice(0, 20).map((s) => `  [${s}]`));
    if (sections.length > 20) lines.push(`  …and ${sections.length - 20} more`);
    return lines.join('\n') + '\n';
  }
  const parsed = parseJsonc(raw);
  if (!parsed.ok) {
    lines.push('', `(existing file could not be parsed: ${parsed.error}; install will print a manual snippet instead of writing)`);
    return lines.join('\n') + '\n';
  }
  const container = spec.kind === 'json-zed' ? 'context_servers' : 'mcpServers';
  const top = parsed.value && typeof parsed.value === 'object' ? Object.keys(parsed.value) : [];
  const others = top.filter((k) => k !== container);
  lines.push('', `Other top-level keys in the target file are preserved (${others.length}):`);
  lines.push(...others.slice(0, 20).map((k) => `  ${k}`));
  if (others.length > 20) lines.push(`  …and ${others.length - 20} more`);
  const existing = (parsed.value as any)?.[container];
  if (Array.isArray(existing)) {
    // continue 形态：mcpServers 是数组，列其他条目的 name（只列名不列值）
    const names = existing.map((x: any) => x?.name).filter((n: unknown) => typeof n === 'string' && n !== 'omem');
    lines.push(`Other ${container} entries are preserved (${names.length}):`);
    lines.push(...names.slice(0, 20).map((n) => `  ${n}`));
    if (names.length > 20) lines.push(`  …and ${names.length - 20} more`);
  } else if (existing && typeof existing === 'object') {
    const sibs = Object.keys(existing).filter((k) => k !== 'omem');
    if (sibs.length > 0) {
      lines.push(`Other ${container} entries are preserved (${sibs.length}):`);
      lines.push(...sibs.slice(0, 20).map((k) => `  ${k}`));
      if (sibs.length > 20) lines.push(`  …and ${sibs.length - 20} more`);
    }
  }
  lines.push('', 'Only the omem entry is added or updated; nothing else in the file is modified.');
  return lines.join('\n') + '\n';
}

export function writeClientConfig(spec: ClientSpec, command: string): WriteOutcome {
  const path = spec.configPath(homedir());
  const outcome: WriteOutcome = { ok: false, client: spec.id, path };
  // manual-connector 的 configPath 是数据目录（不是文件），不能 readFileSync；render 自带降级
  const raw = spec.kind === 'manual-connector' ? null : existsSync(path) ? readFileSync(path, 'utf8') : null;

  const rendered = renderClientConfig(spec, command, raw);
  if (rendered.text === undefined) {
    outcome.reason = rendered.reason;
    outcome.manual = rendered.manual;
    return outcome;
  }
  // 备份 + 原子写（新文件无备份）
  if (raw !== null) outcome.backup = backupFile(path);
  atomicWrite(path, rendered.text);
  outcome.ok = true;
  return outcome;
}

function backupFile(path: string): string {
  const backup = `${path}.omem-backup-${Date.now()}`;
  copyFileSync(path, backup);
  return backup;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export const MARKER_START = '<!-- OMEM:START -->';
export const MARKER_END = '<!-- OMEM:END -->';

export function markerSection(): string {
  return [
    MARKER_START,
    '## omem (personal memory)',
    '- Search memories: `omem search "<query>"` (equivalent to the MCP search_memory)',
    '- Save a memory: `omem add "<content>"`',
    '- Export context: `omem context --for <agent>`',
    '- Prefer the MCP tools search_memory / save_memory when available.',
    '- If PROCESS.md lists groups (by project fingerprint) and sessions not yet absorbed, read those files and update the living document with save_memory. A group is not a topic name: pass your own topic, and pass supersedes when that topic already has a document.',
    MARKER_END,
  ].join('\n');
}

/** 向 Agent 指令文件写入 marker-fenced 段（规格 §6.4）：幂等替换，不破坏用户手写内容。 */
export function writeMarkerSection(filePath: string): { path: string; created: boolean } {
  const section = markerSection();
  const created = !existsSync(filePath);
  const before = created ? '' : readFileSync(filePath, 'utf8');
  const re = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`);
  const next = re.test(before) ? before.replace(re, section) : `${before.trimEnd()}\n\n${section}\n`;
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWrite(filePath, next);
  return { path: filePath, created };
}
