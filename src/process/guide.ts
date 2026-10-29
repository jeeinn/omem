// 档 2：把待加工主题写成 PROCESS.md。omem 不调用模型，终端也不再打印这份清单。
//
// 本模块负责「算待办 + 渲染 + 落盘」三件事，放在一起是为了让 core/commit.ts
// 能在写入成功后直接刷新 PROCESS.md——core 不能依赖 process/pipeline.ts
// （pipeline 依赖 core，会成环），但依赖 process/guide.ts 不会。
import { readFileSync, statSync } from 'node:fs';
import { files } from '../core/paths.js';
import { atomicWrite } from '../core/util.js';
import { appendLog } from '../core/log.js';
import { deriveTitle } from '../core/entry.js';
import { listEntries } from '../core/store.js';
import { readStoredSession, sessionUserHash, splitSessionKey } from '../collect/session-store.js';
import { RULE_EVIDENCE, RULE_VERIFIED } from '../context/instructions.js';
import type { OmemConfig } from '../core/config.js';
import type { OmemIndex } from '../core/index.js';

export interface GuideSessionRef {
  path: string;
  sessionId: string;
  agent: string;
  /**
   * 同一 `## user` 文本的会话数（显示层折叠用）；1 或缺省 = 无重复。
   *
   * 它**只**说明「这 N 份的用户原话相同」——assistant 的回答各不相同（实测 25/26 组
   * 实质不同），所以不能当成「读一份就够」。字段名保留 `copies` 是为了不动折叠逻辑，
   * 渲染出来的标记才是给 Agent 看的那句话。
   */
  copies?: number;
}

export interface GuideTopic {
  topic: string;
  docId?: string;
  docTitle?: string;
  /** 这一组里除默认文档外还有几份活文档（一个项目可以拆多个 topic）。 */
  otherDocs?: number;
  /** 这些活文档的 id。PROCESS.md 只说「还有 3 份」等于死信息——调用方仍拿不到 supersedes 要的 id。 */
  otherDocIds?: string[];
  sessions: GuideSessionRef[];
  /** 组内最近活跃时间（排序用）：大组优先进渲染窗口。 */
  lastTs?: string;
}

const BATCH = 5;

export interface SkipRecord {
  session_id: string;
  agent?: string;
  /** noise | duplicate | no-value | agent-authored */
  reason: string;
  decided_at: string;
}

/** 读 skip 台账；文件缺失/损坏时降级为空（不阻塞清单渲染），损坏留给 skip 命令修。 */
/** skip 台账里的会话视同已处理：退出待吸收清单，但会话文件原样保留。 */
export function skippedSessionIds(home: string): Set<string> {
  return new Set(loadSkipLedger(home).map((r) => r.session_id));
}

export function loadSkipLedger(home: string): SkipRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(files.skipLedger(home), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is SkipRecord => !!r && typeof (r as SkipRecord).session_id === 'string');
  } catch {
    return [];
  }
}
const NL = '\n';
/** 渲染用反引号（避免在模板串里逐处转义）。 */
const BT = '`';
const LONG_BYTES = 100 * 1024;

/**
 * PROCESS.md 的字节预算（beta.9 / T04，F3）。
 *
 * H3 的教训不是「文件大」，是**渲染没有任何预算**：同一批 1,101 会话，beta.8 渲染
 * 7,221 B、HEAD 渲染 117,752 B（16.3×），最大单组一人占 478 行。没有预算，同型回归
 * 会以另一种形式再来一次。超限按固定阶梯降级（见 renderGuide），每级都不删头部。
 *
 * 30,000 B 是「宿主 `Read` 一次读完」的余量：真实 tokenizer 对含 CJK 的文本约为
 * 字符数的 1.2–1.5 倍，30 KB 远低于 20,000 token 的上限。
 */
export const GUIDE_MAX_BYTES = 30_000;

/** 第二级降级的组内会话上限起点（V0.2 的 cursor 分页上线后由 T11 替换，不叠两层）。 */
const GROUP_SESSION_CAP = 200;

export interface ExistingTopic {
  name: string;
  /** 该主题当前 active 文档的 id——supersedes 要的就是它。 */
  docId: string;
  confidence: number;
  created: string;
}

