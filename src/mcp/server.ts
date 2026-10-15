// MCP server（规格 §8）：stdio 传输，官方 TS SDK。
// 纪律：stdout 只走 MCP 协议——一切日志走 stderr 或 logs/omem.log。
// connect-time catch-up（规格 §2.3）：启动时先做 (size,mtime)+hash 对账，
// 吸收 server 未运行期间发生的改动（终端操作、其他编辑器、上次会话退出后的修改）。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OmemIndex } from '../core/index.js';
import { loadConfig } from '../core/config.js';
import { buildTools, handleTool } from './tools.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';

/** 工具调用前对账。长驻 server 不重连也能吸收会话中途的外部编辑。 */
export function prepareToolCall(home: string, index: OmemIndex): void {
  const catchUp = index.catchUp();
  if (catchUp.reindexed > 0 || catchUp.removed > 0) {
    generateMemoryIndex(home, index);
    console.error(`[omem] tool-call catch-up: 扫描 ${catchUp.scanned}，重索引 ${catchUp.reindexed}，移除 ${catchUp.removed}`);
  }
}

export async function startMcpServer(home: string): Promise<void> {
  const config = loadConfig(home);
  const index = new OmemIndex(home);
  const catchUp = index.catchUp();
  if (catchUp.reindexed > 0 || catchUp.removed > 0) {
    generateMemoryIndex(home, index);
    console.error(`[omem] connect-time catch-up: 扫描 ${catchUp.scanned}，重索引 ${catchUp.reindexed}，移除 ${catchUp.removed}`);
  }
  appendLog(home, 'mcp.start', catchUp as unknown as Record<string, unknown>);

  const server = new Server(
    { name: 'omem', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    prepareToolCall(home, index);
    const { name, arguments: args } = request.params;
    return handleTool(name, (args ?? {}) as Record<string, any>, { home, config, index });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[omem] MCP server started (stdio) — tools: ' + buildTools().map((t) => t.name).join(', '));
}
