// 工具面的上下文税（beta.9.1 / P1-4）。
//
// 判据：`tools/list` 的 payload 每一轮会话都要付一次。QA 实测 beta.8 = 9,569 字符（同口径：
// [{name,description,inputSchema,outputSchema}]），beta.9 一度涨到 11,893（+24.3%），折回
// QA 原始口径 ≈12,543，越过 S3 的 12,500 门槛 —— 那会让 beta.10 的四工具预算一开始就不成立。
//
// 现在的口径与剩余空间：
//   全量 JSON（含 title/annotations）= 11,558（本测试钉 ≤12,300）
//   beta.10 还要加 topic_list(+700) 与 pending_memory(+900)：12,300 + 1,600 = 13,900 > 12,500，
//   所以 T08（把 save_memory / search_memory 的描述改成引用 RULE_ 常量）仍需再压 ~1,400。
import { describe, it, expect } from 'vitest';
import { buildTools } from '../../src/mcp/tools.js';

const tools = buildTools({});
const slim = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema }));

describe('tools/list 的体积预算', () => {
  it('全量 payload ≤ 12,300 字符（QA 原始 12,500 门槛下的余量）', () => {
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(12_300);
  });

  it('同 QC 口径（去协议外层）也在预算内，且不再超过 beta.8 + 2,731（92% 增幅预算）', () => {
    const size = JSON.stringify(slim).length;
    expect(size).toBeLessThanOrEqual(12_300);
    // beta.8 同口径 9,569：允许的增量上限（12,300 - 9,569）
    expect(size - 9_569).toBeLessThanOrEqual(2_731);
  });

  it('T04 新增的三个参数描述合计 ≤600 字符（新增参数要给 beta.10 留位）', () => {
    const search = tools.find((t) => t.name === 'search_memory')!;
    const props = search.inputSchema.properties as Record<string, unknown>;
    const total = ['session_id', 'offset', 'limit']
      .map((k) => JSON.stringify(props[k]).length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(600);
  });

  it('工具面本身没有扩张（仍 2 个 / feedback 只多一个）', () => {
    expect(tools.map((t) => t.name)).toEqual(['search_memory', 'save_memory']);
    expect(buildTools({ OMEM_MCP_TOOLS: 'feedback' }).map((t) => t.name)).toEqual(['search_memory', 'save_memory', 'memory_feedback']);
  });
});
