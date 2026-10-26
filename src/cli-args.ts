// CLI 参数解析（零依赖）：positional + --key=value / --key value / --key（布尔）。
// 带值旗标必须在 VALUE_FLAGS 注册——未注册的 --key 一律按布尔处理，绝不吞下一个 token。
// 这样 `omem search --sessions "查询词"`（布尔旗标前置）不会把查询词吞成旗标的值；
// 新增带值旗标时同步注册，tests/unit/cli-args.test.ts 的防漂移用例会扫描 src/ 校验。
export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | true>;
}

/** 全部带值旗标（--key value 或 --key=value）。与 src/commands/* 的 flagStr/flagNum 调用点一一对应。 */
export const VALUE_FLAGS = new Set([
  // add
  'type', 'tags', 'supersedes', 'domain', 'project', 'topic',
  // search
  // （domain/project 已在上）
  // run
  'tier', 'since', 'session', 'collectors', 'base', 'model', 'limit',
  // review
  'confirm', 'dismiss', 'stale',
  // redact
  'id', 'source',
  // install
  'command', 'print-config', 'target',
  // gc
  'days',
  // eval
  'golden', 'min-recall', 'n', 'out',
  // context
  'for',
  // audit
  'tail',
]);

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
      // 仅注册过的带值旗标才吞下一个 token；且值不以 '-' 开头（避免把 -v 这类短旗误吞为值）。
      // 未注册的旗标退化为布尔：位置参数原样留在 _ 里，查询词不会被吃掉。
      if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('-')) {
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
