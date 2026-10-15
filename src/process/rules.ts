// 档 0：规则抽取（规格 §9.4，默认零配置）。
// 正则 + 模板从会话提高信号句，生成 verified:false 候选。设计要点：
// - 只从 user 消息抽取（模型自己的输出不作为用户偏好）
// - 指令式语气（"以后总是/必须/一律"）置信度减半——防记忆投毒第一关（评估 4.5）
// - 同会话多重印证 +0.1（封顶 0.6）——低但可用的候选信号
import type { MemoryType } from '../core/entry.js';
import type { UnifiedMessage } from '../collect/types.js';
import { normalizeForHash } from '../core/util.js';

interface RuleSpec {
  id: string;
  re: RegExp;
  type: MemoryType;
  conf: number;
}

const RULES: RuleSpec[] = [
  { id: 'decision', re: /(我决定|决定采用|最终选择|最终选定|拍板|结论是|就(?:定|选)它|选定|定下来了?)[^。！？\n]{2,90}/, type: 'decision', conf: 0.45 },
  { id: 'pref-pos', re: /(?:以后|今后|往后|默认|倾向于|偏好|更喜欢|习惯(?:性)?地?)[^。！？\n]{2,90}/, type: 'preference', conf: 0.4 },
  // warning 先于 pref-neg：「注意这个端口别暴露到公网」是警告（fact），不是被「别」抢成的偏好。
  // 高显著性框架词（注意/警告/切记/小心）优先于否定式偏好匹配。
  { id: 'warning', re: /(?:注意|警告|切记|小心|千万别|remember that)[^。！？\n]{2,90}/, type: 'fact', conf: 0.35 },
  { id: 'pref-neg', re: /(?:以后|今后|往后)?(?:都)?(?:不要|别|禁止|不准|杜绝|避免)[^。！？\n]{2,90}/, type: 'preference', conf: 0.4 },
  { id: 'correction', re: /(改成|换成|替换为|改为|修正为|调整为|迁移到|回退到)[^。！？\n]{2,90}/, type: 'decision', conf: 0.4 },
  {
    id: 'lesson',
    re: /(因为[^。！？\n]{2,100}所以|踩坑|教训|问题是[^。！？\n]{2,60}(?:导致|引起|造成)|根因(?:是|为)|原因是)[^。！？\n]{0,80}/,
    type: 'experience',
    conf: 0.4,
  },
  {
    id: 'config',
    re: /(?:配置|环境变量|别名|端口|代理|proxy|timeout|超时|域名|证书)[^。！？\n]{0,40}(?:设为|设置为|改成|调成|调到|指向)[^。！？\n]{0,50}/,
    type: 'fact',
    conf: 0.35,
  },
  { id: 'decision-en', re: /(I (?:decided|chose|picked)|we(?:'ll| will) (?:use|go with)|finally (?:chose|decided))[^.\n]{2,90}/i, type: 'decision', conf: 0.4 },
  { id: 'pref-en', re: /(always use|never use|prefers? to|don'?t use|do not use)[^.\n]{2,90}/i, type: 'preference', conf: 0.4 },
];

/** 指令式语气（防投毒）：命中则置信度减半并打 low-weight 标签。 */
const INSTRUCTION_TONE = /(以后总是|必须|一律|永远|每次都要|无条件|务必|always must)/;

const CODING_RE =
  /代码|函数|bug|调试|部署|docker|git|sql|api|报错|编译|框架|测试|服务|端口|代理|配置|环境变量|数据库|仓库|分支|提交|重构|接口|脚本|code|function|debug|deploy|docker|sql|api|error|compile|test|server|port|proxy|config|refactor/i;

export function inferDomain(text: string): string {
  return CODING_RE.test(text) ? 'coding' : 'general';
}

export interface Candidate {
  type: MemoryType;
  domain: string;
  content: string;
  confidence: number;
  tags: string[];
  project_fp?: string;
  session_id: string;
  source: 'rules' | 'llm';
}

/** 从单条 user 消息抽取候选（每规则取首个匹配，同消息内按内容去重保最高置信）。 */
export function extractCandidates(msg: UnifiedMessage): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    const m = rule.re.exec(msg.content);
    if (!m) continue;
    const content = m[0].trim();
    if ([...content].length < 6) continue; // 太短不成记忆
    const clipped = [...content].length > 300 ? content.slice(0, 299) + '…' : content;
    let conf = rule.conf;
    const tags: string[] = [];
    if (INSTRUCTION_TONE.test(clipped)) {
      conf *= 0.5;
      tags.push('low-weight');
    }
    const key = normalizeForHash(clipped);
    const prev = byKey.get(key);
    if (prev && prev.confidence >= conf) continue;
    byKey.set(key, {
      type: rule.type,
      domain: inferDomain(clipped),
      content: clipped,
      confidence: Math.round(conf * 100) / 100,
      tags,
      project_fp: msg.project_fp,
      session_id: msg.session_id,
      source: 'rules',
    });
  }
  return [...byKey.values()];
}

/** 会话级加工：抽取 + 同会话多重印证加权（封顶 0.6）。 */
export function extractFromDigest(digest: { session_id: string; project_fp: string; messages: UnifiedMessage[] }): Candidate[] {
  const all: Candidate[] = [];
  for (const msg of digest.messages) {
    if (msg.role !== 'user') continue; // 只抽 user 消息
    all.push(...extractCandidates(msg));
  }
  // 印证计数：同会话内同内容出现 ≥2 次 +0.1
  const counts = new Map<string, number>();
  for (const c of all) counts.set(normalizeForHash(c.content), (counts.get(normalizeForHash(c.content)) ?? 0) + 1);
  return all.map((c) => {
    const n = counts.get(normalizeForHash(c.content)) ?? 1;
    return n >= 2 ? { ...c, confidence: Math.min(0.6, Math.round((c.confidence + 0.1) * 100) / 100) } : c;
  });
}
