// 档 2：把待加工主题写成 PROCESS.md。omem 不调用模型，终端也不再打印这份清单。
//
// 本模块负责「算待办 + 渲染 + 落盘」三件事，放在一起是为了让 core/commit.ts
// 能在写入成功后直接刷新 PROCESS.md——core 不能依赖 process/pipeline.ts
// （pipeline 依赖 core，会成环），但依赖 process/guide.ts 不会。
import { statSync } from 'node:fs';
import { files } from '../core/paths.js';
import { atomicWrite } from '../core/util.js';
import { deriveTitle } from '../core/entry.js';
import { listEntries } from '../core/store.js';
import { splitSessionKey } from '../collect/session-store.js';
import type { OmemIndex } from '../core/index.js';

export interface GuideSessionRef {
  path: string;
  sessionId: string;
  agent: string;
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
}

const BATCH = 5;
const LONG_BYTES = 100 * 1024;
/** PROCESS.md 里列多少个既有主题。全量清单交给 `omem topic list`。 */
const EXISTING_LIMIT = 15;

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

function renderExistingTopics(lines: string[], existing: ExistingTopic[]): void {
  if (existing.length === 0) return;
  lines.push('## Existing topics');
  lines.push('');
  lines.push('Reuse one of these names when the sessions belong to it. A new name starts a second living document for the same subject.');
  lines.push('');
  for (const t of existing.slice(0, EXISTING_LIMIT)) {
    lines.push(`- \`${t.name}\`  \`${t.docId}\`  ${t.confidence.toFixed(2)} · ${(t.created || '').slice(0, 10)}`);
  }
  if (existing.length > EXISTING_LIMIT) {
    lines.push(`- …${existing.length - EXISTING_LIMIT} more. List them with \`omem topic list\` or search_memory(topic="<name>").`);
  }
  lines.push('');
}

export function renderGuide(
  topics: GuideTopic[],
  remaining: number,
  unassigned: GuideSessionRef[] = [],
  existing: ExistingTopic[] = [],
): string {
  const lines: string[] = [
    '# omem topics waiting for an update',
    '',
    'Each topic has one living document. A new session updates that document; pass supersedes so the previous version stays on disk but drops out of search.',
    '- Read the session files. Keep short facts, drop the process. Do not invent anything that was not said.',
    '- `evidence` must be at least 12 characters copied from a `## user` section. Do not quote `## assistant`.',
    '- Pass `session_id` as the bare id from the session line, without the collector name or any path: from a line reading `claude-code` / `probe-fixture-0001`, pass `probe-fixture-0001`.',
    '- Call `save_memory` with `topic`, `session_id`, and `evidence`. If a current document id is listed, `supersedes` must include it or the write is rejected.',
    '- Organizing this file is not a life event. Do not save this distillation chat as a new topic.',
    '- After writing, ask once: confirm all, confirm some, or leave them. `confirm_ids` raises confidence to 0.8 and does not set verified.',
    '- `verified: true` comes only from `omem add` or `omem review --confirm`.',
    '',
  ];
  if (topics.length === 0 && unassigned.length === 0) {
    lines.push('No topics are waiting.');
    lines.push('');
    renderExistingTopics(lines, existing);
    return lines.join('\n');
  }
  if (topics.length > 0) {
    lines.push(`This batch: ${topics.length} topic(s). ${remaining} left for the next \`omem sync\`.`);
    lines.push('');
  }
  for (const topic of topics) {
    lines.push(`## ${topic.topic}`);
    if (topic.docId) {
      const others = (topic.otherDocIds ?? []).filter((id) => id !== topic.docId);
      const more = others.length > 0
        ? ` · other living document(s) in this group: ${others.map((id) => `\`${id}\``).join(', ')} — update the one matching the new session's topic`
        : (topic.otherDocs && topic.otherDocs > 0 ? ` · ${topic.otherDocs} more living document(s) in this group; update the one matching the new session's topic` : '');
      lines.push(`- Current document: \`${topic.docId}\`${topic.docTitle ? ` ${topic.docTitle}` : ''}${more}`);
    } else {
      lines.push('- Current document: none. Project grouping is not a topic. Pass an explicit topic only if these sessions should share one living document.');
    }
    lines.push('- Sessions not yet absorbed:');
    for (const s of topic.sessions) {
      let note = '';
      try {
        if (statSync(s.path).size > LONG_BYTES) note = ' (long; read in parts)';
      } catch { /* 刚写入时读不到长度就略过 */ }
      lines.push(`  - \`${s.agent}\` / \`${s.sessionId}\` \`${s.path}\`${note}`);
    }
    lines.push('');
  }
  if (unassigned.length > 0) {
    lines.push('## Unassigned sessions');
    lines.push('These have no project fingerprint. Name a topic when you save, and pass `session_id`.');
    for (const s of unassigned) lines.push(`- \`${s.agent}\` / \`${s.sessionId}\` \`${s.path}\``);
    lines.push('');
  }
  renderExistingTopics(lines, existing);
  return lines.join('\n');
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
export function refreshProcessGuide(home: string, index: OmemIndex): string {
  const [topics, remaining, unassigned] = pendingTopics(home, index);
  return writeProcessGuide(home, renderGuide(topics, remaining, unassigned, collectExistingTopics(home)));
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

export function pendingTopics(home: string, index: OmemIndex): [GuideTopic[], number, GuideSessionRef[], { topics: number; unassigned: number }] {
  const absorbed = absorbedSessionIds(home);
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

  const byTopic = new Map<string, GuideTopic>();
  const groupDocs = new Map<string, Map<string, EntryLoc>>();
  const unassigned: GuideSessionRef[] = [];
  for (const rec of index.listSessions()) {
    const { agent, sessionId } = splitSessionKey(rec.session_id);
    const absorbedAlready = absorbed.has(sessionId) || absorbed.has(rec.session_id);
    const project = rec.project_fp || 'unknown';
    if (absorbedAlready) {
      // 已吸收的会话不再是待办，但它可能是这一组与现实文档的连线：
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
    const ref: GuideSessionRef = {
      path: rec.path,
      sessionId,
      agent: rec.agent || agent,
    };
    if (!project || project === 'unknown') {
      unassigned.push(ref);
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
    topic.sessions.push(ref);
  }
  // 分两趟：先收齐全组的连线，再回填文档，避免受 listSessions() 的会话顺序影响。
  for (const [project, topic] of byTopic) {
    // 优先用 project 直接命中的文档集合；没有才用会话反查的结果。
    const docs = docsByProject.get(project) ?? groupDocs.get(project);
    if (docs) fillDocSlot(topic, [...docs.values()]);
  }
  const all = [...byTopic.values()].filter((t) => t.sessions.length > 0);
  return [
    all.slice(0, BATCH),
    Math.max(0, all.length - BATCH),
    unassigned.slice(0, BATCH),
    { topics: all.length, unassigned: unassigned.length },
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
