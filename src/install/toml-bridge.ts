// TOML 桥接：复用 config.ts 的子集解析器；提供通用序列化（供 codex config.toml 的 merge 往返）。
// 只支持本章节用到的形态：章节（含点号嵌套表）+ 标量 + 标量数组。遇更复杂 TOML 特性时调用方降级。
import { parseTomlSubset } from '../core/config.js';

export { parseTomlSubset };

function isScalar(v: any): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v);
}

function tomlValue(v: any): string {
  if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  return String(v);
}

function emitTable(prefix: string, obj: Record<string, any>, lines: string[]): void {
  const scalarKeys = Object.keys(obj).filter((k) => isScalar(obj[k]));
  const tableKeys = Object.keys(obj).filter((k) => !isScalar(obj[k]));
  if (prefix && scalarKeys.length > 0) lines.push('', `[${prefix}]`);
  for (const k of scalarKeys) lines.push(`${k} = ${tomlValue(obj[k])}`);
  for (const k of tableKeys) {
    if (!obj[k] || typeof obj[k] !== 'object') continue;
    emitTable(prefix ? `${prefix}.${k}` : k, obj[k], lines);
  }
}

/** 通用 TOML 序列化：先顶层标量，再各表（点号路径）。 */
export function serializeOmemToml(obj: Record<string, any>): string {
  const lines: string[] = [];
  emitTable('', obj, lines);
  return lines.join('\n').replace(/^\n+/, '') + '\n';
}
