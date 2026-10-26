// install 写入器测试（规格 §6.5 六条写入纪律）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeClientConfig,
  writeMarkerSection,
  markerSection,
  parseJsonc,
  omemEntry,
  renderClientConfig,
  renderGenericMcpSnippet,
  previewClientConfig,
} from '../../src/install/writer.js';
import type { ClientSpec } from '../../src/install/clients.js';
import { CLIENTS, getClient } from '../../src/install/clients.js';
import { upsertTomlSection } from '../../src/install/toml-bridge.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omem-install-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function jsonSpec(id = 'test-json'): ClientSpec {
  return {
    id,
    name: 'Test',
    kind: 'json-mcp',
    configPath: () => join(dir, 'config.json'),
    detect: () => true,
    verified: false,
  };
}

describe('install: write disciplines', () => {
  it('new file: minimal config per shape', () => {
    const out = writeClientConfig(jsonSpec(), 'omem');
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(out.path, 'utf8'));
    expect(parsed.mcpServers.omem).toEqual({ command: 'omem', args: ['serve'] });
  });

  it('merge only, no overwrite: other mcpServers keys preserved', () => {
    const spec = jsonSpec();
    writeFileSync(spec.configPath(dir), JSON.stringify({ mcpServers: { other: { command: 'x' } }, userKey: 42 }));
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(out.path, 'utf8'));
    expect(parsed.mcpServers.other).toEqual({ command: 'x' });
    expect(parsed.userKey).toBe(42);
    expect(parsed.mcpServers.omem.args).toEqual(['serve']);
  });

  it('idempotent: repeated writes produce identical content', () => {
    const spec = jsonSpec();
    writeClientConfig(spec, 'omem');
    const out2 = writeClientConfig(spec, 'omem');
    const parsed = JSON.parse(readFileSync(out2.path, 'utf8'));
    expect(parsed.mcpServers.omem).toEqual({ command: 'omem', args: ['serve'] });
    expect(out2.backup).toBeTruthy(); // 写前备份
    const backups = readdirSync(dir).filter((f) => f.includes('.omem-backup-'));
    expect(backups.length).toBe(1);
  });

  it('JSONC tolerant: comments + trailing commas parse', () => {
    const spec = jsonSpec();
    writeFileSync(
      spec.configPath(dir),
      ['{', '  // 注释', '  "mcpServers": {', '    "a": { "command": "x" },', '  },', '}'].join('\n'),
    );
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(out.path, 'utf8'));
    expect(parsed.mcpServers.a).toEqual({ command: 'x' });
    expect(parsed.mcpServers.omem).toBeDefined();
  });

  it('parse failure → degrade to a printed manual snippet, original file untouched', () => {
    const spec = jsonSpec();
    const original = '{ 这不是合法 JSON !!!';
    writeFileSync(spec.configPath(dir), original);
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('Parse failed');
    expect(out.manual).toContain('mcpServers');
    expect(readFileSync(out.path, 'utf8')).toBe(original); // 原文件未动
  });

  it('continue array shape: push, not overwrite', () => {
    const spec: ClientSpec = {
      id: 'continue',
      name: 'Continue',
      kind: 'json-array-mcp',
      configPath: () => join(dir, 'continue.json'),
      detect: () => true,
      verified: false,
    };
    writeFileSync(spec.configPath(dir), JSON.stringify({ mcpServers: [{ name: 'other', command: 'x' }] }));
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(out.path, 'utf8'));
    expect(parsed.mcpServers).toHaveLength(2);
    expect(parsed.mcpServers[1]).toEqual({ name: 'omem', command: 'omem', args: ['serve'] });
  });

  it('codex TOML shape: round-trip preserves other keys', () => {
    const spec: ClientSpec = {
      id: 'codex',
      name: 'Codex',
      kind: 'toml-mcp',
      configPath: () => join(dir, 'config.toml'),
      detect: () => true,
      verified: false,
    };
    writeFileSync(spec.configPath(dir), 'model = "gpt-5"\n\n[history]\nmax_bytes = 1000\n');
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(true);
    const text = readFileSync(out.path, 'utf8');
    expect(text).toContain('[mcp_servers.omem]');
    expect(text).toContain('command = "omem"');
    expect(text).toContain('model = "gpt-5"'); // 其他配置保留
  });

  it('parseJsonc: valid JSON / invalid input', () => {
    expect(parseJsonc('{"a":1}').ok).toBe(true);
    expect(parseJsonc('{ bad').ok).toBe(false);
  });

  it('omemEntry shape matches spec §6.3', () => {
    expect(omemEntry('omem')).toEqual({ command: 'omem', args: ['serve'] });
  });
});

