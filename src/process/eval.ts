// 评估层度量（改进计划 P0-1）。
// recall 是子串包含匹配的弱代理：短摘录容易算命中，跨度也可能错位。它不是 Q1。
// Q1 是人工判断，走 sample 导出的候选。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWrite, nowIso } from '../core/util.js';
import { normalizeForHash } from '../core/util.js';
import { parseSessionFile } from '../collect/claude-code.js';
import { extractFromDigest } from './rules.js';
import type { Candidate } from './rules.js';

export interface SessionAnnotation {
  session: string;
  extract: string[];
  reject: string[];
}

export interface EvalAnnotations {
  kind?: 'synthetic' | 'real';
  note?: string;
  sessions: SessionAnnotation[];
}

export interface BaselineFile {
  date: string;
  kind: 'synthetic' | 'real';
  note: string;
  sessions: number;
  recall: number;
  precision: number;
  f1: number;
}

export interface SpanRef {
  session: string;
  text: string;
}

export interface EvalScore {
  kind: 'synthetic' | 'real';
  sessions: number;
  extractTotal: number;
  extractHit: number;
  candidates: number;
  truePositives: number;
  recall: number;
  precision: number;
  f1: number;
  misses: SpanRef[];
  falseExtracts: SpanRef[];
}

export interface SampleRow {
  session: string;
  type: string;
  confidence: number;
  content: string;
  judgment: null;
}

const LIMITATION =
  '子串包含匹配是弱代理：短摘录容易算命中，抽出的跨度也可能和标注错位。这个数字不是 Q1（Q1 是人工判断「抽得对不对」）。';

export function covers(candidate: string, needle: string): boolean {
  const a = normalizeForHash(candidate);
  const b = normalizeForHash(needle);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

export function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function walkJsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walkJsonl(path));
    else if (name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

export function loadAnnotations(path: string): EvalAnnotations {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as EvalAnnotations;
  if (!Array.isArray(parsed.sessions)) throw new Error(`annotations 缺少 sessions: ${path}`);
  return parsed;
}

export function scoreAnnotations(goldenDir: string, annotations: EvalAnnotations): EvalScore {
  const files = walkJsonl(goldenDir);
  const byName = new Map(files.map((p) => [basename(p), p]));
  let extractTotal = 0;
  let extractHit = 0;
  let candidates = 0;
  let truePositives = 0;
  const misses: SpanRef[] = [];
  const falseExtracts: SpanRef[] = [];

  for (const ann of annotations.sessions) {
    const path = byName.get(ann.session);
    if (!path) {
      for (const text of ann.extract) misses.push({ session: ann.session, text: `缺少会话文件: ${text}` });
      extractTotal += ann.extract.length;
      continue;
    }
    const digest = parseSessionFile(path);
    const found: Candidate[] = digest ? extractFromDigest(digest) : [];
    candidates += found.length;
    for (const needle of ann.extract) {
      extractTotal++;
      if (found.some((c) => covers(c.content, needle))) extractHit++;
      else misses.push({ session: ann.session, text: needle });
    }
    for (const c of found) {
      const hitExtract = ann.extract.some((needle) => covers(c.content, needle));
      const hitReject = (ann.reject ?? []).some((needle) => covers(c.content, needle));
      if (hitExtract && !hitReject) truePositives++;
      else falseExtracts.push({ session: ann.session, text: c.content });
    }
  }

  const recall = extractTotal === 0 ? 1 : extractHit / extractTotal;
  const precision = candidates === 0 ? (extractTotal === 0 ? 1 : 0) : truePositives / candidates;
  return {
    kind: annotations.kind === 'real' ? 'real' : 'synthetic',
    sessions: annotations.sessions.length,
    extractTotal,
    extractHit,
    candidates,
    truePositives,
    recall: round4(recall),
    precision: round4(precision),
    f1: round4(f1(precision, recall)),
    misses,
    falseExtracts,
  };
}

export function collectSamples(goldenDir: string, annotations: EvalAnnotations, n: number): SampleRow[] {
  const files = walkJsonl(goldenDir);
  const byName = new Map(files.map((p) => [basename(p), p]));
  const rows: SampleRow[] = [];
  for (const ann of annotations.sessions) {
    const path = byName.get(ann.session);
    if (!path) continue;
    const digest = parseSessionFile(path);
    if (!digest) continue;
    for (const c of extractFromDigest(digest)) {
      rows.push({ session: ann.session, type: c.type, confidence: c.confidence, content: c.content, judgment: null });
      if (rows.length >= n) return rows;
    }
  }
  return rows;
}

export function readBaseline(path: string): BaselineFile | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
}

export function writeBaseline(path: string, score: EvalScore): BaselineFile {
  const file: BaselineFile = {
    date: nowIso(),
    kind: score.kind,
    note: score.kind === 'synthetic'
      ? '合成 fixture 的管道回归基线，不是质量结论。' + LIMITATION
      : '回归基线。低于记录值才失败；数字本身不是 Q1。' + LIMITATION,
    sessions: score.sessions,
    recall: score.recall,
    precision: score.precision,
    f1: score.f1,
  };
  atomicWrite(path, JSON.stringify(file, null, 2) + '\n');
  return file;
}

export function formatRecall(score: EvalScore): string {
  const lines = [
    LIMITATION,
    `kind=${score.kind} 会话 ${score.sessions} 候选 ${score.candidates}`,
    `recall ${score.recall}（${score.extractHit}/${score.extractTotal}） precision ${score.precision}（${score.truePositives}/${score.candidates}） F1 ${score.f1}`,
  ];
  if (score.misses.length > 0) {
    lines.push('未命中标注:');
    for (const m of score.misses) lines.push(`- ${m.session}: ${m.text}`);
  }
  if (score.falseExtracts.length > 0) {
    lines.push('未对齐候选（多抽或命中 reject）:');
    for (const m of score.falseExtracts.slice(0, 20)) lines.push(`- ${m.session}: ${m.text}`);
    if (score.falseExtracts.length > 20) lines.push(`- …另有 ${score.falseExtracts.length - 20} 条`);
  }
  return lines.join('\n');
}

export function defaultEvalRoot(cwd = process.cwd()): string {
  return join(cwd, 'tests', 'eval');
}

export function resolveEvalPaths(goldenFlag?: string, cwd = process.cwd()): {
  goldenDir: string;
  annotationsPath: string;
  baselinePath: string;
} {
  if (!goldenFlag) {
    const root = defaultEvalRoot(cwd);
    return {
      goldenDir: join(root, 'golden'),
      annotationsPath: join(root, 'annotations.json'),
      baselinePath: join(root, 'baseline.json'),
    };
  }
  if (existsSync(join(goldenFlag, 'annotations.json'))) {
    const nested = join(goldenFlag, 'golden');
    return {
      goldenDir: existsSync(nested) ? nested : goldenFlag,
      annotationsPath: join(goldenFlag, 'annotations.json'),
      baselinePath: join(goldenFlag, 'baseline.json'),
    };
  }
  const parent = dirname(goldenFlag);
  return {
    goldenDir: goldenFlag,
    annotationsPath: join(parent, 'annotations.json'),
    baselinePath: join(parent, 'baseline.json'),
  };
}

export { LIMITATION };
