// omem add：手动写入一条记忆（source: manual，confidence 0.9——用户显式断言）。
// 过滤、去重、落盘走 commitEntry。--force 只绕过代码密度与长度上限。
// D1-B′：topic 必填，写入即覆盖同名活文档。
// D2：不再写 `verified`——「用户亲口说的」由 source=manual + confidence 0.9 表达。
import { openCtx } from '../core/ctx.js';
import { autoCommit, commitEntry, metadataDrift, overCapNotice, reactivationNotice, reactivatedNotice, staleRevisionNotice, vcsNotice, writeDiffNotice } from '../core/commit.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagList, flagStr } from '../cli-args.js';
import { beginWriteJournal, endWriteJournal } from '../core/write-journal.js';
import type { ParsedArgs } from '../cli-args.js';
import type { MemoryType } from '../core/entry.js';

const USAGE = 'Usage: omem add <content> --topic <name> [--type preference|fact|decision|experience] [--domain X] [--tags a,b] [--project fp] [--force]'
  + '\n--topic is required: every memory is a living document, and its name is the topic.'
  + '\nContent longer than [process] max_content_chars is rejected; --force truncates it instead (the tail is lost).'
  + '\n--reactivate is required to write into an archived or stale topic: it restores the document to active.'
  + '\n--expected-revision <hash> refuses the write when the topic changed since it was read (best-effort, not a strict CAS).';

export async function cmdAdd(args: ParsedArgs): Promise<number> {
  const content = args._.join(' ').trim();
  if (!content) throw new UsageError(USAGE);
  const topic = flagStr(args.flags, 'topic');
  if (!topic?.trim()) throw new UsageError(USAGE);
  const ctx = openCtx();
  try {
    const typeArg = flagStr(args.flags, 'type');
    const type: MemoryType = (['preference', 'fact', 'decision', 'experience'] as MemoryType[]).includes(typeArg as MemoryType)
      ? (typeArg as MemoryType)
      : 'fact';
    const tags = flagList(args.flags, 'tags');
    const force = flagBool(args.flags, 'force');
    beginWriteJournal();
    const result = commitEntry(ctx.home, ctx.config, ctx.index, {
      content,
      type,
      domain: flagStr(args.flags, 'domain'),
      tags,
      project: flagStr(args.flags, 'project'),
      topic,
      source: 'manual',
      confidence: 0.9,
      // 三条写路径各自显式表态（beta.9 / T02）：CLI 默认拒绝超长内容，
      // --force 是唯一保留旧截断行为的出口——它是逃生口，不是默认。
      // v0.3 D4：归档/冷却主题必须由显式意图恢复，CLI 侧用旗标表达。
      reactivate: flagBool(args.flags, 'reactivate'),
      // D3：可选的乐观版本基线；未给时完全不检查，保持既有写入路径不变。
      expected_revision: flagStr(args.flags, 'expected-revision') || undefined,
      overCap: force ? 'truncate' : 'reject',
    }, { force });

    if ((result.redacted ?? 0) > 0 && result.status !== 'redacted-empty') {
      console.log(`Redacted ${result.redacted} sensitive spot(s)`);
    }
    if (result.status === 'deduped') {
      console.log(`Content already exists (topic: ${result.topic}); not written again.`);
      // 去重只挡正文：请求的 topic/type/tags 若与既有文档不同，差异要能看出来并给出路，
      // 否则用户会以为 --topic 生效了。比对口径与 MCP 共用 metadataDrift；
      // type 只在显式给了合法值时才比对（没给或给错时它回落成 fact，报漂移是误伤）。
      const diffs = metadataDrift(result.existing, { topic, type: typeArg === type ? typeArg : undefined, tags });
      if (diffs.length > 0) {
        console.log(`Metadata not applied: ${diffs.join('; ')}.`);
        console.log(`Change the body and re-run with --topic ${result.existing?.topic ?? '<name>'} to write into the existing document.`);
      }
      return 0;
    }
    if (result.status === 'excluded' || result.status === 'redacted-empty') {
      // 超限用统一四段回执（与 MCP 同一实现，避免两处各写一遍漂成两种说法）。
      if (result.overCap) {
        for (const line of overCapNotice(result.overCap, 'cli')) console.log(line);
        return 0;
      }
      console.log(`Not written: ${result.reason}`);
      if (!force && result.status === 'excluded' && result.reason !== 'Content is empty') {
        console.log('To record it anyway, add --force (does not bypass redaction or dedup).');
      }
      return 0;
    }
    if (result.status === 'needs-reactivation' && result.reactivation) {
      for (const line of reactivationNotice(result.reactivation, 'cli')) console.log(line);
      return 0;
    }
    if (result.status === 'stale-revision' && result.staleRevision) {
      for (const line of staleRevisionNotice(result.staleRevision, 'cli')) console.log(line);
      return 0;
    }
    console.log(`${result.updated ? 'Updated' : 'Saved'} topic: ${result.topic}`);
    console.log(`File: ${result.path}`);
    if (result.reactivated) console.log(reactivatedNotice(result.reactivated, result.topic ?? topic));
    if (result.diff) for (const line of writeDiffNotice(result.diff, 'cli')) console.log(line);
    if (result.truncated) {
      console.log(`Truncated to ${result.truncated.limit} characters (--force); the last ${result.truncated.chars - result.truncated.limit} character(s) were discarded.`);
      // 审计落点：磁盘上不留标记（不加 frontmatter 字段、不加 tags），但 topic + 截断量进日志。
      console.log(`Force-truncated file: ${result.topic} — recorded in logs/omem.log. Review the end of the body before relying on it.`);
    }
    // 写入即有版本历史（T05）：一次命令一次提交，非 git 仓只说明不报错。
    const touched = endWriteJournal();
    console.log(vcsNotice(autoCommit(ctx.home, ctx.config, `omem: add ${result.topic ?? ''}`.trim(), touched), 'cli'));
    for (const w of result.warnings ?? []) console.log(`Note: ${w}`);
    return 0;
  } finally {
    ctx.index.close();
  }
}
