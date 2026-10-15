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

describe('install: 写入纪律', () => {
  it('新文件：按形态写最小配置', () => {
    const out = writeClientConfig(jsonSpec(), 'omem');
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(out.path, 'utf8'));
    expect(parsed.mcpServers.omem).toEqual({ command: 'omem', args: ['serve'] });
  });

  it('只 merge 不覆盖：其他 mcpServers 键保留', () => {
    const spec = jsonSpec();
    writeFileSync(spec.configPath(dir), JSON.stringify({ mcpServers: { other: { command: 'x' } }, userKey: 42 }));
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(out.path, 'utf8'));
    expect(parsed.mcpServers.other).toEqual({ command: 'x' });
    expect(parsed.userKey).toBe(42);
    expect(parsed.mcpServers.omem.args).toEqual(['serve']);
  });

  it('幂等：重复写入内容一致', () => {
    const spec = jsonSpec();
    writeClientConfig(spec, 'omem');
    const out2 = writeClientConfig(spec, 'omem');
    const parsed = JSON.parse(readFileSync(out2.path, 'utf8'));
    expect(parsed.mcpServers.omem).toEqual({ command: 'omem', args: ['serve'] });
    expect(out2.backup).toBeTruthy(); // 写前备份
    const backups = readdirSync(dir).filter((f) => f.includes('.omem-backup-'));
    expect(backups.length).toBe(1);
  });

  it('JSONC 容错：注释 + 尾随逗号可解析', () => {
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

  it('解析失败 → 降级打印手工片段，不动原文件', () => {
    const spec = jsonSpec();
    const original = '{ 这不是合法 JSON !!!';
    writeFileSync(spec.configPath(dir), original);
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('解析失败');
    expect(out.manual).toContain('mcpServers');
    expect(readFileSync(out.path, 'utf8')).toBe(original); // 原文件未动
  });

  it('continue 数组形态：push 而非覆盖', () => {
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

  it('codex TOML 形态：往返保留其他键', () => {
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

  it('parseJsonc：合法 JSON / 非法输入', () => {
    expect(parseJsonc('{"a":1}').ok).toBe(true);
    expect(parseJsonc('{ bad').ok).toBe(false);
  });

  it('omemEntry 形状符合规格 §6.3', () => {
    expect(omemEntry('omem')).toEqual({ command: 'omem', args: ['serve'] });
  });
});

describe('install: renderClientConfig 纯渲染（--print-config 只读预览）', () => {
  it('raw=null：生成新建形态的完整配置', () => {
    const rendered = renderClientConfig(jsonSpec(), 'omem', null);
    expect(rendered.text).toBeDefined();
    expect(JSON.parse(rendered.text!).mcpServers.omem).toEqual({ command: 'omem', args: ['serve'] });
  });

  it('merge 已有配置：其他键保留在渲染结果里', () => {
    const spec = jsonSpec();
    const raw = JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: 1 });
    const rendered = renderClientConfig(spec, 'omem', raw);
    const parsed = JSON.parse(rendered.text!);
    expect(parsed.mcpServers.other).toEqual({ command: 'x' });
    expect(parsed.keep).toBe(1);
    expect(parsed.mcpServers.omem.args).toEqual(['serve']);
  });

  it('TOML 形态渲染含 [mcp_servers.omem]', () => {
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

  it('解析失败：返回 reason + manual，text 为 undefined（调用方不得落盘）', () => {
    const rendered = renderClientConfig(jsonSpec(), 'omem', '{ 坏 JSON');
    expect(rendered.text).toBeUndefined();
    expect(rendered.reason).toContain('解析失败');
    expect(rendered.manual).toContain('mcpServers');
  });

  it('渲染无副作用：同一 raw 渲染两次结果一致', () => {
    const spec = jsonSpec();
    const raw = JSON.stringify({ mcpServers: {} });
    expect(renderClientConfig(spec, 'omem', raw).text).toBe(renderClientConfig(spec, 'omem', raw).text);
  });
});

describe('install: marker-fenced 指令段', () => {
  it('新建文件写入 marker 段', () => {
    const p = join(dir, 'CLAUDE.md');
    const { created } = writeMarkerSection(p);
    expect(created).toBe(true);
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('<!-- OMEM:START -->');
    expect(text).toContain('omem search');
    expect(text).toContain('<!-- OMEM:END -->');
  });

  it('幂等替换：重跑不重复，用户手写内容保留', () => {
    const p = join(dir, 'CLAUDE.md');
    writeFileSync(p, '# 我的手写规则\n\n保持原样\n');
    writeMarkerSection(p);
    writeMarkerSection(p);
    const text = readFileSync(p, 'utf8');
    expect(text.match(/<!-- OMEM:START -->/g)).toHaveLength(1);
    expect(text).toContain('我的手写规则');
    expect(text).toContain('保持原样');
  });

  it('markerSection 内容含四条指令', () => {
    const s = markerSection();
    expect(s).toContain('omem search');
    expect(s).toContain('omem add');
    expect(s).toContain('omem context --for');
    expect(s).toContain('save_memory');
  });
});
