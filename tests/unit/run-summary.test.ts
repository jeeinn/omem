// omem sync 结束时的总结和下一步，不包含会话清单。
import { describe, it, expect } from 'vitest';
import { runSummaryLines } from '../../src/commands/run.js';
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
    ...over,
  };
}

describe('omem sync summary', () => {
  it('agent run points at PROCESS.md and does not list sessions', () => {
    const text = runSummaryLines(report(), false).join('\n');
    expect(text).toContain('Summary');
    expect(text).toContain('sessions 4 (3 unchanged)');
    expect(text).toContain('2 topic group(s) waiting');
    expect(text).toContain('1 unassigned');
    expect(text).toContain('Next');
    expect(text).toContain('PROCESS.md');
    expect(text).not.toContain('session_id');
  });

  it('nothing waiting suggests running again later', () => {
    const text = runSummaryLines(report({ waitingTopics: 0, waitingUnassigned: 0 }), false).join('\n');
    expect(text).toContain('Nothing is waiting');
    expect(text).toContain('omem search');
  });

  it('api run with pending suggests continuing the queue', () => {
    const text = runSummaryLines(report({ tier: 'api', queuePending: 2, failed: 1, written: ['a'] }), false).join('\n');
    expect(text).toContain('pending 2');
    expect(text).toContain('omem sync --tier api');
    expect(text).not.toContain('## user');
    expect(text).not.toContain('duplicate topic'); // no hint without a duplicate
  });

  it('api run with a possible duplicate topic points at review', () => {
    const text = runSummaryLines(report({ tier: 'api', written: ['a'], duplicateTopics: 2 }), false).join('\n');
    expect(text).toContain('Possible duplicate topics were logged');
    expect(text).toContain('omem review');
  });
});
