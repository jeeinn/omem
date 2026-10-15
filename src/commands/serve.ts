// omem serve：启动 MCP server（stdio）。stdout 只走协议，日志走 stderr（server.ts 内保证）。
import { existsSync } from 'node:fs';
import { ensureHome } from '../core/paths.js';
import { startMcpServer } from '../mcp/server.js';
import { omemHome } from '../core/paths.js';

export async function cmdServe(): Promise<number> {
  const home = omemHome();
  if (!existsSync(home)) {
    // 零配置承诺：未初始化也能起服务（自动建骨架，不出现 key 提示）
    ensureHome(home);
  }
  await startMcpServer(home);
  // server 生命周期由 stdio transport 维持（stdin EOF → transport 关闭 → 进程自然退出）。
  // 此处返回永不 resolve 的 Promise，防止 cli.ts 的 process.exit 在 server 就绪后立即终止进程。
  return new Promise<never>(() => {});
}
