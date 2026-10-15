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

const USAGE = `用法:
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
    throw new UsageError(`未找到标注: ${paths.annotationsPath}（可用 --golden 指向含 annotations.json 的目录）`);
  }
  const annotations = loadAnnotations(paths.annotationsPath);
  const score = scoreAnnotations(paths.goldenDir, annotations);
  console.log(formatRecall(score));

  if (flagBool(args.flags, 'write-baseline')) {
    const file = writeBaseline(paths.baselinePath, score);
    console.log(`已写入基线: ${paths.baselinePath}（kind=${file.kind}，只作回归，不是质量门槛）`);
  } else if (score.kind === 'synthetic') {
    console.log('合成样本只验证管道，本次不写入 baseline.json。真实标注就绪后用 --write-baseline 更新基线。');
  }

  const recorded = readBaseline(paths.baselinePath);
  const flagMin = flagStr(args.flags, 'min-recall');
  const threshold = flagMin !== undefined ? Number(flagMin) : recorded?.recall;
  if (threshold === undefined || Number.isNaN(threshold)) {
    console.log('没有基线，只打印不判定。');
    return 0;
  }
  if (score.recall + 1e-9 < threshold) {
    console.error(`recall ${score.recall} 低于基线 ${threshold}`);
    return 1;
  }
  console.log(`未低于基线 ${threshold}`);
  return 0;
}

function cmdSample(args: ParsedArgs): number {
  const paths = resolveEvalPaths(flagStr(args.flags, 'golden'));
  if (!existsSync(paths.annotationsPath)) {
    throw new UsageError(`未找到标注: ${paths.annotationsPath}`);
  }
  const nRaw = flagStr(args.flags, 'n');
  const n = nRaw ? Number(nRaw) : 20;
  if (!Number.isFinite(n) || n <= 0) throw new UsageError('--n 需为正数');
  const annotations = loadAnnotations(paths.annotationsPath);
  const rows = collectSamples(paths.goldenDir, annotations, n);
  const payload = {
    note: '人工判断通道（Q1）。judgment 填「对」或「错」：这条记忆抽得对不对。通过率 = 对 / 已标注。样本量与口径先于 80% 门槛。',
    candidates: rows,
  };
  const text = JSON.stringify(payload, null, 2) + '\n';
  const out = flagStr(args.flags, 'out');
  if (out) {
    atomicWrite(out, text);
    console.log(`已导出 ${rows.length} 条候选: ${out}`);
  } else {
    console.log(text);
  }
  return 0;
}
