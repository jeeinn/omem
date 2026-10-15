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
import { parseTomlSubset, serializeOmemToml } from './toml-bridge.js';

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
      if (!Array.isArray(obj.mcpServers)) throw new Error('mcpServers 已存在且不是数组，跳过以免破坏配置');
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
    let parsed: any;
    try {
      parsed = parseTomlSubset(raw);
    } catch (e: any) {
      return { reason: `TOML 解析失败: ${e.message}`, manual };
    }
    mergeInto(parsed, spec, command);
    return { text: serializeOmemToml(parsed) };
  }

  const parsed = parseJsonc(raw);
  if (!parsed.ok) {
    // 纪律 5：解析失败 → 降级，给手工片段
    return { reason: `解析失败（可能是 JSON5/JSONC 变体）: ${parsed.error}`, manual };
  }
  try {
    mergeInto(parsed.value, spec, command);
  } catch (e: any) {
    return { reason: e.message, manual };
  }
  return { text: JSON.stringify(parsed.value, null, 2) + '\n' };
}

export function writeClientConfig(spec: ClientSpec, command: string): WriteOutcome {
  const path = spec.configPath(homedir());
  const outcome: WriteOutcome = { ok: false, client: spec.id, path };
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : null;

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
    '## omem（个人记忆）',
    '- 检索记忆：`omem search "<query>"`（等价于 MCP 的 search_memory）',
    '- 保存记忆：`omem add "<content>"`',
    '- 上下文导出：`omem context --for <agent>`',
    '- MCP 工具 search_memory / save_memory 可用时优先用工具。',
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
