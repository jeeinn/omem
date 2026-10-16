// omem eval：召回基线（弱代理）与人工标注导出（Q1）。
// 合成 fixture 的数字默认不写入 baseline.json；--write-baseline 才落盘。
// 没有基线时只打印、不判定。低于已记录 recall 才退出 1。
import { existsSync } from 'node:fs';
import { atomicWrite } from '../core/util.js';
import { UsageError } from '../core/util.js';
import { flagBool, flagStr } from '../cli-args.js';
import type { ParsedArgs } from '../cli-args.js';
import {
  collectSamples,
  formatRecall,
  loadAnnotations,
  readBaseline,
  resolveEvalPaths,
  scoreAnnotations,
  writeBaseline,
} from '../process/eval.js';

const USAGE = `Usage:
  omem eval recall [--golden <dir>] [--write-baseline] [--min-recall <n>]
  omem eval sample [--golden <dir>] [--n 20] [--out <file>]`;

export async function cmdEval(args: ParsedArgs): Promise<number> {
  const sub = args._[0];
  if (sub === 'recall') return cmdRecall(args);
  if (sub === 'sample') return cmdSample(args);
  console.error(USAGE);
  return sub ? 1 : 1;
}

function cmdRecall(args: ParsedArgs): number {
  const paths = resolveEvalPaths(flagStr(args.flags, 'golden'));
  if (!existsSync(paths.annotationsPath)) {
    throw new UsageError(`Annotations not found: ${paths.annotationsPath} (use --golden to point at a directory containing annotations.json)`);
  }
  const annotations = loadAnnotations(paths.annotationsPath);
  const score = scoreAnnotations(paths.goldenDir, annotations);
  console.log(formatRecall(score));

  if (flagBool(args.flags, 'write-baseline')) {
    const file = writeBaseline(paths.baselinePath, score);
    console.log(`Baseline written: ${paths.baselinePath} (kind=${file.kind}; regression guard only, not a quality gate)`);
  } else if (score.kind === 'synthetic') {
    console.log('Synthetic samples only verify the pipeline; baseline.json not written this time. Update the baseline with --write-baseline once real annotations are ready.');
  }

  const recorded = readBaseline(paths.baselinePath);
  const flagMin = flagStr(args.flags, 'min-recall');
  const threshold = flagMin !== undefined ? Number(flagMin) : recorded?.recall;
  if (threshold === undefined || Number.isNaN(threshold)) {
    console.log('No baseline; printing only, no verdict.');
    return 0;
  }
  if (score.recall + 1e-9 < threshold) {
    console.error(`recall ${score.recall} is below baseline ${threshold}`);
    return 1;
  }
  console.log(`Not below baseline ${threshold}`);
  return 0;
}

function cmdSample(args: ParsedArgs): number {
  const paths = resolveEvalPaths(flagStr(args.flags, 'golden'));
  if (!existsSync(paths.annotationsPath)) {
    throw new UsageError(`Annotations not found: ${paths.annotationsPath}`);
  }
  const nRaw = flagStr(args.flags, 'n');
  const n = nRaw ? Number(nRaw) : 20;
  if (!Number.isFinite(n) || n <= 0) throw new UsageError('--n must be a positive number');
  const annotations = loadAnnotations(paths.annotationsPath);
  const rows = collectSamples(paths.goldenDir, annotations, n);
  const payload = {
    note: 'Manual judgment channel (Q1). Fill judgment with "correct" or "wrong": whether this memory was extracted correctly. Pass rate = correct / judged. Sample size and criteria take priority over the 80% threshold.',
    candidates: rows,
  };
  const text = JSON.stringify(payload, null, 2) + '\n';
  const out = flagStr(args.flags, 'out');
  if (out) {
    atomicWrite(out, text);
    console.log(`Exported ${rows.length} candidates: ${out}`);
  } else {
    console.log(text);
  }
  return 0;
}
