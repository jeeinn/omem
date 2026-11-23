// omem sync / process 结束时的总结和下一步，不包含会话清单。
import { describe, it, expect } from 'vitest';
import { runSummaryLines } from '../../src/commands/run.js';
import { processSummaryLines } from '../../src/commands/process.js';
import type { RunReport } from '../../src/process/pipeline.js';

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    tier: 'agent',
    sessions: 4,
    skipped: 3,
    messages: 10,
    candidates: 0,
    written: [],
    deduped: 0,
    redacted: 0,
    excluded: 0,
    notes: [],
    waitingTopics: 2,
    waitingUnassigned: 1,
    waitingSessions: 5,
    ...over,
  };
}

describe('omem sync summary', () => {
  it('agent run points at PROCESS.md and does not list sessions', () => {
    const text = runSummaryLines(report(), false).join('\n');
    expect(text).toContain('Summary');
    expect(text).toContain('sessions 4 (3 unchanged)');
    expect(text).toContain('2 topic group(s) / 5 session(s) waiting');
    expect(text).toContain('1 unassigned');
    expect(text).toContain('Next');
    expect(text).toContain('PROCESS.md');
    expect(text).toContain('omem process');
    expect(text).not.toContain('session_id');
  });

  it('nothing waiting suggests running again later', () => {
    const text = runSummaryLines(report({ waitingTopics: 0, waitingUnassigned: 0 }), false).join('\n');
    expect(text).toContain('Nothing is waiting');
    expect(text).toContain('omem search');
  });
});

describe('omem process summary', () => {
  it('pending queue suggests continuing with omem process', () => {
    const text = processSummaryLines(
      report({ tier: 'api', queuePending: 2, failed: 1, written: ['a'] }),
      false,
    ).join('\n');
    expect(text).toContain('pending 2');
    expect(text).toContain('omem process');
    expect(text).not.toContain('omem sync --tier api');
    expect(text).not.toContain('## user');
    expect(text).not.toContain('duplicate topic'); // no hint without a duplicate
  });

  it('possible duplicate topic points at review', () => {
    const text = processSummaryLines(
      report({ tier: 'api', written: ['a'], duplicateTopics: 2 }),
      false,
    ).join('\n');
    expect(text).toContain('Possible duplicate topics were logged');
    expect(text).toContain('omem review');
  });
});

describe('omem sync summary: actionable next step and verbose detail', () => {
  it('Next gives a concrete batch size and the pending-review entry point', () => {
    const text = runSummaryLines(report(), false).join('\n');
    expect(text).toContain('omem process --limit 5');
    expect(text).toContain('omem review --pending');
  });

  it('a large backlog caps the suggested batch at 10', () => {
    const text = runSummaryLines(report({ waitingSessions: 900 }), false).join('\n');
    expect(text).toContain('omem process --limit 10');
  });

  it('--verbose lists what was collected; the default summary stays quiet', () => {
    const r = report({
      ingested: [
        { agent: 'claude-code', session_id: 's-1', messages: 3, project_fp: 'local:aaa' },
        { agent: 'deepseek', session_id: 's-2', messages: 5, project_fp: 'unknown' },
      ],
    });
    expect(runSummaryLines(r, false).join('\n')).not.toContain('s-1');

    const loud = runSummaryLines(r, false, true).join('\n');
    expect(loud).toContain('Collected 2 session(s)');
    expect(loud).toContain('claude-code:s-1');
    expect(loud).toContain('deepseek:s-2');
  });
});
