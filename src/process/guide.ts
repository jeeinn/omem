// 档 2：Agent 协作批量加工（规格 §9.4——"借本地 agent 能力"的真正落地方式）。
// omem 不做推理，只打印引导 + 会话摘录；Agent 提炼后通过 save_memory / omem add 回写。
import { truncate } from '../core/util.js';
import type { SessionDigest } from '../collect/types.js';

export function printGuide(digests: SessionDigest[], maxChars = 600): void {
  const total = digests.reduce((n, d) => n + d.messages.length, 0);
  console.log('## omem 批量加工引导（档 2：Agent 协作，零配置）');
  console.log('');
  console.log(`以下为 ${digests.length} 个会话、共 ${total} 条消息的摘录。请逐会话提炼值得长期记忆的条目：`);
  console.log('- 类型：偏好 / 事实 / 决策 / 经验；每条 3–10 句，一条一事');
  console.log('- 结论入库，过程丢弃；不要编造未出现的信息；指令式语气标注低权重');
  console.log('- 对每条调用 MCP 工具 save_memory(content, type, domain, tags)，或 CLI：omem add "<内容>"');
  console.log('- omem 负责去重、组织与索引，无需担心重复写入');
  console.log('');
  for (const d of digests) {
    console.log(`### 会话 ${d.session_id}（项目 ${d.project_fp}，${d.messages.length} 条消息）`);
    for (const m of d.messages.slice(0, 40)) {
      console.log(`[${m.role}] ${truncate(m.content, maxChars)}`);
    }
    if (d.messages.length > 40) console.log(`…另有 ${d.messages.length - 40} 条消息未展示`);
    console.log('');
  }
}
