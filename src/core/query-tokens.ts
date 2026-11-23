// 查询词规范化：中文没有空格，整句必须先在 token 内部剥离疑问词与虚词。
//
// 为什么必须做：检索是「子串 AND」——每个 token 都得在正文里以子串出现。
// 中文一句话切不开，`我最近的工作都有哪些项目？` 就是一个 token，要整句子串命中，
// 必然 0 命中；而用户（和 agent）问问题就是用整句。
//
// 边界（重要）：这里只做「减法」，不动 AND 语义。
// `search-capability` 的 multi-hop 断言要求「把两个子问题拼成一个查询时不该命中」，
// 所以用户显式用空格分开的多词查询必须保持严格 AND。只有「原本一个 token、
// 被停用词切开」的情况（autoSplit）才允许在 0 命中时退回 OR——那是系统猜的，
// 放宽它不会改变用户的显式意图。

/** 多字停用词，按长度降序匹配，避免短词抢先截断长词。 */
const ZH_STOPWORDS = [
  '为什么',
  '怎么样',
  '什么样',
  '哪些',
  '哪个',
  '哪里',
  '什么',
  '怎么',
  '如何',
  '是否',
  '有没有',
  '多少',
  '这些',
  '那些',
  '这个',
  '那个',
  '这种',
  '那种',
  '我的',
  '你的',
  '他的',
  '她的',
  '我们',
  '你们',
  '他们',
  '请问',
  '帮我',
  '帮忙',
  '告诉我',
  '一下',
  '一些',
  '相关',
  '关于',
  '最近',
  '目前',
  '现在',
  '之前',
  '以后',
  '后来',
  '平时',
  '都有',
  '都是',
  '还是',
  '或者',
  '以及',
  '而且',
  '的话',
  '了吗',
  '了呢',
  '事情',
  '东西',
  '内容',
  '方面',
  '情况',
].sort((a, b) => b.length - a.length);

/**
 * 单字停用词：只收「删掉不会改变名词」的字。
 * 刻意不收 有 / 是 / 在 / 和 / 与 —— 它们嵌在实词里（有效、存在、和谐），
 * 删一个字的代价是整条查询失真。
 */
const ZH_STOP_CHARS = /[的吗了呢吧啊呀嘛]/g;

/** 句读标点替换为空格；保留 - _ / 等词内连接符（omem-global-install 仍是一个词）。 */
const SENTENCE_PUNCT = /[，。？！、；：""''（）《》【】…—～!?,.;:]+/g;

const CJK = /[\u4e00-\u9fff]/;

export interface QueryTokens {
  tokens: string[];
  /** true 表示 tokens 由一个原始 token 拆分而来（系统猜的），0 命中时可退回 OR。 */
  autoSplit: boolean;
  /** 规范化后的可读形式；与原查询不同时，零结果文案可以说明「我是这样理解的」。 */
  normalized: string;
}

function stripStopwords(token: string): string {
  if (!CJK.test(token)) return token;
  let out = token;
  for (const w of ZH_STOPWORDS) {
    if (out.includes(w)) out = out.split(w).join(' ');
  }
  out = out.replace(ZH_STOP_CHARS, ' ');
  return out;
}

/**
 * 把原始查询规范化为检索 token。
 *
 * 三条不变量：
 * 1. 英文/符号查询原样按空白切分，不受停用词影响；
 * 2. 只有含 CJK 的 token 才做停用词剥离，剥离出来的片段各自成为独立 token；
 * 3. 剥离后为空则回退原 token —— 宁可查不到，也不能把查询变成「无条件」。
 */
export function queryTokens(raw: string): QueryTokens {
  const base = (raw ?? '')
    .toLowerCase()
    .replace(SENTENCE_PUNCT, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const tokens: string[] = [];
  let autoSplit = false;
  for (const token of base) {
    const parts = stripStopwords(token)
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 0) {
      tokens.push(token); // 全是停用词：保留原样，否则查询会退化成「无条件」
      continue;
    }
    if (parts.length > 1) {
      autoSplit = true;
      // 拆分产生的单字碎片基本都是虚词残留（我 / 的 / 是）。
      // 但整条查询本身就是单字时（golden 里的「接」）不能丢，所以只在多碎片时过滤。
      const kept = parts.filter((p) => [...p].length > 1);
      tokens.push(...(kept.length > 0 ? kept : parts));
      continue;
    }
    tokens.push(...parts);
  }

  return { tokens, autoSplit, normalized: tokens.join(' ') };
}