// 共享上下文：加载 config + 打开索引。未初始化时给出可操作提示。
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import type { OmemConfig } from './config.js';
import { OmemIndex } from './index.js';
import { omemHome } from './paths.js';
import { UsageError } from './util.js';

export interface Ctx {
  home: string;
  config: OmemConfig;
  index: OmemIndex;
}

export function openCtx(opts: { create?: boolean } = {}): Ctx {
  const home = omemHome();
  if (!existsSync(home) && !opts.create) {
    throw new UsageError(`未初始化：${home} 不存在。先运行 omem init`);
  }
  const config = loadConfig(home);
  const index = new OmemIndex(home);
  // 一致性协议（规格 §2.3）：下次访问即检出外部编辑（Obsidian 改了文件）→ 增量重建。
  // MVP 规模（<1 万条）下同步对账成本可忽略；规模化后应改为 watcher 推送 + 启动时抽检。
  index.catchUp();
  return { home, config, index };
}
