// omem redact：唯一硬删除途径（规格 §4.2 X 层；§7；v0.3 决策 D7）。
// --topic 与 --source 都**默认只预览，必须显式 --yes 才删**。
// 硬删除不可逆，且只作用于本地当前文件：git 历史、snapshots/、远端备份与别的机器上的副本
// 都不在删除范围内；omem 不改写 git 历史，也不做 topic 级备份排除。
// 预览会给出范围、条数与样例，确认无误后再带 --yes 重跑。
import { openCtx } from '../core/ctx.js';
import { deleteTopic, findByTopic, listEntries } from '../core/store.js';
import type { Located } from '../core/store.js';
import { generateMemoryIndex } from '../core/lifecycle.js';
import { appendLog } from '../core/log.js';
import { UsageError } from '../core/util.js';
import { flagStr, flagBool } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import type { EntrySource } from '../core/entry.js';

const SOURCES: EntrySource[] = ['rules', 'agent', 'llm', 'manual'];
const USAGE = 'Usage: omem redact --topic <name> [--yes] | omem redact --source rules|agent|llm|manual [--yes]\n'
  + 'Without --yes both forms only preview. Hard delete affects the local Markdown and its index row only; '
  + 'git history, snapshots/ and remote backups are out of scope.';
const SAMPLE_LIMIT = 5;

/** 两种删除路径共用的范围说明：删掉当前文件 ≠ 从所有副本里抹除。 */
const DELETION_SCOPE = [
  'Scope: deletes the local Markdown file and its index row only.',
  'Not removed: earlier versions in the data repo git history, files under snapshots/, '
    + 'copies already pushed to a remote backup, or copies on other machines.',
  'omem never rewrites git history and never excludes a topic from backups.',
];

function printScope(): void {
  for (const line of DELETION_SCOPE) console.log(line);
}

/** 单条预览：只打印将删什么与删除范围，不动任何文件。 */
function printTopicPreview(topic: string, loc: Located): void {
  const fm = loc.entry.fm;
  const body = String(loc.entry.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  console.log(`Dry run: would hard delete topic "${topic}". Nothing was deleted.`);
  console.log(`  File: ${loc.path} (${loc.location})`);
  console.log(`  Status: ${String(fm.status ?? 'unknown')}  Domain: ${String(fm.domain ?? '(none)')}  Confidence: ${String(fm.confidence ?? '(none)')}`);
  console.log(`  Body: ${body || '(empty)'}`);
  printScope();
  console.log(`Re-run to actually delete: omem redact --topic ${topic} --yes`);
}

/** 批量预览：只打印将删什么，不动任何文件。 */
function printPreview(source: string, matches: Located[], total: number): void {
  console.log(`Dry run: ${matches.length} entries match source=${source}. Nothing was deleted.`);
  if (total > 0) {
    const pct = ((matches.length / total) * 100).toFixed(1);
    console.log(`  Coverage: ${matches.length}/${total} entries in the repo (${pct}%). ${total - matches.length} will be kept.`);
    if (matches.length === total) console.log('  ! This matches EVERY entry in the repo — it will be emptied.');
  }

  const tally = (pick: (fm: any) => string): string => {
    const m = new Map<string, number>();
    for (const l of matches) {
      const k = pick(l.entry.fm) || '(none)';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ');
  };
  console.log(`  By domain: ${tally((fm) => String(fm.domain ?? ''))}`);
  console.log(`  By status: ${tally((fm) => String(fm.status ?? ''))}`);

  console.log(`  Samples (max ${SAMPLE_LIMIT}):`);
  for (const l of matches.slice(0, SAMPLE_LIMIT)) {
    const c = String(l.entry.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    console.log(`    - ${l.entry.fm.topic || '?'}  ${c}`);
  }

  console.log('');
  console.log('Hard delete cannot be undone except through the data repo\'s git history.');
  printScope();
  console.log(`Re-run to actually delete: omem redact --source ${source} --yes`);
}

export async function cmdRedact(args: ParsedArgs): Promise<number> {
  const topic = flagStr(args.flags, 'topic');
  const source = flagStr(args.flags, 'source');
  const yes = flagBool(args.flags, 'yes');
  if (topic && source) throw new UsageError(USAGE);
  if (!topic && !source) throw new UsageError(USAGE);
  const { home, index } = openCtx();
  try {
    if (topic) {
      const loc = findByTopic(home, topic, { includeArchived: true });
      if (!loc) throw new UsageError(`Topic not found: ${topic}`);
      if (!yes) {
        printTopicPreview(topic, loc);
        return 0;
      }
      const ok = deleteTopic(home, topic);
      if (!ok) throw new UsageError(`Topic not found: ${topic}`);
      index.remove(topic);
      generateMemoryIndex(home, index);
      appendLog(home, 'redact', { topic });
      console.log(`Hard deleted: ${topic}`);
      printScope();
      return 0;
    }
    if (!SOURCES.includes(source as EntrySource)) throw new UsageError(USAGE);
    const all = listEntries(home, { includeArchived: true });
    const matches = all.filter((l) => l.entry.fm.source === source);
    const topics = matches.map((l) => l.entry.fm.topic).filter((x): x is string => typeof x === 'string' && x.length > 0);

    if (topics.length === 0) {
      console.log(`No entries match source=${source}. Nothing to delete.`);
      return 0;
    }
    if (!yes) {
      printPreview(source!, matches, all.length);
      return 0;
    }

    for (const t of topics) {
      deleteTopic(home, t);
      index.remove(t);
    }
    generateMemoryIndex(home, index);
    appendLog(home, 'redact', { source, count: topics.length });
    console.log(`Hard deleted ${topics.length} entries (source=${source}).`);
    printScope();
    return 0;
  } finally {
    index.close();
  }
}
