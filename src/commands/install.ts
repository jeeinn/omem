// omem install：自动检测并接线本机 Agent（规格 §6；对齐 codegraph 的自动接线）。
// --list 列出支持的客户端 · --print-config <id|generic> 只打印配置片段 · --target a,b 指定目标
// 无 --target 且终端可交互时进入多选界面；非交互终端必须显式 --target（不静默全装）。
// marker-fenced 指令段仅在选中 claude-code 时写入。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIENTS, getClient } from '../install/clients.js';
import { writeClientConfig, writeMarkerSection, previewClientConfig, renderGenericMcpSnippet } from '../install/writer.js';
import { buildItems, selectClients } from '../install/prompt.js';
import type { ChoiceItem } from '../install/prompt.js';
import { loadConfig } from '../core/config.js';
import { omemHome } from '../core/paths.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';

const GENERIC_IDS = new Set(['other', 'generic']);

export async function cmdInstall(args: ParsedArgs): Promise<number> {
  const home = omemHome();
  const config = loadConfig(home);
  const command = flagStr(args.flags, 'command') ?? config.install.command;

  if (flagBool(args.flags, 'list')) {
    console.log('Supported clients (✓ = detected on this machine; paths marked "unverified" may drift across versions):\n');
    for (const c of CLIENTS) {
      const detected = c.detect(homedir());
      const mark = detected ? '✓' : ' ';
      const verified = c.verified ? 'path verified' : 'path unverified';
      console.log(`  [${mark}] ${c.id.padEnd(15)} ${c.name.padEnd(16)} ${verified}  ${c.configPath(homedir())}`);
      if (c.note) console.log(`       └ ${c.note}`);
    }
    return 0;
  }

  // --print-config：只读预览将写入的配置（纯内存渲染，不落盘、不备份）
  const printId = flagStr(args.flags, 'print-config');
  if (printId) {
    if (GENERIC_IDS.has(printId)) {
      console.log(renderGenericMcpSnippet(command));
      return 0;
    }
    const spec = getClient(printId);
    const path = spec.configPath(homedir());
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : null;
    console.log(`# Target file: ${path}${raw === null ? ' (does not exist; will be created on install)' : ''}`);
    console.log('# Preview: only the omem entry is shown below; all other content in the file is preserved untouched.');
    console.log(previewClientConfig(spec, command, raw));
    return 0;
  }

  // 目标：--target 指定；否则交互选择（TTY）或报错（非交互）
  let targets = (flagStr(args.flags, 'target') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let printGeneric = false;
  if (targets.some((t) => GENERIC_IDS.has(t))) {
    printGeneric = true;
    targets = targets.filter((t) => !GENERIC_IDS.has(t));
  }

  if (targets.length === 0 && !printGeneric) {
    const probes = CLIENTS.map((c) => ({
      spec: c,
      detected: c.detect(homedir()),
    }));
    const detected = probes.filter((p) => p.detected);
    if (!process.stdin.isTTY) {
      throw new UsageError(
        'Non-interactive terminal: pass --target <ids> explicitly. ' +
          `Detected on this machine: ${detected.map((p) => p.spec.id).join(', ') || 'none'}.`,
      );
    }
    const items: ChoiceItem[] = buildItems(
      probes.map((p) => ({
        id: p.spec.id,
        name: p.spec.name,
        path: p.spec.configPath(homedir()),
        detected: p.detected,
        verified: p.spec.verified,
      })),
    );
    if (detected.length === 0) {
      console.log('No Agent clients detected in this machine\'s home directory. Pick manually, or press q and use --target <id>.');
    }
    const picked = await selectClients(items);
    if (picked.cancelled) {
      console.log('Cancelled. Nothing was written.');
      return 0;
    }
    printGeneric = picked.selected.some((id) => GENERIC_IDS.has(id));
    targets = picked.selected.filter((id) => !GENERIC_IDS.has(id));
    if (targets.length === 0 && !printGeneric) {
      console.log('Nothing selected. No files were written.');
      return 0;
    }
    console.log('');
  }

  let failures = 0;
  for (const id of targets) {
    const spec = getClient(id);
    const out = writeClientConfig(spec, command);
    if (out.ok) {
      console.log(`✓ ${spec.id} → ${out.path}${out.backup ? ` (backup: ${out.backup})` : ' (created)'}`);
    } else {
      failures++;
      console.log(`✗ ${spec.id} → ${out.path}`);
      console.log(`  Reason: ${out.reason}`);
      if (out.manual) {
        console.log('  Please add the following config snippet manually:');
        for (const l of out.manual.split('\n')) console.log(`    ${l}`);
      }
    }
  }

  if (printGeneric) {
    if (targets.length > 0) console.log('\nFor clients not in the list above:');
    console.log(renderGenericMcpSnippet(command));
  }

  // marker-fenced 指令段（规格 §6.4）：让子 Agent 与非 MCP harness 也能用 CLI。
  // 只在选中 claude-code 时写入——它写的是 ~/.claude/CLAUDE.md，与是否装了 Cursor 无关。
  if (targets.includes('claude-code')) {
    const claudeMd = join(homedir(), '.claude', 'CLAUDE.md');
    const marker = writeMarkerSection(claudeMd);
    console.log(`\nInstruction section written: ${marker.path}${marker.created ? ' (created)' : ' (idempotent marker replacement)'}`);
  } else if (targets.length > 0) {
    console.log('\nInstruction section skipped: ~/.claude/CLAUDE.md is only updated when claude-code is selected.');
  }

  if (targets.length > 0) {
    console.log('\nFinal step: restart the corresponding clients to load the MCP server.');
    console.log('Verify: omem install --print-config workbuddy');
  }
  return 0; // 降级已打印手工片段，不算失败（规格 §6.5-5）
}
