// CLI 参数解析（零依赖）：positional + --key=value / --key value / --key（布尔）。
export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const _: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      // 值不以 '-' 开头才吞——否则 '-v' 这类短旗会被误吞为上一个 flag 的值
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

export function flagStr(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(flags: Record<string, string | true>, key: string): boolean {
  return flags[key] !== undefined;
}

/** 正整数旗标（如 --limit 5）；缺失或非数字返回 undefined，由调用方决定回退。 */
export function flagNum(flags: Record<string, string | true>, key: string): number | undefined {
  const v = flags[key];
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
