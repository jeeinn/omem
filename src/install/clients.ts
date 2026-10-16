// 客户端注册表（规格 §6.3）。
// verified=true 表示配置路径已核实（workbuddy 在本机核实）；其余标注"待核"——路径随版本漂移，install --list 明示。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ClientKind =
  | 'json-mcp' // {"mcpServers": {"omem": {command, args}}}
  | 'json-array-mcp' // continue: {"mcpServers": [{name, command, args}]}
  | 'json-zed' // zed: {"context_servers": {"omem": {command: {path, args}}}}
  | 'toml-mcp'; // codex: [mcp_servers.omem]

export interface ClientSpec {
  id: string;
  name: string;
  kind: ClientKind;
  configPath(home: string): string;
  detect(home: string): boolean;
  verified: boolean;
  note?: string;
}

function win(paths: { win: string; mac: string; linux?: string }): string {
  if (process.platform === 'win32') return paths.win;
  if (process.platform === 'darwin') return paths.mac;
  return paths.linux ?? paths.mac;
}

const APPDATA = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');

export const CLIENTS: ClientSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'json-mcp',
    configPath: (h) => join(h, '.claude.json'),
    detect: (h) => existsSync(join(h, '.claude')) || existsSync(join(h, '.claude.json')),
    verified: false,
    note: 'The official `claude mcp add` command also works',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    kind: 'json-mcp',
    configPath: () =>
      win({
        win: join(APPDATA, 'Claude', 'claude_desktop_config.json'),
        mac: join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        linux: join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
      }),
    detect: () => existsSync(win({ win: join(APPDATA, 'Claude'), mac: join(homedir(), 'Library', 'Application Support', 'Claude') })),
    verified: false,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'json-mcp',
    configPath: (h) => join(h, '.cursor', 'mcp.json'),
    detect: (h) => existsSync(join(h, '.cursor')),
    verified: true, // 本机已核实：~/.cursor/mcp.json
    note: 'Project-level .cursor/mcp.json is also supported',
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    kind: 'json-mcp',
    configPath: (h) => join(h, '.workbuddy', 'mcp.json'),
    detect: (h) => existsSync(join(h, '.workbuddy')),
    verified: true, // 本机已核实：~/.workbuddy/mcp.json（不是带点前缀的 .mcp.json）
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    kind: 'toml-mcp',
    configPath: (h) => join(h, '.codex', 'config.toml'),
    detect: (h) => existsSync(join(h, '.codex')),
    verified: false,
    note: 'TOML format [mcp_servers.omem]',
  },
  {
    id: 'continue',
    name: 'Continue',
    kind: 'json-array-mcp',
    configPath: (h) => join(h, '.continue', 'config.json'),
    detect: (h) => existsSync(join(h, '.continue')),
    verified: false,
    note: 'mcpServers is an array',
  },
  {
    id: 'zed',
    name: 'Zed',
    kind: 'json-zed',
    configPath: (h) => join(h, '.config', 'zed', 'settings.json'),
    detect: (h) => existsSync(join(h, '.config', 'zed')),
    verified: false,
    note: 'context_servers nests a command object; format drifts across versions, unverified',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    kind: 'json-mcp',
    configPath: (h) => join(h, '.codeium', 'windsurf', 'mcp_config.json'),
    detect: (h) => existsSync(join(h, '.codeium', 'windsurf')),
    verified: false,
  },
  {
    id: 'cline',
    name: 'Cline',
    kind: 'json-mcp',
    configPath: () =>
      win({
        win: join(APPDATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
        mac: join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
        linux: join(homedir(), '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
      }),
    detect: () =>
      existsSync(join(APPDATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')),
    verified: false,
    note: 'VS Code extension storage path; drifts across versions, unverified',
  },
];

export function getClient(id: string): ClientSpec {
  const c = CLIENTS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown client: ${id} (run omem install --list to see supported clients)`);
  return c;
}
