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
} from '../../src/install/writer.js';
import type { ClientSpec } from '../../src/install/clients.js';

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
