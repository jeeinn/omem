// omem doctor：一次性体检。只读，不改任何文件。
//
// 存在的理由：装机失败时用户拿到的只有一句启动报错。真实排查要跨六件事——
// Node 版本、包版本、原生 zstd 绑定、config.toml、git 数据仓、各采集器根目录。
// 这些逐条查一遍正好是一次 doctor；顺带让 issue 反馈变成「贴一段输出」。
//
// 退出码：默认恒为 0（诊断不是错误）。加 --strict 时，存在 error 级问题才返回 1。
import { existsSync } from 'node:fs';
import * as zlib from 'node:zlib';
import { openCtx } from '../core/ctx.js';
import { files } from '../core/paths.js';
import { OMEM_REQUIRED_NODE, OMEM_VERSION } from '../core/version.js';
import { COLLECTOR_IDS, getCollector } from '../collect/collector.js';
import { deepseekZstdError } from '../collect/deepseek.js';
import { getBackend } from '../sync/backend.js';
import { flagBool } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

type Level = 'ok' | 'warn' | 'error';

interface Check {
  level: Level;
  label: string;
  detail: string;
}

const LABEL_WIDTH = 22;

function line(c: Check): string {
  const label = c.label.padEnd(LABEL_WIDTH);
  const tag = c.level === 'ok' ? 'ok     ' : c.level === 'warn' ? 'warn   ' : 'ERROR  ';
  return `  ${label}${tag}${c.detail}`;
}

/** ">=22.5.0" → [22,5,0]；解析不了返回 null（不猜）。 */
export function parseNodeFloor(spec: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(spec);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** semver 三段比较：a<b 返回负数。 */
export function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function parseRunningNode(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const checks: Check[] = [];

  // 1) 运行时
  const floor = parseNodeFloor(OMEM_REQUIRED_NODE);
  const running = parseRunningNode(process.versions.node);
  if (!floor || !running) {
    checks.push({ level: 'warn', label: 'Node', detail: `${process.versions.node} (cannot compare against "${OMEM_REQUIRED_NODE}")` });
  } else if (compareVersion(running, floor) < 0) {
    checks.push({ level: 'error', label: 'Node', detail: `${process.versions.node} is below the required ${OMEM_REQUIRED_NODE}` });
  } else {
    checks.push({ level: 'ok', label: 'Node', detail: `${process.versions.node} (required ${OMEM_REQUIRED_NODE})` });
  }
  checks.push({ level: 'ok', label: 'omem', detail: OMEM_VERSION });

  // 2) 数据仓与配置
  const ctx = openCtx();
  const { home, config, index } = ctx;
  try {
    const configPath = files.config(home);
    checks.push({
      level: 'ok',
      label: 'Store',
      detail: home,
    });
    checks.push({
      level: existsSync(configPath) ? 'ok' : 'warn',
      label: 'config.toml',
      detail: existsSync(configPath) ? configPath : 'not found (defaults are in effect; run omem init)',
    });

    const rows = index.rows().map((r) => r.row);
    const active = rows.filter((r) => r.status === 'active').length;
    const stale = rows.filter((r) => r.status === 'stale').length;
    const archived = rows.filter((r) => r.status === 'archived').length;
    checks.push({
      level: 'ok',
      label: 'Documents',
      detail: `${rows.length} (active ${active}, stale ${stale}, archived ${archived})`,
    });
    checks.push({ level: 'ok', label: 'Sessions', detail: String(index.listSessions().length) });

    // 3) git 数据仓（backend 不可用时只是 warn：没配远端也能用）
    try {
      const st = getBackend(config.sync.backend, home, config).status();
      const bits = [`${st.backend}${st.available ? '' : ' (not initialized)'}`];
      bits.push(`remote ${st.remote ?? 'none'}`);
      if (st.available) bits.push(`dirty ${st.dirty}, ahead ${st.ahead}, behind ${st.behind}`);
      checks.push({ level: st.available ? 'ok' : 'warn', label: 'Backup', detail: bits.join(' · ') });
    } catch (e) {
      checks.push({ level: 'warn', label: 'Backup', detail: e instanceof Error ? e.message : String(e) });
    }

    // 4) zstd（只影响 deepseek 采集器）
    const builtin = typeof (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function';
    const zstdError = deepseekZstdError();
    if (zstdError) {
      checks.push({ level: 'error', label: 'zstd', detail: `${zstdError} — the deepseek collector cannot run` });
    } else {
      checks.push({ level: 'ok', label: 'zstd', detail: builtin ? 'node:zlib (built-in)' : '@toondepauw/node-zstd (native)' });
    }

    // 5) 采集器根目录 + 自检
    for (const id of COLLECTOR_IDS) {
      try {
        const collector = getCollector(id, config);
        const root = collector.root();
        if (!existsSync(root)) {
          checks.push({ level: 'warn', label: id, detail: `not found: ${root}` });
          continue;
        }
        const preflight = collector.preflight?.();
        checks.push(
          preflight
            ? { level: 'error', label: id, detail: `${root} — ${preflight}` }
            : { level: 'ok', label: id, detail: root },
        );
      } catch (e) {
        checks.push({ level: 'error', label: id, detail: e instanceof Error ? e.message : String(e) });
      }
    }

    // 6) 输出
    const errors = checks.filter((c) => c.level === 'error');
    const warns = checks.filter((c) => c.level === 'warn');
    for (const c of checks) console.log(line(c));
    console.log('');
    if (errors.length === 0 && warns.length === 0) {
      console.log('All checks passed.');
    } else {
      console.log(`${errors.length} error(s), ${warns.length} warning(s).`);
      if (warns.length > 0 && errors.length === 0) {
        console.log('Warnings are about missing optional sources; omem still works without them.');
      }
    }

    return flagBool(args.flags, 'strict') && errors.length > 0 ? 1 : 0;
  } finally {
    index.close();
  }
}