/**
 * 已存在的 active 主题（按最近创建排序）。
 *
 * 为什么写进 PROCESS.md：Agent 读这份文件决定怎么写回，但它原本只看到项目分组名
 * （project_fp，不是 topic），完全不知道库里已有 25 个主题叫什么。于是它只能自己
 * 新造一个名字——同一主题于是有了两份活文档。这份清单就是它的词表。
 *
 * 2026-10-27：连同 active id 一起给出。只给名字的话，Agent 复用名字之后仍然拿不到
 * supersedes 需要的 id，还得靠「写失败再读拒绝消息」来发现。
 */
export function collectExistingTopics(home: string): ExistingTopic[] {
  const byTopic = new Map<string, ExistingTopic>();
  for (const loc of listEntries(home)) {
    const fm = loc.entry.fm;
    if (fm.status !== 'active' || !fm.topic) continue;
    const prev = byTopic.get(fm.topic);
    // 同 topic 多份 active 是异常态，取最新创建的一份（与 index.findActiveByTopic 同口径）。
    if (prev && prev.created >= fm.created) continue;
    byTopic.set(fm.topic, { name: fm.topic, docId: fm.id, confidence: fm.confidence, created: fm.created });
  }
  return [...byTopic.values()].sort((a, b) => (a.created < b.created ? 1 : -1));
}

/**
 * 既有主题全量列出（beta.9 / T04）。
 *
 * 此前只列 15 条 + `…N more`，而这一段只占全文 1.6%——让 Agent 回 CLI 跑 `omem topic list`
 * 发现名字，比直接把 43 条全列出来贵得多，且分页会让它看不到全量词表 → 新造 topic 名 →
 * 加剧碎片化。
 *
 * 超预算时按「信息价值」降级，不是按「列宽」降级：**id 是最有价值的列**（supersedes 直接要它），
 * 所以先丢 `confidence · created` 这两列装饰，最后才丢 id。反过来（先丢 id）会把一次写入
 * 变成「再来一次 search_memory 查 id」——省字节但费往返，与 T04 的目标相反。
 */
type TopicColumnMode = 'full' | 'compact' | 'names';

function renderExistingTopics(lines: string[], existing: ExistingTopic[], mode: TopicColumnMode = 'full'): void {
  if (existing.length === 0) return;
  lines.push('## Existing topics');
  lines.push('');
  lines.push('Reuse one of these names when the sessions belong to it. A new name starts a second living document for the same subject.');
  lines.push('');
  for (const t of existing) {
    if (mode === 'full') {
      lines.push(`- ${BT}${t.name}${BT}  ${BT}${t.docId}${BT}  ${t.confidence.toFixed(2)} · ${(t.created || '').slice(0, 10)}`);
    } else if (mode === 'compact') {
      lines.push(`- ${BT}${t.name}${BT}  ${BT}${t.docId}${BT}`);
    } else {
      lines.push(`- ${BT}${t.name}${BT}`);
    }
  }
  if (mode === 'names') {
    lines.push('');
    lines.push('The active document id for a topic is what `supersedes` needs: get it with search_memory(topic="<name>").');
  }
  lines.push('');
}

/** renderGuide 的可选行为：预算与降级回调（纯函数，落日志由调用方做）。 */
export interface GuideRenderOpts {
  /** 字节预算，默认 GUIDE_MAX_BYTES。 */
  maxBytes?: number;
  /** 发生降级时回调（refreshProcessGuide 用它 appendLog）。 */
  onDegrade?: (info: { level: number; groupCap: number | null; bytes: number }) => void;
}

/** 一次渲染的形态参数：由预算决定，不由调用方决定。 */
interface RenderShape {
  /** 0 = 全量；1 = 主题行紧凑；2 = 紧凑 + 组内上限；3 = 主题只剩名字 + 组内上限。 */
  level: number;
  /** level<3 时无上限。 */
  groupCap: number | null;
  /** 主题行的列集合，随 level 递减。 */
  columns: TopicColumnMode;
}

/** 头部指令段：规则句只从 `context/instructions.ts` 取，不再手写第二份（AGENTS.md:23）。 */
function renderHeader(): string[] {
  return [
    '# omem topics waiting for an update',
    '',
    'Each topic has one living document. A new session updates that document; pass supersedes so the previous version stays on disk but drops out of search.',
    '- Read the session files. Keep short facts, drop the process. Do not invent anything that was not said.',
    `- ${RULE_EVIDENCE}.`,
    '- Sessions are listed by bare `session_id` (no paths, no collector prefix — the store may live anywhere). Read one with search_memory(scope="sessions", session_id="<id>"): it returns the `## user` text as quotable segments with character offsets. Pass the same bare id as `session_id` when you save, and the current document id as `supersedes` when one is listed.',
    '- Sessions sharing one `## user` fingerprint are collapsed into one line as `(same-user-text: N)`. They share **only what the user typed** — the assistant answers differ across the N sessions, so read every copy you intend to distil, or state in the body which answer you relied on.',
    '- Judged no-value? Record it with `omem skip <session-id>` so it leaves this list for good.',
    '- Organizing this file is not a life event. Do not save this distillation chat as a new topic.',
    '- After writing, ask once: confirm all, confirm some, or leave them. `confirm_ids` raises confidence to 0.8 and does not set verified.',
    `- ${RULE_VERIFIED}.`,
    '',
  ];
}

