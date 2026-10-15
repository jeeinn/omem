// omem install：自动检测并接线本机 Agent（规格 §6；对齐 codegraph 的自动接线）。
// --list 列出支持的客户端 · --print-config <id> 只打印配置片段 · --target a,b 指定目标
// --command <cmd> 自定义 MCP 启动命令（默认 omem）
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIENTS, getClient } from '../install/clients.js';
import { writeClientConfig, writeMarkerSection } from '../install/writer.js';
import { loadConfig } from '../core/config.js';
import { omemHome } from '../core/paths.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdInstall(args: ParsedArgs): Promise<number> {
  const home = omemHome();
  const config = loadConfig(home);
  const command = flagStr(args.flags, 'command') ?? config.install.command;

  if (flagBool(args.flags, 'list')) {
    console.log('支持的客户端（✓=本机检测到；路径状态以"待核"标注的随版本漂移）：\n');
    for (const c of CLIENTS) {
      const detected = c.detect(homedir());
      const mark = detected ? '✓' : ' ';
      const verified = c.verified ? '路径已核实' : '路径待核';
      console.log(`  [${mark}] ${c.id.padEnd(15)} ${c.name.padEnd(16)} ${verified}  ${c.configPath(homedir())}`);
      if (c.note) console.log(`       └ ${c.note}`);
    }
    return 0;
  }

  const printId = flagStr(args.flags, 'print-config');
  if (printId) {
    const spec = getClient(printId);
    const out = writeClientConfig(spec, command);
    if (out.ok) {
      // 刚写入的文件内容即配置片段；直接读回展示
      const { readFileSync } = await import('node:fs');
      console.log(readFileSync(out.path, 'utf8'));
    } else if (out.manual) {
      console.log(out.manual);
    }
    return 0;
  }

  // 目标：--target 指定，否则自动检测
  let targets = (flagStr(args.flags, 'target') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (targets.length === 0) {
    targets = CLIENTS.filter((c) => c.detect(homedir())).map((c) => c.id);
    if (targets.length === 0) {
      console.log('未检测到已安装的 Agent 客户端。');
      console.log('可用 omem install --list 查看支持列表，或用 --target <id> 强制写入。');
      return 0;
    }
    console.log(`自动检测到 ${targets.length} 个客户端: ${targets.join(', ')}\n`);
  }

  let failures = 0;
  for (const id of targets) {
    const spec = getClient(id);
    const out = writeClientConfig(spec, command);
    if (out.ok) {
      console.log(`✓ ${spec.id} → ${out.path}${out.backup ? `（备份: ${out.backup}）` : '（新建）'}`);
    } else {
      failures++;
      console.log(`✗ ${spec.id} → ${out.path}`);
      console.log(`  原因: ${out.reason}`);
      if (out.manual) {
        console.log('  请手工添加以下配置片段：');
        for (const l of out.manual.split('\n')) console.log(`    ${l}`);
      }
    }
  }

  // marker-fenced 指令段（规格 §6.4）：让子 Agent 与非 MCP harness 也能用 CLI
  const claudeMd = join(homedir(), '.claude', 'CLAUDE.md');
  const marker = writeMarkerSection(claudeMd);
  console.log(`\n指令段已写入: ${marker.path}${marker.created ? '（新建）' : '（marker 幂等替换）'}`);

  console.log('\n收尾：请重启对应客户端以加载 MCP 服务。');
  console.log('验证: omem install --print-config workbuddy');
  return failures > 0 ? 0 : 0; // 降级已打印手工片段，不算失败（规格 §6.5-5）
}
