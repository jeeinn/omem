// 工具面的上下文税（beta.9.1 / P1-4）。
//
// 判据：`tools/list` 的 payload 每一轮会话都要付一次。
//
// 2026-11-23 口径调整：新增只读诊断 `omem_status`（version / store / counts / collector health）。
// 加它是为了回答「升级包了，MCP 还跑着旧代码吗」——serverInfo 不进 tools/list，
// 没有这个工具调用方只能猜。三个工具的实测体积：
//   search_memory 6,085 + save_memory 6,347 + omem_status ≈464 + 数组外壳 = 12,8xx
// 因此上限从 12,300 上调到 13,000（新增工具的真实成本，不是放宽质量要求）。
// 若要回到 12,300，需要做 T08：把 search/save 的描述改成引用 RULE_ 常量，约能省 1,400。
import { describe, it, expect } from 'vitest';
import { buildTools } from '../../src/mcp/tools.js';

const tools = buildTools({});
const slim = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema }));

describe('tools/list 的体积预算', () => {
  it('全量 payload ≤ 13,000 字符（含新增只读诊断工具）', () => {
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(13_000);
  });

  it('同 QC 口径（去协议外层）也在预算内', () => {
    const size = JSON.stringify(slim).length;
    expect(size).toBeLessThanOrEqual(13_000);
    // 9,569 是 beta.8 基线；增量预算随之放宽（原 2,731 → 3,431）。
    expect(size - 9_569).toBeLessThanOrEqual(3_431);
  });

  it('T04 新增的三个参数描述合计 ≤600 字符（新增参数要给后续留位）', () => {
    const search = tools.find((t) => t.name === 'search_memory')!;
    const props = search.inputSchema.properties as Record<string, unknown>;
    const total = ['session_id', 'offset', 'limit']
      .map((k) => JSON.stringify(props[k]).length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(600);
  });

  it('默认工具面 = 两个读写工具 + 一个只读诊断；feedback 仍按需开启', () => {
    expect(tools.map((t) => t.name)).toEqual(['search_memory', 'save_memory', 'omem_status']);
    expect(buildTools({ OMEM_MCP_TOOLS: 'feedback' }).map((t) => t.name)).toEqual([
      'search_memory',
      'save_memory',
      'omem_status',
      'memory_feedback',
    ]);
    // 诊断工具必须声明为只读，客户端据此判断要不要提示用户授权。
    expect(tools.find((t) => t.name === 'omem_status')?.annotations?.readOnlyHint).toBe(true);
  });
});