function buildGuide(
  shape: RenderShape,
  topics: GuideTopic[],
  remaining: number,
  unassigned: GuideSessionRef[],
  existing: ExistingTopic[],
  totals?: { sessions: number; shownSessions: number },
): string {
  const lines = renderHeader();
  if (topics.length === 0 && unassigned.length === 0) {
    lines.push('No topics are waiting.');
    lines.push('');
    renderExistingTopics(lines, existing, shape.columns);
    return lines.join(NL);
  }
  if (topics.length > 0) {
    // 三个口径分开说：本轮渲染了什么、还有多少组/会话没吸收、以及分工——
    // 提炼靠 Agent 调 save_memory，omem sync 只采集并重渲染这份清单（2026-10-28 文案纠正）。
    const shownSessions = totals?.shownSessions
      ?? topics.reduce((n, t) => n + t.sessions.reduce((m, s) => m + (s.copies ?? 1), 0), 0);
    const leftSessions = totals ? Math.max(0, totals.sessions - shownSessions) : remaining;
    lines.push(`This batch: ${topics.length} group(s) / ${shownSessions} session(s) shown. `);
    lines.push(`${remaining} group(s) and ${leftSessions} session(s) still unabsorbed — `);
    lines.push('the agent distills via save_memory; `omem sync` only collects and re-renders this list.');
    lines.push('');
  }
  for (const topic of topics) {
    lines.push(`## ${topic.topic}`);
    if (topic.docId) {
      const others = (topic.otherDocIds ?? []).filter((id) => id !== topic.docId);
      const more = others.length > 0
        ? ` · other living document(s) in this group: ${others.map((id) => BT + id + BT).join(', ')} — update the one matching the new session's topic`
        : (topic.otherDocs && topic.otherDocs > 0 ? ` · ${topic.otherDocs} more living document(s) in this group; update the one matching the new session's topic` : '');
      lines.push(`- Current document: ${BT}${topic.docId}${BT}${topic.docTitle ? ` ${topic.docTitle}` : ''}${more}`);
    } else {
      lines.push('- Current document: none. Project grouping is not a topic. Pass an explicit topic only if these sessions should share one living document.');
    }
    lines.push('- Sessions not yet absorbed:');
    const visible = shape.groupCap === null ? topic.sessions : topic.sessions.slice(0, shape.groupCap);
    for (const s of visible) {
      let note = '';
      try {
        if (statSync(s.path).size > LONG_BYTES) note = ' (long; read in parts)';
      } catch { /* 刚写入时读不到长度就略过 */ }
      const copies = s.copies && s.copies > 1 ? ` (same-user-text: ${s.copies})` : '';
      // 不再带绝对路径：它占旧体积 50.7%，而且会话正文要按 session_id 取（读取通道）。
      // 只列裸 session_id：采集器名不参与任何后续调用（readSessionsById 扫全部采集器目录），
      // 却要占 10B/行 ≈ 5.7KB/572 行——正是这点体积让预算护栏开始隐藏会话。
      lines.push(`  - ${BT}${s.sessionId}${BT}${note}${copies}`);
    }
    const hidden = topic.sessions.length - visible.length;
    if (hidden > 0) {
      // 每组各自标记 + 数字 + 取得方式。只说「…more」等于告诉 Agent「有东西你看不到但拿不到」，
      // 比不提示更糟（它会把「只能这样了」当成结论）。
      lines.push(`  - …${hidden} more in this group — hidden by the size budget. Narrow the topic, or run omem topic list / search_memory(topic="<name>") for the rest.`);
    }
    lines.push('');
  }
  if (unassigned.length > 0) {
    lines.push('## Unassigned sessions');
    lines.push('These have no project fingerprint. Name a topic when you save, and pass `session_id`.');
    const visibleUnassigned = shape.groupCap === null ? unassigned : unassigned.slice(0, shape.groupCap);
    for (const s of visibleUnassigned) lines.push(`- ${BT}${s.sessionId}${BT}`);
    const hiddenUnassigned = unassigned.length - visibleUnassigned.length;
    if (hiddenUnassigned > 0) {
      lines.push(`- …${hiddenUnassigned} more here — hidden by the size budget.`);
    }
    lines.push('');
  }
  renderExistingTopics(lines, existing, shape.columns);
  return lines.join(NL);
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * 渲染 PROCESS.md。
 *
 * 无损瘦身（beta.9 / T04）之后仍必须**有预算**：H3 的失败模式是「单组 478 行占全文 80%」，
 * 没有预算的渲染器在数据变化后一定会再长成不可读。降级阶梯固定三级，每级都保留头部：
 *   0. 全量（会话行无路径、topic 全列、规则句来自常量）
 *   1. 既有主题去掉 id 列
 *   2. 再加上组内会话上限，超出的每组输出一行 `hidden by the size budget`（含数字）
 * 第 2 级仍超预算时上限对半折半——**永不硬截字符串**（截半行会让下一轮解析失败）。
 */
export function renderGuide(
  topics: GuideTopic[],
  remaining: number,
  unassigned: GuideSessionRef[] = [],
  existing: ExistingTopic[] = [],
  totals?: { sessions: number; shownSessions: number },
  opts: GuideRenderOpts = {},
): string {
  const budget = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : GUIDE_MAX_BYTES;
  const full = (shape: RenderShape): string => buildGuide(shape, topics, remaining, unassigned, existing, totals);

  let shape: RenderShape = { level: 0, groupCap: null, columns: 'full' };
  let text = full(shape);

  // 第一级：主题行紧凑（丢 confidence · created，保留 id）
  if (byteLength(text) > budget) {
    shape = { level: 1, groupCap: null, columns: 'compact' };
    text = full(shape);
  }
  // 第二级：组内会话上限。用二分找「装得下的最大上限」——固定阶梯只降不升会白白浪费
  // 剩下的预算（实测里曾出现「还剩 9KB 却把 478 行的组砍到 200 行」）。
  if (byteLength(text) > budget) {
    const maxGroup = Math.max(1, ...topics.map((t) => t.sessions.length));
    const bisect = (columns: TopicColumnMode, level: number): { text: string; cap: number } | undefined => {
      let lo = 1;
      let hi = maxGroup;
      let best: { text: string; cap: number } | undefined;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = full({ level, groupCap: mid, columns });
        if (byteLength(candidate) <= budget) {
          best = { text: candidate, cap: mid };
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return best;
    };
    const compact = bisect('compact', 2);
    if (compact) {
      text = compact.text;
      shape = { level: 2, groupCap: compact.cap, columns: 'compact' };
    } else {
      // 第三级：主题只剩名字，仍然尽量多留会话行；连每组 1 行都装不下时头部也永不删。
      const names = bisect('names', 3);
      if (names) {
        text = names.text;
        shape = { level: 3, groupCap: names.cap, columns: 'names' };
      } else {
        shape = { level: 3, groupCap: 1, columns: 'names' };
        text = full(shape);
      }
    }
  }
  if (shape.level > 0) {
    opts.onDegrade?.({ level: shape.level, groupCap: shape.groupCap, bytes: byteLength(text) });
  }
  return text;
}

export function writeProcessGuide(home: string, text: string): string {
  const path = files.processGuide(home);
  atomicWrite(path, text);
  return path;
}

/**
 * 重算并重写 PROCESS.md。
 *
 * 为什么需要单独的入口：PROCESS.md 是「还没被吸收的会话」的清单。Agent 通过
 * save_memory 吸收一个会话后，清单必须立刻少一条——否则 Agent 下次读到的还是
 * 旧清单，会重复处理已吸收的会话。而 save_memory 走的是 MCP，不经过
 * omem sync，所以清单原本只在采集路径上重算（2026-10-26 审计发现的缺口）。
 *
 * 本函数放在 guide.ts 而不是 pipeline.ts：core/commit.ts 要在写入成功后调用它，
 * 而 pipeline.ts 依赖 core，会成环。guide.ts 不依赖 core/commit.ts，安全。
 */
export function refreshProcessGuide(home: string, index: OmemIndex, config?: OmemConfig): string {
  const [topics, remaining, unassigned, counts] = pendingTopics(home, index, config);
  return writeProcessGuide(
    home,
    renderGuide(topics, remaining, unassigned, collectExistingTopics(home), {
      sessions: counts.sessions,
      shownSessions: counts.shownSessions,
    }, {
      // 降级必须留痕：清单悄悄少了一半会话，正是 H3 那种「回归了但没人知道」的形状。
      onDegrade: (info) => appendLog(home, 'guide', { degraded: true, ...info }),
    }),
  );
}

type EntryLoc = ReturnType<typeof listEntries>[number];

function createdOf(loc: EntryLoc): string {
  return loc.entry.fm.created ?? '';
}

/** 一组可能同时存在几份活文档（一个项目可以拆成多个 topic），最新那份作为默认 supersede 对象。 */
function fillDocSlot(topic: GuideTopic, docs: EntryLoc[]): void {
  const sorted = [...docs].sort((a, b) => (createdOf(a) < createdOf(b) ? 1 : -1));
  const newest = sorted[0];
  if (!newest) return;
  topic.docId = newest.entry.fm.id;
  topic.docTitle = deriveTitle(newest.entry.body);
  topic.otherDocs = sorted.length - 1;
  topic.otherDocIds = sorted.slice(1).map((d) => d.entry.fm.id);
}

export function pendingTopics(
  home: string,
  index: OmemIndex,
  config?: OmemConfig,
): [GuideTopic[], number, GuideSessionRef[], { topics: number; unassigned: number; sessions: number; shownSessions: number }] {
  const absorbed = absorbedSessionIds(home);
  const skipped = skippedSessionIds(home);
  const batch = Math.max(1, config?.process.guide_batch ?? BATCH);
  // 曾经这里维护一个「已吸收指纹集」，用 `user_hash` 代替账本判待办。
  // 2026-10-28 证伪：吸收兄弟组的 1 份，同指纹的其余 N−1 份一起退出待办，
  // 而它们的 assistant 段各不相同（25/26 组实质不同）→ 最多 24 份独立结论
  // 从未被读取就被标记为已处理。**账本只能用 session_id 记账**：
  // 指纹只用于显示层折叠（下面的 seenHashByGroup），不用于判「处理过没有」。
  const active = listEntries(home).filter((l) => l.entry.fm.status === 'active');
  // 反查表：会话 → 它产出的活文档。
  const docBySession = new Map<string, EntryLoc>();
  const remember = (key: string | undefined, loc: EntryLoc): void => {
    if (!key) return;
    const prev = docBySession.get(key);
    if (!prev || createdOf(loc) > createdOf(prev)) docBySession.set(key, loc);
  };
  // 主路径：活文档的 project 字段就是会话分组用的 project_fp。
  // 分组名与文档的 project 是同一个命名空间，直接按它匹配即可——不必绕道会话。
  // 真实库实测：26 份活文档里 25 份带 project 字段。
  const docsByProject = new Map<string, Map<string, EntryLoc>>();
  for (const loc of active) {
    remember(loc.entry.fm.session_id, loc);
    for (const sid of loc.entry.fm.source_sessions) remember(sid, loc);
    const project = loc.entry.fm.project;
    if (!project) continue;
    let docs = docsByProject.get(project);
    if (!docs) docsByProject.set(project, (docs = new Map()));
    docs.set(loc.entry.fm.id, loc);
  }

  // user 段指纹按路径缓存（mtime 失效）；一轮渲染约千次 stat，重读只发生在文件变化后。
  const uhCache = new Map<string, { mtime: number; hash: string }>();
  const userHashOf = (path: string): string => {
    try {
      const st = statSync(path);
      const cached = uhCache.get(path);
      if (cached && cached.mtime === st.mtimeMs) return cached.hash;
      const stored = readStoredSession(path);
      const hash = stored ? (stored.userHash ?? sessionUserHash(stored.body)) : '';
      uhCache.set(path, { mtime: st.mtimeMs, hash });
      return hash;
    } catch {
      return '';
    }
  };

  const byTopic = new Map<string, GuideTopic>();
  // 片段级去重：同组内同指纹的会话合并为一行 ref（copies 递增），不再逐条列出。
  const seenHashByGroup = new Map<string, Map<string, GuideSessionRef>>();
  const groupDocs = new Map<string, Map<string, EntryLoc>>();
  const unassigned: GuideSessionRef[] = [];
  const unassignedSeen = new Map<string, GuideSessionRef>();
  let pendingSessionCount = 0;

  for (const rec of index.listSessions()) {
    const { agent, sessionId } = splitSessionKey(rec.session_id);
    const project = rec.project_fp || 'unknown';
    const handled = absorbed.has(sessionId) || absorbed.has(rec.session_id)
      || skipped.has(sessionId) || skipped.has(rec.session_id);
    const uh = handled ? '' : userHashOf(rec.path);
    // 待办的唯一判据是「这个 session_id 有没有被某份文档引用 / 有没有被 skip」。
    const isPending = !handled;
    if (!isPending) {
      // 已处理（吸收 / skip / 同片段已吸收）的会话不再是待办，但它可能是这一组与现实文档的连线：
      // 优先看文档自己的 project 字段，缺失时才靠会话反查。
      const byProject = docsByProject.get(project);
      if (byProject && byProject.size > 0) {
        let docs = groupDocs.get(project);
        if (!docs) groupDocs.set(project, (docs = new Map()));
        for (const [id, loc] of byProject) docs.set(id, loc);
      } else {
        const doc = docBySession.get(sessionId) ?? docBySession.get(rec.session_id);
        if (doc && project !== 'unknown') {
          let docs = groupDocs.get(project);
          if (!docs) groupDocs.set(project, (docs = new Map()));
          docs.set(doc.entry.fm.id, doc);
        }
      }
      continue;
    }
    pendingSessionCount++;
    const ref: GuideSessionRef = {
      path: rec.path,
      sessionId,
      agent: rec.agent || agent,
      copies: 1,
    };
    if (!project || project === 'unknown') {
      const prev = uh ? unassignedSeen.get(uh) : undefined;
      if (prev) {
        prev.copies = (prev.copies ?? 1) + 1;
      } else {
        if (uh) unassignedSeen.set(uh, ref);
        unassigned.push(ref);
      }
      continue;
    }
    let topic = byTopic.get(project);
    if (!topic) {
      topic = {
        topic: project,
        docId: undefined,
        docTitle: undefined,
        otherDocs: 0,
        sessions: [],
      };
      byTopic.set(project, topic);
    }
    if (!topic.lastTs || rec.last_ts > topic.lastTs) topic.lastTs = rec.last_ts;
    if (uh) {
      let seen = seenHashByGroup.get(project);
      if (!seen) seenHashByGroup.set(project, (seen = new Map()));
      const prev = seen.get(uh);
      if (prev) {
        // 同一段内容重复落盘：并进代表行，PROCESS.md 不再逐条列出。
        prev.copies = (prev.copies ?? 1) + 1;
        continue;
      }
      seen.set(uh, ref);
    }
    topic.sessions.push(ref);
  }
  // 分两趟：先收齐全组的连线，再回填文档，避免受 listSessions() 的会话顺序影响。
  for (const [project, topic] of byTopic) {
    // 优先用 project 直接命中的文档集合；没有才用会话反查的结果。
    const docs = docsByProject.get(project) ?? groupDocs.get(project);
    if (docs) fillDocSlot(topic, [...docs.values()]);
  }
  const all = [...byTopic.values()].filter((t) => t.sessions.length > 0);
  // 大组先进窗口：未吸收会话数降序，其次按组内最近活跃时间。
  // 旧行为按 listSessions() 自然序 slice(0, 5)，566 会话的大组永远露不了面。
  all.sort((a, b) => (b.sessions.length - a.sessions.length)
    || (b.lastTs || '').localeCompare(a.lastTs || ''));
  const shown = all.slice(0, batch);
  const shownSessions = shown.reduce(
    (n, t) => n + t.sessions.reduce((m, s) => m + (s.copies ?? 1), 0),
    0,
  );
  return [
    shown,
    Math.max(0, all.length - batch),
    unassigned.slice(0, batch),
    {
      topics: all.length,
      unassigned: unassigned.reduce((n, s) => n + (s.copies ?? 1), 0),
      sessions: pendingSessionCount,
      shownSessions,
    },
  ];
}

/** 已写进任一结论的 session_id 或 source_sessions，不再进入待吸收列表。 */
export function absorbedSessionIds(home: string): Set<string> {
  const ids = new Set<string>();
  for (const loc of listEntries(home, { includeArchived: true })) {
    const fm = loc.entry.fm;
    if (fm.session_id) ids.add(fm.session_id);
    for (const id of fm.source_sessions) ids.add(id);
  }
  return ids;
}

export { BATCH as GUIDE_BATCH };
