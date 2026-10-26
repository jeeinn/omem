// CodeBuddy 的 install 接线：MCP 配置写入 ~/.codebuddy/mcp.json（国际版）
// 与 ~/.codebuddycn/mcp.json（中文版）。
//
// 2026-10-26 本机实测：~/.codebuddy/mcp.json 存在，格式是
// {"mcpServers": {...}}，与 Cursor / Claude Desktop 同构；里面已有 omem 条目
// （说明这条路径此前就被用过）。所以 codebuddy 走 json-mcp kind，直接写文件。
//
// 注意：writeClientConfig 内部用 homedir() 解析路径，所以验证写入行为必须
// 用指向临时目录的自定义 spec——直接调真实客户端会写到用户真实的
// ~/.codebuddy/mcp.json。真实客户端本身只验证路径定义（纯函数，无副作用）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENTS, getClient, type ClientSpec } from '../../src/install/clients.js';
import { writeClientConfig } from '../../src/install/writer.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omem-cb-install-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 指向临时目录的 codebuddy 规格——写入行为验证用它，不碰真实 home。 */
function tempCodeBuddySpec(): ClientSpec {
  return {
    id: 'codebuddy',
    name: 'CodeBuddy',
    kind: 'json-mcp',
    configPath: () => join(dir, 'mcp.json'),
    detect: () => true,
    verified: true,
  };
}

describe('install: CodeBuddy client registration', () => {
  it('is registered with the json-mcp kind and a verified path', () => {
    const spec = getClient('codebuddy');
    expect(spec.kind).toBe('json-mcp');
    expect(spec.verified).toBe(true);
    expect(spec.configPath('/fake/home')).toBe(join('/fake/home', '.codebuddy', 'mcp.json'));
  });

  it('registers the Chinese edition as a separate client', () => {
    const spec = getClient('codebuddy-cn');
    expect(spec.kind).toBe('json-mcp');
    expect(spec.configPath('/fake/home')).toBe(join('/fake/home', '.codebuddycn', 'mcp.json'));
    // 本机没有核实过 CN 版，标注必须诚实。
    expect(spec.verified).toBe(false);
  });

  it('detects the international edition by its home directory', () => {
    expect(getClient('codebuddy').detect(dir)).toBe(false);
    mkdirSync(join(dir, '.codebuddy'), { recursive: true });
    expect(getClient('codebuddy').detect(dir)).toBe(true);
  });

  it('both CodeBuddy clients appear in the registry', () => {
    const ids = CLIENTS.map((c) => c.id);
    expect(ids).toContain('codebuddy');
    expect(ids).toContain('codebuddy-cn');
  });
});

describe('install: CodeBuddy config writing', () => {
  it('writes the omem entry without touching the other servers', () => {
    const spec = tempCodeBuddySpec();
    writeFileSync(
      spec.configPath(dir),
      JSON.stringify({
        mcpServers: {
          Context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], type: 'stdio' },
          dbx: { command: 'C:\\Users\\wei\\.dbx/bin/dbx-mcp.exe', disabled: true },
        },
        userKey: 42,
      }),
    );
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(out.path, 'utf8'));
    expect(parsed.mcpServers.omem).toEqual({ command: 'omem', args: ['serve'] });
    // 其他服务器与顶层键原样保留——install 只 merge mcpServers.omem。
    expect(parsed.mcpServers.Context7.type).toBe('stdio');
    expect(parsed.mcpServers.dbx.disabled).toBe(true);
    expect(parsed.userKey).toBe(42);
  });

  it('is idempotent: writing twice leaves identical content', () => {
    const spec = tempCodeBuddySpec();
    writeClientConfig(spec, 'omem');
    const first = readFileSync(spec.configPath(dir), 'utf8');
    writeClientConfig(spec, 'omem');
    expect(readFileSync(spec.configPath(dir), 'utf8')).toBe(first);
  });

  it('backs up the file before writing', () => {
    const spec = tempCodeBuddySpec();
    writeFileSync(spec.configPath(dir), JSON.stringify({ mcpServers: {} }));
    writeClientConfig(spec, 'omem');
    const backups = readdirSync(dir).filter((f) => f.includes('omem-backup'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('creates the file when it does not exist yet', () => {
    const spec = tempCodeBuddySpec();
    const out = writeClientConfig(spec, 'omem');
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(out.path, 'utf8'));
    expect(parsed.mcpServers.omem).toEqual({ command: 'omem', args: ['serve'] });
  });
});
