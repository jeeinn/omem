// TOML 桥接：复用 config.ts 的子集解析器；TOML 写入走**文本级段合并**。
// 为什么不做全量 parse→serialize 往返：TOML 承载注释与格式，且子集序列化会
// ① 把 `[projects.'E:\a.b']` 这类带引号段名重写成带引号字符串（键名语义改变）
// ② 丢掉空表段（如 `[model_providers]`）。对用户已有的 config.toml 这是破坏性写入。
// 因此只定位并替换/追加目标段，其余字节原样保留。
import { parseTomlSubset, splitTomlPath } from '../core/config.js';

export { parseTomlSubset };

function isScalar(v: any): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v);
}

function tomlValue(v: any): string {
  if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  return String(v);
}

/** 键名：裸键直接输出；含点号、空格等特殊字符的键必须加引号，否则往返后不再是同一个键。 */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function emitTable(prefix: string, obj: Record<string, any>, lines: string[]): void {
  const scalarKeys = Object.keys(obj).filter((k) => isScalar(obj[k]));
  const tableKeys = Object.keys(obj).filter((k) => !isScalar(obj[k]));
  if (prefix && scalarKeys.length > 0) lines.push('', `[${prefix}]`);
  for (const k of scalarKeys) lines.push(`${tomlKey(k)} = ${tomlValue(obj[k])}`);
  for (const k of tableKeys) {
    if (!obj[k] || typeof obj[k] !== 'object') continue;
    emitTable(prefix ? `${prefix}.${tomlKey(k)}` : tomlKey(k), obj[k], lines);
  }
}

/** 通用 TOML 序列化：先顶层标量，再各表（点号路径）。仅用于生成新文件，不用于改写已有文件。 */
export function serializeOmemToml(obj: Record<string, any>): string {
  const lines: string[] = [];
  emitTable('', obj, lines);
  return lines.join('\n').replace(/^\n+/, '') + '\n';
}

/** 渲染单个段（含段头），供文本级 upsert 使用。 */
export function renderTomlSection(path: string, table: Record<string, any>): string {
  const lines: string[] = [`[${path}]`];
  for (const [k, v] of Object.entries(table)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  return lines.join('\n') + '\n';
}

export type TomlUpsertResult = { text: string; action: 'added' | 'updated' } | { error: string };

/**
 * 文本级段 upsert：只替换/追加目标段，其余内容（注释、空行、空表段、带引号段名）原样保留。
 * 若目标路径已在别的写法下定义（如 `[mcp_servers]` 下的 inline 表），返回 error 交调用方降级——
 * 追加会造成同表重复定义，那是非法 TOML。
 */
export function upsertTomlSection(raw: string, path: string, table: Record<string, any>): TomlUpsertResult {
  const section = renderTomlSection(path, table);
  const header = `[${path}]`;
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);

  if (start === -1) {
    let defined = false;
    try {
      let cur: any = parseTomlSubset(raw);
      for (const part of splitTomlPath(path)) {
        cur = cur?.[part];
        if (cur === undefined) break;
      }
      defined = cur !== undefined;
    } catch {
      defined = false; // 解析失败时按"未定义"处理：文本里确实没有该段头
    }
    // 子表形式（[mcp_servers.omem.xxx]）会隐含定义父表，此时补一个显式父段头是合法 TOML；
    // 但 inline / 点号键形式（[mcp_servers] 下 omem = {...}）不能再追加段头，否则同表重复定义。
    const hasSubTableHeader = lines.some((l) => l.trim().startsWith(`[${path}.`));
    if (defined && !hasSubTableHeader) {
      return { error: `[${path}] already exists in a form this tool cannot safely rewrite; add it manually` };
    }
    const base = raw.replace(/\s*$/, '');
    const prefix = base.length > 0 ? `${base}\n\n` : '';
    return { text: `${prefix}${section}`, action: 'added' };
  }

  // 段体 = 从段头下一行起到下一个段头（或文件尾）
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const body = section.trimEnd().split('\n');
  const rest = lines.slice(end);
  const next = [...lines.slice(0, start), ...body, ...(rest.length > 0 ? ['', ...rest] : [''])];
  return { text: next.join('\n'), action: 'updated' };
}
