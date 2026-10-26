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
import { cmdRedact } from './commands/redact.js';
import { cmdSnapshot } from './commands/snapshot.js';
import { cmdServe } from './commands/serve.js';
import { cmdAudit } from './commands/audit.js';
import { cmdEval } from './commands/eval.js';
import { cmdApi } from './commands/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };

interface Command {
  desc: string;
  usage?: string;
  run: (args: ParsedArgs) => Promise<number> | number;
}

const COMMANDS: Record<string, Command> = {
  init: {
    desc: 'Initialize store + git data repo (does not ingest sessions)',
    usage: 'omem init [--no-scan] [--no-git]',
    run: cmdInit,
  },
  install: {
    desc: 'Select and wire up local Agents (MCP config + instruction files)',
    usage: 'omem install [--target a,b|other] [--list] [--print-config <id|generic>] [--command <cmd>]',
    run: cmdInstall,
  },
  sync: {
    desc: 'Ingest session transcripts (conclusions are not extracted)',
    usage: 'omem sync [--since 7d|YYYY-MM-DD] [--session <id>] [--collectors id,id] [--tier agent|api] [--dry-run] [--base URL] [--model X] [--limit N]',
    run: cmdRun,
  },
  add: {
    desc: 'Manually add a memory (verified)',
    usage: 'omem add <content> [--type X] [--domain Y] [--tags a,b] [--project fp] [--topic name] [--supersedes id1,id2] [--force]',
    run: cmdAdd,
  },
  search: {
    desc: 'Search memories (with freshness labels)',
    usage: 'omem search <query> [--detail] [--all] [--sessions] [--domain X] [--project Y]',
    run: cmdSearch,
  },
  review: {
    desc: 'Review a short queue; open one entry by id',
    usage: 'omem review [<id>] [--all] [--source X] [--topic X] [--confirm <id> [--supersedes <old-id>]] [--dismiss <id>] [--stale <id>]',
    run: cmdReview,
  },
  gc: {
    desc: 'Mark stale (report only, never delete)',
    usage: 'omem gc [--days N]',
    run: cmdGc,
  },
  rebuild: {
    desc: 'Rebuild index + MEMORY-INDEX from markdown files',
    usage: 'omem rebuild',
    run: cmdRebuild,
  },
  context: {
    desc: 'Export context (integration path for non-MCP Agents)',
    usage: 'omem context --for claude-code|cursor|codex|plain [--out <file>]',
    run: cmdContext,
  },
  backup: {
    desc: 'Back up the data repo (git pull + push; conflicts are reported only)',
    usage: 'omem backup [status|use <git|webdav|dir>|remote <url>|pull|push]',
    run: cmdSync,
  },
  profile: {
    desc: 'Switch and show work/home profile status',
    usage: 'omem profile [use work|home|status]',
    run: cmdProfile,
  },
  redact: {
    desc: 'Hard delete (the only way); --source previews by default, --yes deletes',
    usage: 'omem redact --id <id> | omem redact --source rules|agent|llm|manual [--yes]',
    run: cmdRedact,
  },
  snapshot: {
    desc: 'Daily snapshot (rolling retention of 7)',
    usage: 'omem snapshot',
    run: cmdSnapshot,
  },
  serve: {
    desc: 'Start MCP server (stdio)',
    usage: 'omem serve',
    run: cmdServe,
  },
  audit: {
    desc: 'Usage log (observable call rates)',
    usage: 'omem audit [--tail N]',
    run: cmdAudit,
  },
  eval: {
    desc: 'Extraction eval: substring-recall baseline (weak proxy) and annotation export',
    usage: 'omem eval recall [--golden <dir>] [--write-baseline] [--min-recall <n>] | omem eval sample [--n 20] [--out <file>]',
    run: cmdEval,
  },
  api: {
    desc: 'API tier diagnostics: effective config, queue depth, model probe',
    usage: 'omem api status',
    run: cmdApi,
  },
};

function printHelp(): void {
  console.log(`omem v${pkg.version} — a git-native personal AI memory layer (Markdown source of truth + MCP + FTS5)\n`);
  console.log('Usage: omem <command> [options]\n');
  console.log('Commands:');
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(12)} ${c.desc}`);
  }
  console.log('\nQuick start: omem init → omem sync → omem install → omem search "<keyword>"');
  console.log('Docs: docs/omem-V0.1技术规格草案.md (Chinese) · Per-command help: omem <command> --help');
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
    if (cmd === 'run') {
      console.error('Removed. Collect sessions with: omem sync\n');
    }
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    return 1;
  }
  if (args.flags.help || args.flags.h) {
    console.log(`Usage: ${entry.usage ?? `omem ${cmd}`}`);
    console.log(`Description: ${entry.desc}`);
    return 0;
  }
  const rest: ParsedArgs = { _: args._.slice(1), flags: args.flags };
  try {
    return await entry.run(rest);
  } catch (e: any) {
    if (e instanceof UsageError) {
      console.error(`Usage error: ${e.message}`);
      if (entry.usage) console.error(`Usage: ${entry.usage}`);
      return 1;
    }
    if (e instanceof BackendUnavailableError) {
      console.error(`${e.message}`);
      if (e.hint) console.error(`Hint: ${e.hint}`);
      return 2;
    }
    if (e instanceof ProfileBlockedError) {
      console.error(e.message);
      return 2;
    }
    console.error(`Error: ${e?.message ?? e}`);
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
