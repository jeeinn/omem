// 把客户端塞进 user 消息的脚手架从对话正文里剥掉。
// 有 <user_query> 时只留标签内正文；否则丢掉 <system-reminder> 整块。

/** 剥掉系统包装，留下用户真正输入的文本。空结果表示这轮没有对话正文。 */
export function stripHarness(text: string): string {
  const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (queries.length > 0) return queries.join('\n').trim();
  return text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '').trim();
}
