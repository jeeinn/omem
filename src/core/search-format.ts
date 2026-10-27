// 零命中文案的唯一实现：CLI 与 MCP 共用。
//
// 为什么抽出来：MCP 侧原先只有一句 "No memories found"，而 domain / project 拼错时
// 输出与"库里真的没有这件事"完全相同——调用方会得出「用户没记过」的错误结论。
// CLI 侧另有一份措辞不同的 Tip，两边长期各自演化。
export interface NoHitsContext {
  query?: string;
  topic?: string;
  domain?: string;
  project?: string;
}

export interface NoHitsOptions {
  /** CLI 额外提示 --all（MCP 用 status 参数表达同一件事）。 */
  cli?: boolean;
}

/**
 * 生成零结果说明。返回值是行数组，调用方决定用 console.log 还是拼进 MCP 响应。
 *
 * 核心区别：带过滤条件时，必须把「可能写错」这个可能性说出来。
 * 没有这句，模型会把「过滤器不匹配」误当成「记忆不存在」。
 */
export function formatNoHits(ctx: NoHitsContext, opts: NoHitsOptions = {}): string[] {
  const query = (ctx.query ?? '').trim();
  const lines: string[] = [];

  if (!query && ctx.topic) {
    lines.push(`No document found for topic "${ctx.topic}".`);
  } else if (query) {
    lines.push(`No memories found matching "${query}".`);
  } else {
    lines.push('Nothing to search: pass a query, or a topic.');
  }

  const filters: string[] = [];
  if (ctx.domain) filters.push(`domain="${ctx.domain}"`);
  if (ctx.project) filters.push(`project="${ctx.project}"`);
  if (ctx.topic && query) filters.push(`topic="${ctx.topic}"`);

  if (filters.length > 0) {
    lines.push('');
    lines.push(`Filters in effect: ${filters.join(', ')}. These must match stored values exactly —`);
    lines.push('- `domain` is a normalized slug (e.g. coding, general), not a free-form label.');
    lines.push('- `project` is a stored fingerprint such as "local:35651ad7" or a bare 12-char hash; a filesystem path never matches.');
    lines.push('- `topic` is the frontmatter topic of a living document, not a project name.');
    lines.push('Drop the filter and retry before concluding the memory does not exist; copy valid values from a previous result line or PROCESS.md.');
  }

  if (query) {
    lines.push('');
    lines.push('Tip: Chinese keywords need at least 3 characters (FTS5 trigram); shorter terms automatically fall back to substring matching.');
    if (opts.cli) lines.push('Tip: add --all to include archived and superseded entries.');
    else lines.push('Tip: archived and superseded entries are excluded by default; pass status to include them.');
  }
  return lines;
}
