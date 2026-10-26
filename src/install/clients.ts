// 客户端注册表（规格 §6.3）。
// verified=true 表示配置路径已核实（workbuddy 在本机核实）；其余标注"待核"——路径随版本漂移，install --list 明示。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ClientKind =
  | 'json-mcp' // {"mcpServers": {"omem": {command, args}}}
  | 'json-array-mcp' // continue: {"mcpServers": [{name, command, args}]}
  | 'json-zed' // zed: {"context_servers": {"omem": {command: {path, args}}}}
  | 'toml-mcp' // codex: [mcp_servers.omem]
  | 'manual-connector'; // qwenwork: MCP servers live inside the app; install prints an in-app add snippet

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
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');

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
    id: 'qwenwork',
    name: 'QwenWork',
    kind: 'manual-connector',
    // 千问办公没有用户可编辑的 MCP 配置文件：自定义 MCP 存在应用内部数据里，
    // 只能通过应用内「设置 → 连接器 → 自定义 MCP」或会话内让 agent 调 Connector 添加。
    // configPath 只用于 --list 展示检测依据（数据目录存在 = 已安装）。
    configPath: (h) => join(h, '.qwenworkcn'),
    detect: (h) => existsSync(join(h, '.qwenworkcn')),
    verified: true, // 本机已核实：无文件形态配置，install 打印应用内添加指引
  },
  {
    id: 'doubao',
    name: 'Doubao',
    kind: 'manual-connector',
    // 豆包办公桌面端与千问办公同形态：自定义 MCP 存在应用内部（mcp_helper / MCP 管理页），
    // 没有用户可编辑的配置文件。configPath 仅用于 --list 展示 detect 依据（数据目录存在 = 已安装）。
    configPath: () =>
      win({
        win: join(LOCALAPPDATA, 'Doubao'),
        mac: join(homedir(), 'Library', 'Application Support', 'Doubao'),
        linux: join(homedir(), '.doubao'),
      }),
    detect: () =>
      existsSync(win({ win: join(LOCALAPPDATA, 'Doubao'), mac: join(homedir(), 'Library', 'Application Support', 'Doubao'), linux: join(homedir(), '.doubao') })),
    verified: true, // 本机（Windows）已核实：%LOCALAPPDATA%/Doubao 存在，无用户可编辑 MCP 文件
    note: 'MCP servers are managed inside the app; install prints an in-app add snippet',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Harness',
    kind: 'manual-connector',
    // DeepSeek Harness 桌面端 MCP 配置在应用内部管理，没有用户可编辑的配置文件。
    // configPath 仅用于 --list 展示 detect 依据（数据目录存在 = 已安装）。
    configPath: () =>
      win({
        win: join(LOCALAPPDATA, 'DeepSeek'),
        mac: join(homedir(), 'Library', 'Application Support', 'DeepSeek'),
        linux: join(homedir(), '.dsh'),
      }),
    detect: () =>
      existsSync(win({ win: join(LOCALAPPDATA, 'DeepSeek'), mac: join(homedir(), 'Library', 'Application Support', 'DeepSeek'), linux: join(homedir(), '.dsh') })),
    verified: false, // 本机未核实：DeepSeek Harness 桌面端形态待确认
    note: 'MCP servers are managed inside the app; install prints an in-app add snippet',
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
