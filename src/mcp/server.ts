// MCP server（规格 §8）：stdio 传输，官方 TS SDK。
// 纪律：stdout 只走 MCP 协议——一切日志走 stderr 或 logs/omem.log。
// connect-time catch-up（规格 §2.3）：启动时先做 (size,mtime)+hash 对账，
// 吸收 server 未运行期间发生的改动（终端操作、其他编辑器、上次会话退出后的修改）。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { OmemIndex } from '../core/index.js';
import { loadConfig } from '../core/config.js';
import type { OmemConfig } from '../core/config.js';
import { buildTools, handleTool } from './tools.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';
import { OMEM_VERSION } from '../core/version.js';
import { mcpInstructions } from '../context/instructions.js';

/** 工具调用前对账。长驻 server 不重连也能吸收会话中途的外部编辑。 */
export function prepareToolCall(home: string, index: OmemIndex): void {
  const catchUp = index.catchUp();
  if (catchUp.reindexed > 0 || catchUp.removed > 0) {
    generateMemoryIndex(home, index);
    console.error(`[omem] tool-call catch-up: scanned ${catchUp.scanned}, reindexed ${catchUp.reindexed}, removed ${catchUp.removed}`);
  }
}

export async function startMcpServer(home: string): Promise<void> {
  // config 可变：长驻进程里用户改了 config.toml 却必须重启客户端才生效，会被误判成「改了没用」。
  // 每次工具调用做一次 mtime 比对（与 catch-up 同时机），变了就整体替换。
  let config: OmemConfig = loadConfig(home);
  let configMtime = configFileMtime(home);

  const index = new OmemIndex(home);
  const catchUp = index.catchUp();
  if (catchUp.reindexed > 0 || catchUp.removed > 0) {
    generateMemoryIndex(home, index);
    console.error(`[omem] connect-time catch-up: scanned ${catchUp.scanned}, reindexed ${catchUp.reindexed}, removed ${catchUp.removed}`);
  }
  // 版本 + pid + 启动时间：升级后旧进程仍活着时，这是唯一能区分「跑的是哪个 build」的证据。
  appendLog(home, 'mcp.start', {
    version: OMEM_VERSION,
    pid: process.pid,
    started_at: new Date().toISOString(),
    ...(catchUp as unknown as Record<string, unknown>),
  });

  const server = new Server(
    { name: 'omem', version: OMEM_VERSION },
    {
      capabilities: { tools: {} },
      // instructions 是 InitializeResult 的顶层字段（SDK: ServerOptions.instructions）。
      // 没有它，save_memory 描述里「先读 omem instructions 拿 PROCESS.md 路径」就无法兑现。
      instructions: mcpInstructions(home),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    prepareToolCall(home, index);
    const mtime = configFileMtime(home);
    if (mtime !== configMtime) {
      try {
        config = loadConfig(home);
        configMtime = mtime;
      } catch (err) {
        // 配置写坏了就继续用旧值，别让一次工具调用连带失效。
        console.error(`[omem] config reload failed, keeping previous values: ${(err as Error).message}`);
      }
    }
    const { name, arguments: args } = request.params;
    return handleTool(name, (args ?? {}) as Record<string, any>, { home, config, index });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[omem] MCP server started (stdio) v${OMEM_VERSION} — tools: ${buildTools().map((t) => t.name).join(', ')}`,
  );
}

/** config.toml 的 mtime；文件不存在返回 0（与「存在且被改过」区分开）。 */
function configFileMtime(home: string): number {
  try {
    return statSync(join(home, 'config.toml')).mtimeMs;
  } catch {
    return 0;
  }
}