describe('install: generic MCP snippet for unlisted clients', () => {
  it('emits the community-standard mcpServers shape', () => {
    const snippet = renderGenericMcpSnippet('omem');
    const json = snippet.split('\n').filter((l) => !l.startsWith('#')).join('\n');
    expect(JSON.parse(json).mcpServers.omem).toEqual({ command: 'omem', args: ['serve'] });
  });

  it('is explicit that it is not written anywhere automatically', () => {
    expect(renderGenericMcpSnippet('omem')).toContain('paste into');
  });
});

describe('install: TOML section upsert is text-level (no destructive rewrite)', () => {
  // 真实 codex config.toml 含带引号段名（Windows 项目路径）与空表段；
  // 全量 parse→serialize 会把它们写坏，故写入必须是文本级段合并。
  const realistic = [
    'model = "gpt-5"',
    '',
    '[model_providers.custom]',
    'base_url = "https://x"',
    '',
    '[model_providers]',
    '',
    "[projects.'E:\\projects\\boss-sql']",
    'trust_level = "trusted"',
    '',
    '[mcp_servers.dbx]',
    'command = "dbx"',
    '',
  ].join('\n');

  function tomlSpec(): ClientSpec {
    return {
      id: 'codex',
      name: 'Codex',
      kind: 'toml-mcp',
      configPath: () => join(dir, 'config.toml'),
      detect: () => true,
      verified: false,
    };
  }

  it('adds the omem section and preserves every other byte-level structure', () => {
    const out = upsertTomlSection(realistic, 'mcp_servers.omem', omemEntry('omem'));
    expect('text' in out).toBe(true);
    const text = (out as { text: string }).text;
    expect(text).toContain('[mcp_servers.omem]');
    expect(text).toContain('command = "omem"');
    // 其他内容原样保留：带引号段名不被改写、空表段不丢失、既有 mcp 段还在
    expect(text).toContain("[projects.'E:\\projects\\boss-sql']");
    expect(text).not.toContain('projects."\\');
    expect(text).toContain('[model_providers]');
    expect(text).toContain('[mcp_servers.dbx]');
    expect(text).toContain('[model_providers.custom]');
  });

  it('is idempotent: a second upsert replaces the section instead of duplicating it', () => {
    const first = upsertTomlSection(realistic, 'mcp_servers.omem', omemEntry('omem')) as { text: string };
    const second = upsertTomlSection(first.text, 'mcp_servers.omem', omemEntry('omem')) as { text: string; action: string };
    expect(second.action).toBe('updated');
    expect(second.text.match(/\[mcp_servers\.omem\]/g)).toHaveLength(1);
  });

  it('updates an existing section in place and keeps what follows it', () => {
    const withOld = `${realistic}\n[mcp_servers.omem]\ncommand = "old"\nargs = ["x"]\n\n[tui]\nanimations = false\n`;
    const out = upsertTomlSection(withOld, 'mcp_servers.omem', omemEntry('omem')) as { text: string };
    expect(out.text).toContain('command = "omem"');
    expect(out.text).not.toContain('command = "old"');
    expect(out.text).toContain('[tui]');
    expect(out.text).toContain('animations = false');
  });

  it('refuses to append when the table is defined in a form it cannot rewrite', () => {
    const inline = '[mcp_servers]\nomem = { command = "omem", args = ["serve"] }\n';
    const out = upsertTomlSection(inline, 'mcp_servers.omem', omemEntry('omem'));
    expect('error' in out).toBe(true);
    expect((out as { error: string }).error).toContain('manually');
  });

  it('appends an explicit parent header when only a sub-table exists (legal TOML)', () => {
    const nested = '[mcp_servers.omem.extra]\nk = 1\n';
    const out = upsertTomlSection(nested, 'mcp_servers.omem', omemEntry('omem')) as { text: string; action: string };
    expect(out.action).toBe('added');
    expect(out.text.match(/\[mcp_servers\.omem\]/g)).toHaveLength(1);
    expect(out.text).toContain('[mcp_servers.omem.extra]');
  });

  it('refuses the inline form specifically (would be a duplicate table definition)', () => {
    const inline = '[mcp_servers]\ncodegraph = { command = "cg" }\nomem = { command = "x" }\n';
    const out = upsertTomlSection(inline, 'mcp_servers.omem', omemEntry('omem'));
    expect('error' in out).toBe(true);
  });

  it('writeClientConfig applies the text-level upsert (file on disk keeps other keys)', () => {
    const spec = tomlSpec();
    writeFileSync(spec.configPath(dir), realistic);
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(true);
    const text = readFileSync(out.path, 'utf8');
    expect(text).toContain('[mcp_servers.omem]');
    expect(text).toContain("[projects.'E:\\projects\\boss-sql']");
    expect(text).toContain('[model_providers]');
  });
});

