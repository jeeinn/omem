// v0.5.0 S1-b：自动化任务会话的**只读识别**。
//
// 只产出给 Agent 看的标记，绝不写 skip 台账、不删会话、不改 confidence/status。
// 判定是完全确定性的零模型规则（AGENTS.md：语义归 Agent，程序只报告）。
// 为什么门槛这么严：自动化定时 prompt 常常也是人写的，把「人工 `## user`」当判据
// 会误杀真实陈述；反过来 ①（user 段占比低）在 Claude Code 类会话是常态，
// ①+② 正则组合噪声极大。所以要求 ≥2 信号、且第二信号必须是 ③ 或 ④。
import { evidenceUserText, evidenceUserKey } from '../collect/session-store.js';

export type AutomationSignal =
  | 'low-user-ratio'
  | 'routine-phrase'
  | 'recurring-key'
  | 'flat-user-text';

export interface AutomationVerdict {
  likelyAutomation: boolean;
  signals: string[];
}

export interface AutomationCorpus {
  /** 同一 user 文本指纹出现的会话数。 */
  keyCount: Map<string, number>;
  /** 每个指纹对应的 started_ts（毫秒），用于判断近似周期。 */
  keyTimes: Map<string, number[]>;
}

const ROUTINE_PHRASE = /(发邮件|发送邮件|抓取热点|抓热点|热点新闻|写日记|定时任务|每日任务|每天执行|schedule[ds]?|cron|daily\s+(digest|report|news|email)|send\s+(the\s+)?(daily\s+)?email)/i;

/** 跨会话统计：只读，不落盘。调用方负责把同一批会话一次性喂进来。 */
export function buildAutomationCorpus(items: readonly { body: string; started?: string }[]): AutomationCorpus {
  const keyCount = new Map<string, number>();
  const keyTimes = new Map<string, number[]>();
  for (const item of items) {
    const key = evidenceUserKey(item.body);
    keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
    const ts = item.started ? Date.parse(item.started) : NaN;
    if (Number.isFinite(ts)) {
      const list = keyTimes.get(key) ?? [];
      list.push(ts);
      keyTimes.set(key, list);
    }
  }
  return { keyCount, keyTimes };
}

/** 近似周期：≥3 个时间点，且相邻间隔的最大/最小比 ≤ 3（容忍定时任务抖动）。 */
function nearPeriodic(times: readonly number[]): boolean {
  if (times.length < 3) return false;
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i] - sorted[i - 1];
    if (g <= 0) continue;
    gaps.push(g);
  }
  if (gaps.length < 2) return false;
  return Math.max(...gaps) / Math.min(...gaps) <= 3;
}

/**
 * 单会话判定。signals 是「编号 + 文本特征」的紧凑串，写进 logs/ 供人复核。
 * 只有 `signals.length >= 2` 且含 ③/④（recurring-key / flat-user-text）才返回 likelyAutomation。
 */
export function classifySession(
  msgCount: number,
  body: string,
  corpus: AutomationCorpus,
): AutomationVerdict {
  const userText = evidenceUserText(body);
  const signals: string[] = [];

  // ① user 段占比 <20%：Claude Code 常态，只作为辅助信号，不单独成立。
  const totalChars = [...body].length || 1;
  const ratio = [...userText].length / totalChars;
  if (ratio < 0.2) signals.push(`low-user-ratio=${ratio.toFixed(2)}`);

  // ② 首句命中例程词：噪声大，只作为辅助信号。
  const firstLine = userText.split('\n').find((l) => l.trim())?.trim() ?? '';
  const phrase = ROUTINE_PHRASE.exec(firstLine)?.[0];
  if (phrase) signals.push(`routine-phrase=${phrase}`);

  // ③ 同指纹跨 ≥3 会话且 started 近似周期。
  const key = evidenceUserKey(body);
  if ((corpus.keyCount.get(key) ?? 0) >= 3 && nearPeriodic(corpus.keyTimes.get(key) ?? [])) {
    signals.push(`recurring-key=${key.slice(0, 8)}x${corpus.keyCount.get(key)}`);
  }

  // ④ 用户文本极短 + 消息数高：一轮固定指令驱动大量工具调用。
  // 单独看不可靠（长对话本来就 msg 多），只作为辅助信号，不单独触发打标。
  const userChars = [...userText].length;
  if (msgCount >= 8 && userChars > 0 && userChars <= 80) {
    signals.push(`flat-user-text=${msgCount}msg/${userChars}ch`);
  }

  // 唯一能独立成立的强信号是 ③「同指纹跨 ≥3 会话且近似周期」——
  // 这是自动化任务最硬的形状。④/①/② 都是辅助，缺少 ③ 时一律不标，
  // 避免任何「长助手回复 + 一句人话」被误判为例程。
  const recurring = signals.some((s) => s.startsWith('recurring-key='));
  return { likelyAutomation: recurring && signals.length >= 2, signals };
}
