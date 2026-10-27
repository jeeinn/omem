// omem topic：活文档主题的可见性入口。
//
// 为什么需要：topic 只存在 frontmatter，不进文件路径（knowledge/<domain>/<year>/<id>.md），
// `omem search` 以前也不打印它。结果是「库里有哪些主题」只能靠 open 文件或看 MEMORY-INDEX。
//
// `--all` 额外列出「只存在于 superseded 的旧主题 → 现在归到哪个 active 主题」：
// 跨主题合并之后，旧名字不再出现在检索里，这条映射是唯一的线索。
import { openCtx } from '../core/ctx.js';
import { normalizeTopic } from '../core/commit.js';
import { findByIdIndexed, listEntries } from '../core/store.js';
import type { OmemIndex } from '../core/index.js';
import { deriveTitle } from '../core/entry.js';
import { UsageError } from '../core/util.js';
import { flagBool } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { Located } from '../core/store.js';
import { TOPIC_POLICIES, loadTopicPolicies, saveTopicPolicy } from '../core/review-policy.js';
import type { TopicPolicy } from '../core/review-policy.js';

const USAGE = 'Usage: omem topic list [--all] | omem topic policy <topic> always|once|never|default';
const NAME_WIDTH = 44;

interface TopicRow {
  name: string;
  docs: number;
  last: string;
  confidence: number;
  policy: TopicPolicy;
  title: string;
}

function sortByCreatedDesc(entries: Located[]): Located[] {
  return [...entries].sort((a, b) => ((a.entry.fm.created || '') < (b.entry.fm.created || '') ? 1 : -1));
}

/** 沿 superseded_by 链找到最终接盘的 active 文档；链断或无终态返回 null。 */
function resolveOwner(home: string, index: OmemIndex, start: Located, limit = 20): Located | null {
  const seen = new Set<string>([start.entry.fm.id]);
  let current = start;
  for (let i = 0; i < limit; i++) {
    const nextId = current.entry.fm.superseded_by;
    if (!nextId || seen.has(nextId)) return null;
    seen.add(nextId);
    const next = findByIdIndexed(home, index, nextId, { includeArchived: true });
    if (!next) return null;
    if (next.entry.fm.status === 'active') return next;
    current = next;
  }
  return null;
}

export async function cmdTopic(args: ParsedArgs): Promise<number> {
  const sub = args._[0] ?? 'list';
  if (sub !== 'list' && sub !== 'policy') throw new UsageError(USAGE);

  const ctx = openCtx();
  try {
    const all = listEntries(ctx.home, { includeArchived: true });
    const active = all.filter((l) => l.entry.fm.status === 'active');
    const withTopic = active.filter((l) => l.entry.fm.topic);
    const withoutTopic = active.filter((l) => !l.entry.fm.topic);
    const policies = loadTopicPolicies(ctx.home);

    const groups = new Map<string, Located[]>();
    for (const loc of withTopic) {
      const name = loc.entry.fm.topic as string;
      const list = groups.get(name);
      if (list) list.push(loc);
      else groups.set(name, [loc]);
    }

    const rows: TopicRow[] = [...groups.entries()].map(([name, docs]) => {
      const sorted = sortByCreatedDesc(docs);
      const newest = sorted[0];
      return {
        name,
        docs: docs.length,
        last: (newest.entry.fm.created || '').slice(0, 10),
        confidence: newest.entry.fm.confidence,
        policy: policies.get(name) ?? 'always',
        title: deriveTitle(newest.entry.body, 50),
      };
    });
    rows.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));

    if (sub === 'policy') {
      const rawTopic = args._[1];
      const rawValue = args._[2];
      if (!rawTopic || !rawValue) throw new UsageError(USAGE);
      const name = normalizeTopic(rawTopic);
      if (!name) throw new UsageError('Topic must not be empty');
      const value = rawValue === 'default' ? null : (rawValue as TopicPolicy);
      if (value !== null && !TOPIC_POLICIES.includes(value)) {
        throw new UsageError(`Unknown policy "${rawValue}". Use always / once / never / default.`);
      }
      saveTopicPolicy(ctx.home, name, value);
      console.log(value ? `Policy for "${name}": ${value}` : `Policy for "${name}": default (always)`);
      if (!rows.some((r) => r.name === name)) {
        console.log('Note: no active document has this topic yet; the policy applies once one appears.');
      }
      return 0;
    }

    // --all：只存在于 superseded 的主题。提前收集，因为「空库」的判定也要算上它们。
    const showAll = flagBool(args.flags, 'all');
    const retiredByTopic = new Map<string, Located>();
    if (showAll) {
      for (const loc of all) {
        const fm = loc.entry.fm;
        if (fm.status !== 'superseded' || !fm.topic) continue;
        if (groups.has(fm.topic) || retiredByTopic.has(fm.topic)) continue;
        retiredByTopic.set(fm.topic, loc);
      }
    }

    if (rows.length === 0 && withoutTopic.length === 0 && retiredByTopic.size === 0) {
      console.log('No living-document topics yet. Pass --topic (or topic:) when writing to start one.');
      return 0;
    }

    console.log(
      `${rows.length} topic(s) · ${withTopic.length} topic document(s) · ${withoutTopic.length} active document(s) without a topic`,
    );
    console.log('');

    if (rows.length > 0) {
      console.log(`${'TOPIC'.padEnd(NAME_WIDTH)}DOCS  LAST        CONF  POLICY   TITLE`);
      for (const r of rows) {
        const name = r.name.length > NAME_WIDTH - 1 ? `${r.name.slice(0, NAME_WIDTH - 2)}…` : r.name;
        console.log(
          `${name.padEnd(NAME_WIDTH)}${String(r.docs).padEnd(6)}${r.last.padEnd(12)}${r.confidence.toFixed(2)}  ${r.policy.padEnd(9)}${r.title}`,
        );
      }
      console.log('');
      if (rows.some((r) => r.policy !== 'always')) {
        console.log(
          'Policy: once = auto-assent after the topic was reviewed (a confirm or an assent both count); ' +
            'never = stay out of the queue. Set with `omem topic policy <topic> once`.',
        );
        console.log('');
      }
    }

    if (withoutTopic.length > 0) {
      console.log(`Without a topic (${withoutTopic.length}):`);
      for (const loc of sortByCreatedDesc(withoutTopic)) {
        const fm = loc.entry.fm;
        console.log(`  ${fm.id}  ${fm.confidence.toFixed(2)}  ${deriveTitle(loc.entry.body, 50)}`);
      }
      console.log('');
      console.log('Give one a topic by rewriting it with --topic; the old file becomes superseded.');
      console.log('');
    }

    if (retiredByTopic.size > 0) {
      console.log('Retired topics (only superseded documents left):');
      for (const [name, loc] of [...retiredByTopic.entries()].sort()) {
        const owner = resolveOwner(ctx.home, ctx.index, loc);
        const where = owner
          ? `${owner.entry.fm.topic ?? '(no topic)'}  ${owner.entry.fm.id}`
          : '(no active successor)';
        console.log(`  ${name.padEnd(NAME_WIDTH)}→  ${where}`);
      }
      console.log('');
      console.log('Searching a retired name finds nothing unless you pass --all.');
    }

    return 0;
  } finally {
    ctx.index.close();
  }
}