describe('install: renderClientConfig pure render (--print-config read-only preview)', () => {
  it('raw=null: generates the full config for a new file', () => {
    const rendered = renderClientConfig(jsonSpec(), 'omem', null);
    expect(rendered.text).toBeDefined();
    expect(JSON.parse(rendered.text!).mcpServers.omem).toEqual({ command: 'omem', args: ['serve'] });
  });

  it('merge existing config: other keys preserved in the render', () => {
    const spec = jsonSpec();
    const raw = JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: 1 });
    const rendered = renderClientConfig(spec, 'omem', raw);
    const parsed = JSON.parse(rendered.text!);
    expect(parsed.mcpServers.other).toEqual({ command: 'x' });
    expect(parsed.keep).toBe(1);
    expect(parsed.mcpServers.omem.args).toEqual(['serve']);
  });

  it('TOML render contains [mcp_servers.omem]', () => {
    const spec: ClientSpec = {
      id: 'codex',
      name: 'Codex',
      kind: 'toml-mcp',
      configPath: () => join(dir, 'config.toml'),
      detect: () => true,
      verified: false,
    };
    const rendered = renderClientConfig(spec, 'omem', 'model = "gpt-5"\n');
    expect(rendered.text).toContain('[mcp_servers.omem]');
    expect(rendered.text).toContain('model = "gpt-5"');
  });

  it('parse failure: returns reason + manual, text undefined (caller must not write)', () => {
    const rendered = renderClientConfig(jsonSpec(), 'omem', '{ 坏 JSON');
    expect(rendered.text).toBeUndefined();
    expect(rendered.reason).toContain('Parse failed');
    expect(rendered.manual).toContain('mcpServers');
  });

  it('render has no side effects: same raw renders identically twice', () => {
    const spec = jsonSpec();
    const raw = JSON.stringify({ mcpServers: {} });
    expect(renderClientConfig(spec, 'omem', raw).text).toBe(renderClientConfig(spec, 'omem', raw).text);
  });
});

