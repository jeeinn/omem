// omem CLI 入口：命令分发、帮助、退出码（规格 §7：0 成功 / 1 用法错误 / 2 后端不可用或策略拒绝）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from './cli-args.js';
import type { ParsedArgs } from './cli-args.js';
import { UsageError, BackendUnavailableError, ProfileBlockedError } from './core/util.js';
import { cmdInit } from './commands/init.js';
import { cmdInstall } from './commands/install.js';
import { cmdRun } from './commands/run.js';
import { cmdAdd } from './commands/add.js';
import { cmdSearch } from './commands/search.js';
import { cmdReview } from './commands/review.js';
import { cmdGc } from './commands/gc.js';
import { cmdRebuild } from './commands/rebuild.js';
import { cmdContext } from './commands/context.js';
import { cmdSync } from './commands/sync.js';
import { cmdProfile } from './commands/profile.js';
import { cmdPause, cmdResume } from './commands/pause.js';
import { cmdRedact } from './commands/redact.js';
import { cmdSnapshot } from './commands/snapshot.js';
import { cmdServe } from './commands/serve.js';
import { cmdAudit } from './commands/audit.js';
import { cmdEval } from './commands/eval.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };

interface Command {
  desc: string;
  usage?: string;
  run: (args: ParsedArgs) => Promise<number> | number;
}

const COMMANDS: Record<string, Command> = {
  init: {
    desc: '建库 + git 数据仓 + 扫描已有会话（规则抽取）',
    usage: 'omem init [--no-scan] [--no-git]',
    run: cmdInit,
  },
  install: {
    desc: '自动检测并接线本机 Agent（MCP 配置 + 指令文件）',
    usage: 'omem install [--target a,b] [--list] [--print-config <id>] [--command <cmd>]',
    run: cmdInstall,
  },
  run: {
    desc: '加工会话（V0.1 仅 Claude Code；四档加工）',
    usage: 'omem run [--since 7d|YYYY-MM-DD] [--session <id>] [--tier rules|agent|api] [--dry-run]',
    run: cmdRun,
  },
  add: {
    desc: '手动写入一条记忆（verified）',
    usage: 'omem add <内容> [--type X] [--domain Y] [--tags a,b] [--project fp] [--supersedes id1,id2] [--force]',
    run: cmdAdd,
  },
  search: {
    desc: '检索记忆（附时效标注）',
    usage: 'omem search <查询词> [--detail] [--all] [--domain X] [--project Y]',
    run: cmdSearch,
  },
  review: {
    desc: '待确认队列（unverified 候选 + stale 提示）',
    usage: 'omem review [--confirm <id> [--supersedes <old-id>]] [--dismiss <id>] [--stale <id>]',
    run: cmdReview,
  },
  gc: {
    desc: '标记 stale（只报告不删除）',
    usage: 'omem gc [--days N]',
    run: cmdGc,
  },
  rebuild: {
    desc: '从 md 全量重建索引 + MEMORY-INDEX',
    usage: 'omem rebuild',
    run: cmdRebuild,
  },
  context: {
    desc: '导出上下文（非 MCP Agent 接入路径）',
    usage: 'omem context --for claude-code|cursor|codex|plain [--out <file>]',
    run: cmdContext,
  },
  sync: {
    desc: '拉取 + 推送（一条命令；冲突只报告）',
    usage: 'omem sync [status|use <git|webdav|dir>|remote <url>|pull|push]',
    run: cmdSync,
  },
  profile: {
    desc: 'work/home profile 切换与状态',
    usage: 'omem profile [use work|home|status]',
    run: cmdProfile,
  },
  pause: {
    desc: '一键停采集',
    usage: 'omem pause',
    run: cmdPause,
  },
  resume: {
    desc: '恢复采集',
    usage: 'omem resume',
    run: cmdResume,
  },
  redact: {
    desc: '硬删除（唯一途径）',
    usage: 'omem redact --id <id>',
    run: cmdRedact,
  },
  snapshot: {
    desc: '每日快照（滚动保留 7 份）',
    usage: 'omem snapshot',
    run: cmdSnapshot,
  },
  serve: {
    desc: '启动 MCP server（stdio）',
    usage: 'omem serve',
    run: cmdServe,
  },
  audit: {
    desc: '使用日志（调用率可观测）',
    usage: 'omem audit [--tail N]',
    run: cmdAudit,
  },
  eval: {
    desc: '抽取评估：子串召回基线（弱代理）与人工标注导出',
    usage: 'omem eval recall [--golden <dir>] [--write-baseline] [--min-recall <n>] | omem eval sample [--n 20] [--out <file>]',
    run: cmdEval,
  },
};

function printHelp(): void {
  console.log(`omem v${pkg.version} — git 原生的个人级 AI 记忆层（Markdown 事实源 + MCP + FTS5）\n`);
  console.log('用法: omem <command> [options]\n');
  console.log('命令:');
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(12)} ${c.desc}`);
  }
  console.log('\n快速开始: omem init → omem install → omem search "<关键词>"');
  console.log('文档: docs/omem-V0.1-实施计划.md · 单命令帮助: omem <command> --help');
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd) {
    // 顶层旗标：显式求助/查版本不是错误（退出码 0）；裸调用是用法错误（1）
    if (args.flags.help || args.flags.h) {
      printHelp();
      return 0;
    }
    if (args.flags.version || args.flags.v) {
      console.log(pkg.version);
      return 0;
    }
    printHelp();
    return 1;
  }
  if (cmd === 'help') {
    printHelp();
    return 0;
  }
  if (cmd === 'version') {
    console.log(pkg.version);
    return 0;
  }
  const entry = COMMANDS[cmd];
  if (!entry) {
    console.error(`未知命令: ${cmd}\n`);
    printHelp();
    return 1;
  }
  if (args.flags.help || args.flags.h) {
    console.log(`用法: ${entry.usage ?? `omem ${cmd}`}`);
    console.log(`说明: ${entry.desc}`);
    return 0;
  }
  const rest: ParsedArgs = { _: args._.slice(1), flags: args.flags };
  try {
    return await entry.run(rest);
  } catch (e: any) {
    if (e instanceof UsageError) {
      console.error(`用法错误: ${e.message}`);
      if (entry.usage) console.error(`用法: ${entry.usage}`);
      return 1;
    }
    if (e instanceof BackendUnavailableError) {
      console.error(`${e.message}`);
      if (e.hint) console.error(`提示: ${e.hint}`);
      return 2;
    }
    if (e instanceof ProfileBlockedError) {
      console.error(e.message);
      return 2;
    }
    console.error(`错误: ${e?.message ?? e}`);
    return 1;
  }
}

// 自动执行仅限"作为进程入口"启动（bin/omem.js 链或直接 node dist/cli.js）；
// 被 import（如单元测试）时不产生副作用——main() 可独立调用验证分发与退出码。
function isProcessEntry(): boolean {
  if (process.env.OMEM_CLI_ENTRY === '1') return true;
  try {
    return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
