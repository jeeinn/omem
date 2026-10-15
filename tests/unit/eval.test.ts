// eval：合成 fixture 跑通度量；基线只作回归，不把合成数字当质量结论。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdEval } from '../../src/commands/eval.js';
import {
  collectSamples,
  loadAnnotations,
  scoreAnnotations,
  writeBaseline,
} from '../../src/process/eval.js';

const ROOT = join(process.cwd(), 'tests', 'eval');

describe('eval 合成管道', () => {
  it('对仓库内合成 golden 产出 0–1 的 recall / precision', () => {
    const ann = loadAnnotations(join(ROOT, 'annotations.json'));
    expect(ann.kind).toBe('synthetic');
    const score = scoreAnnotations(join(ROOT, 'golden'), ann);
    expect(score.sessions).toBe(1);
    expect(score.candidates).toBeGreaterThan(0);
    expect(score.recall).toBeGreaterThan(0);
    expect(score.recall).toBeLessThanOrEqual(1);
    expect(score.precision).toBeGreaterThan(0);
    expect(score.precision).toBeLessThanOrEqual(1);
    expect(score.misses.map((m) => m.text).join('\n')).not.toContain('手写 SQL');
  });

  it('sample 导出带空 judgment 的候选', () => {
    const ann = loadAnnotations(join(ROOT, 'annotations.json'));
    const rows = collectSamples(join(ROOT, 'golden'), ann, 3);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.judgment === null && r.content.length > 0)).toBe(true);
  });

  it('低于记录基线退出 1；没有基线只打印', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omem-eval-'));
    try {
      mkdirSync(join(dir, 'golden'));
      writeFileSync(join(dir, 'golden', 'synthetic-sess-fixture-1.jsonl'), readFileSync(join(ROOT, 'golden', 'synthetic-sess-fixture-1.jsonl')));
      writeFileSync(join(dir, 'annotations.json'), readFileSync(join(ROOT, 'annotations.json')));
      const logs: string[] = [];
      const orig = console.log;
      const origErr = console.error;
      console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
      console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
      try {
        const printed = await cmdEval({ _: ['recall'], flags: { golden: dir } });
        expect(printed).toBe(0);
        expect(logs.join('\n')).toContain('没有基线');
        expect(logs.join('\n')).toContain('不写入 baseline');

        const ann = loadAnnotations(join(dir, 'annotations.json'));
        ann.sessions[0].extract.push('完全不会被抽出的句子 zzzz-miss');
        writeFileSync(join(dir, 'annotations.json'), JSON.stringify(ann));
        const score = scoreAnnotations(join(dir, 'golden'), ann);
        expect(score.recall).toBeLessThan(1);
        writeBaseline(join(dir, 'baseline.json'), { ...score, recall: 1 });
        logs.length = 0;
        const failed = await cmdEval({ _: ['recall'], flags: { golden: dir } });
        expect(failed).toBe(1);

        logs.length = 0;
        const out = join(dir, 'sample.json');
        const sampled = await cmdEval({ _: ['sample'], flags: { golden: dir, n: '2', out } });
        expect(sampled).toBe(0);
        const body = JSON.parse(readFileSync(out, 'utf8')) as { candidates: { judgment: null }[] };
        expect(body.candidates).toHaveLength(2);
        expect(body.candidates[0].judgment).toBeNull();
      } finally {
        console.log = orig;
        console.error = origErr;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