describe('install: previewClientConfig (--print-config shows the omem entry only, never the whole file)', () => {
  it('defect fix: existing file with many other keys → preview shows the omem entry and key names, not their values', () => {
    // 真实 ~/.claude.json 含 machineID、使用统计等隐私字段；整文件打印=泄进终端
    const spec = jsonSpec();
    const raw = JSON.stringify({
      numStartups: 76,
      machineID: 'deadbeefcafebabe',
      tipsHistory: { 'theme-command': 63 },
      mcpServers: { other: { command: 'x', env: { SECRET_TOKEN: 'sk-123' } } },
    });
    const text = previewClientConfig(spec, 'omem', raw);
    expect(text).toContain('"command": "omem"');
    expect(text).toContain('"serve"');
    expect(text).toContain('other'); // 原有 mcpServers 键名仍在（用户能确认不丢）
    expect(text).toContain('machineID'); // 顶层键名列出
    // 隐私与噪音：其他键的值、整个原文件结构都不出现
    expect(text).not.toContain('deadbeefcafebabe');
    expect(text).not.toContain('sk-123');
    expect(text).not.toContain('numStartups": 76');
    expect(text).not.toContain('"tipsHistory": {');
  });

  it('new file: says the target will be created', () => {
    const text = previewClientConfig(jsonSpec(), 'omem', null);
    expect(text).toContain('does not exist yet');
    expect(text).toContain('"command": "omem"');
  });

  it('unparseable existing file: says install will degrade to a manual snippet', () => {
    const text = previewClientConfig(jsonSpec(), 'omem', '{ 坏 JSON');
    expect(text).toContain('could not be parsed');
    expect(text).toContain('manual snippet');
  });

  it('TOML target: shows the section plus other section names, not their bodies', () => {
    const spec: ClientSpec = {
      id: 'codex',
      name: 'Codex',
      kind: 'toml-mcp',
      configPath: () => join(dir, 'config.toml'),
      detect: () => true,
      verified: false,
    };
    const raw = 'model = "gpt-5"\n\n[history]\nmax_bytes = 1000\n';
    const text = previewClientConfig(spec, 'omem', raw);
    expect(text).toContain('[mcp_servers.omem]');
    expect(text).toContain('command = "omem"');
    expect(text).toContain('[history]');
    expect(text).not.toContain('max_bytes'); // 段体不回显
  });

  it('continue array shape: previews a named array entry', () => {
    const spec: ClientSpec = {
      id: 'continue',
      name: 'Continue',
      kind: 'json-array-mcp',
      configPath: () => join(dir, 'continue.json'),
      detect: () => true,
      verified: false,
    };
    const text = previewClientConfig(spec, 'omem', JSON.stringify({ mcpServers: [{ name: 'other', command: 'x' }] }));
    expect(text).toContain('"name": "omem"');
    expect(text).toContain('other');
  });
});

describe('install: marker-fenced instruction section', () => {
  it('new file gets the marker section written', () => {
    const p = join(dir, 'CLAUDE.md');
    const { created } = writeMarkerSection(p);
    expect(created).toBe(true);
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('<!-- OMEM:START -->');
    expect(text).toContain('omem search');
    expect(text).toContain('<!-- OMEM:END -->');
  });

  it('idempotent replacement: rerun does not duplicate, user content preserved', () => {
    const p = join(dir, 'CLAUDE.md');
    writeFileSync(p, '# 我的手写规则\n\n保持原样\n');
    writeMarkerSection(p);
    writeMarkerSection(p);
    const text = readFileSync(p, 'utf8');
    expect(text.match(/<!-- OMEM:START -->/g)).toHaveLength(1);
    expect(text).toContain('我的手写规则');
    expect(text).toContain('保持原样');
  });

  it('markerSection contains four instructions', () => {
    const s = markerSection();
    expect(s).toContain('omem search');
    expect(s).toContain('omem add');
    expect(s).toContain('omem context --for');
    expect(s).toContain('save_memory');
  });
});

describe('install: manual-connector client (qwenwork)', () => {
  // 千问办公无用户可编辑配置文件：configPath 指向数据目录本身
  function qwenworkSpec(): ClientSpec {
    return {
      id: 'qwenwork',
      name: 'QwenWork',
      kind: 'manual-connector',
      configPath: () => dir, // 目录，存在但不是文件
      detect: () => true,
      verified: true,
    };
  }

  it('renderClientConfig always degrades to the in-app snippet (no file write shape)', () => {
    const out = renderClientConfig(qwenworkSpec(), 'omem', null);
    expect(out.text).toBeUndefined();
    expect(out.reason).toBeTruthy();
    expect(out.manual).toContain('Custom MCP');
    expect(out.manual).toContain('"command": "omem"');
    expect(out.manual).toContain('"serve"');
  });

  it('previewClientConfig prints the snippet instead of reading the directory', () => {
    const text = previewClientConfig(qwenworkSpec(), 'omem', null);
    expect(text).toContain('Custom MCP');
    expect(text).toContain('"args"');
  });

  it('writeClientConfig does not throw when configPath is an existing directory', () => {
    const out = writeClientConfig(qwenworkSpec(), 'omem');
    expect(out.ok).toBe(false);
    expect(out.manual).toBeTruthy();
    expect(out.backup).toBeUndefined(); // 不读不写不备份
    // 目录内容未被改动（没有创建任何备份/临时文件）
    expect(readdirSync(dir).some((f) => f.includes('omem-backup') || f.includes('.tmp-'))).toBe(false);
  });

  it('registry: qwenwork is registered as manual-connector and detects ~/.qwenworkcn', () => {
    const spec = getClient('qwenwork');
    expect(spec.kind).toBe('manual-connector');
    expect(spec.verified).toBe(true);
    expect(CLIENTS.some((c) => c.id === 'qwenwork')).toBe(true);
    // detect：临时 home 下建 .qwenworkcn 目录即命中
    const home = join(dir, 'home');
    mkdirSync(join(home, '.qwenworkcn'), { recursive: true });
    expect(spec.detect(home)).toBe(true);
    expect(spec.detect(dir)).toBe(false); // 无 .qwenworkcn 的目录不命中
  });
});

describe('install: manual-connector client (doubao)', () => {
  function doubaoSpec(): ClientSpec {
    return {
      id: 'doubao',
      name: 'Doubao',
      kind: 'manual-connector',
      configPath: () => dir, // 目录，存在但不是文件
      detect: () => true,
      verified: true,
    };
  }

  it('renderClientConfig always degrades to the in-app snippet (no file write shape)', () => {
    const out = renderClientConfig(doubaoSpec(), 'omem', null);
    expect(out.text).toBeUndefined();
    expect(out.reason).toBeTruthy();
    expect(out.manual).toContain('Doubao');
    expect(out.manual).toContain('"command": "omem"');
    expect(out.manual).toContain('"serve"');
  });

  it('previewClientConfig prints the doubao snippet, not the qwenwork wording', () => {
    const text = previewClientConfig(doubaoSpec(), 'omem', null);
    expect(text).toContain('Doubao');
    expect(text).toContain('"args"');
    expect(text).not.toContain('QwenWork');
    expect(text).not.toContain('Custom MCP');
  });

  it('writeClientConfig does not throw when configPath is an existing directory', () => {
    const out = writeClientConfig(doubaoSpec(), 'omem');
    expect(out.ok).toBe(false);
    expect(out.manual).toBeTruthy();
    expect(out.backup).toBeUndefined(); // 不读不写不备份
    expect(readdirSync(dir).some((f) => f.includes('omem-backup') || f.includes('.tmp-'))).toBe(false);
  });

  it('registry: doubao is registered as manual-connector', () => {
    const spec = getClient('doubao');
    expect(spec.kind).toBe('manual-connector');
    expect(spec.verified).toBe(true);
    expect(CLIENTS.some((c) => c.id === 'doubao')).toBe(true);
  });
});

describe('install: manual-connector client (doubao)', () => {
  function doubaoSpec(): ClientSpec {
    return {
      id: 'doubao',
      name: 'Doubao',
      kind: 'manual-connector',
      configPath: () => dir, // 目录，存在但不是文件
      detect: () => true,
      verified: true,
    };
  }

  it('renderClientConfig always degrades to the in-app snippet (no file write shape)', () => {
    const out = renderClientConfig(doubaoSpec(), 'omem', null);
    expect(out.text).toBeUndefined();
    expect(out.reason).toBeTruthy();
    expect(out.manual).toContain('Doubao');
    expect(out.manual).toContain('"command": "omem"');
    expect(out.manual).toContain('"serve"');
  });

  it('previewClientConfig prints the doubao snippet, not the qwenwork wording', () => {
    const text = previewClientConfig(doubaoSpec(), 'omem', null);
    expect(text).toContain('Doubao');
    expect(text).toContain('"args"');
    expect(text).not.toContain('QwenWork');
    expect(text).not.toContain('Custom MCP');
  });

  it('writeClientConfig does not throw when configPath is an existing directory', () => {
    const out = writeClientConfig(doubaoSpec(), 'omem');
    expect(out.ok).toBe(false);
    expect(out.manual).toBeTruthy();
    expect(out.backup).toBeUndefined(); // 不读不写不备份
    expect(readdirSync(dir).some((f) => f.includes('omem-backup') || f.includes('.tmp-'))).toBe(false);
  });

  it('registry: doubao is registered as manual-connector', () => {
    const spec = getClient('doubao');
    expect(spec.kind).toBe('manual-connector');
    expect(spec.verified).toBe(true);
    expect(CLIENTS.some((c) => c.id === 'doubao')).toBe(true);
  });
});
