// 交互式客户端选择器测试（规格 §6.3）：纯状态机与渲染，无需 TTY。
import { describe, it, expect } from 'vitest';
import { buildItems, initialState, reduce, render, keyName, selectedIds, selectClients } from '../../src/install/prompt.js';
import type { PromptState } from '../../src/install/prompt.js';

function clients() {
  return [
    { id: 'claude-code', name: 'Claude Code', path: '~/.claude.json', detected: true, verified: false },
    { id: 'cursor', name: 'Cursor', path: '~/.cursor/mcp.json', detected: true, verified: true },
    { id: 'workbuddy', name: 'WorkBuddy', path: '~/.workbuddy/mcp.json', detected: true, verified: true },
    { id: 'codex', name: 'Codex CLI', path: '~/.codex/config.toml', detected: false, verified: false },
  ];
}

function state(): PromptState {
  return initialState(buildItems(clients()));
}

describe('install prompt: item construction', () => {
  it('preselects detected + path-verified clients only', () => {
    const ids = selectedIds(state());
    expect(ids).toEqual(['cursor', 'workbuddy']);
  });

  it('always appends the generic "other" entry, unselected, last', () => {
    const items = state().items;
    expect(items[items.length - 1].id).toBe('other');
    expect(items[items.length - 1].kind).toBe('other');
    expect(items[items.length - 1].selected).toBe(false);
  });

  it('marks detection state for display', () => {
    const items = state().items;
    expect(items.find((i) => i.id === 'codex')!.detected).toBe(false);
    expect(items.find((i) => i.id === 'claude-code')!.detected).toBe(true);
  });
});

describe('install prompt: key reduction', () => {
  it('down/up move the cursor and wrap around', () => {
    let s = state();
    s = reduce(s, 'down');
    expect(s.cursor).toBe(1);
    s = reduce(s, 'up');
    expect(s.cursor).toBe(0);
    s = reduce(s, 'up'); // 从 0 回到末尾
    expect(s.cursor).toBe(s.items.length - 1);
  });

  it('space toggles the item under the cursor', () => {
    let s = state();
    expect(s.items[0].selected).toBe(false);
    s = reduce(s, 'space');
    expect(s.items[0].selected).toBe(true);
    s = reduce(s, 'space');
    expect(s.items[0].selected).toBe(false);
  });

  it('a selects all, n clears all', () => {
    let s = reduce(state(), 'all');
    expect(s.items.every((i) => i.selected)).toBe(true);
    s = reduce(s, 'none');
    expect(s.items.every((i) => !i.selected)).toBe(true);
  });

  it('enter finishes without cancelling; cancel marks cancelled', () => {
    const done = reduce(state(), 'enter');
    expect(done.done).toBe(true);
    expect(done.cancelled).toBe(false);
    const cancelled = reduce(state(), 'cancel');
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.done).toBe(false);
  });

  it('is inert after done/cancelled (no accidental edits on extra keys)', () => {
    const baseline = state();
    const done = reduce(reduce(baseline, 'enter'), 'space');
    expect(done.items).toEqual(baseline.items);
    const cancelled = reduce(reduce(baseline, 'cancel'), 'all');
    expect(cancelled.items).toEqual(baseline.items);
  });

  it('ignores unknown keys', () => {
    const s = state();
    expect(reduce(s, 'ignore')).toEqual(s);
  });

  it('keeps the selection made by the user when entering', () => {
    let s = state();
    s = reduce(s, 'space'); // 选中 claude-code
    s = reduce(s, 'enter');
    expect(selectedIds(s)).toEqual(['claude-code', 'cursor', 'workbuddy']);
  });
});

describe('install prompt: key normalization', () => {
  it('maps readline key objects to our key names', () => {
    expect(keyName({ name: 'up' })).toBe('up');
    expect(keyName({ name: 'down' })).toBe('down');
    expect(keyName({ name: 'space' })).toBe('space');
    expect(keyName({ name: 'return' })).toBe('enter');
    expect(keyName({ name: 'escape' })).toBe('cancel');
    expect(keyName({ ctrl: true, name: 'c' })).toBe('cancel');
    expect(keyName({ name: 'x' })).toBe('ignore');
    expect(keyName(undefined)).toBe('ignore');
  });

  it('treats a literal space sequence as toggle', () => {
    expect(keyName({ name: undefined, sequence: ' ' })).toBe('space');
  });
});

describe('install prompt: render', () => {
  it('draws a pointer, selection marks and the key hints', () => {
    const lines = render(state());
    expect(lines[0]).toContain('omem install');
    expect(lines.some((l) => l.startsWith('> '))).toBe(true);
    expect(lines.some((l) => l.includes('◉ cursor'))).toBe(true);
    expect(lines.some((l) => l.includes('◯ claude-code'))).toBe(true);
    expect(lines.some((l) => l.includes('[not detected]'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('enter confirm');
  });

  it('marks the cursor line distinctly as it moves', () => {
    const s = reduce(state(), 'down');
    const lines = render(s);
    expect(lines.find((l) => l.startsWith('> '))).toContain('cursor');
  });

  it('truncates long paths instead of overflowing the terminal', () => {
    const items = buildItems([
      { id: 'x', name: 'X', path: '/'.repeat(400), detected: true, verified: true },
    ]);
    const lines = render(initialState(items), 60);
    expect(lines.every((l) => l.length < 200)).toBe(true);
    expect(lines.some((l) => l.includes('…'))).toBe(true);
  });

  it('is pure: same state renders identically twice', () => {
    const s = state();
    expect(render(s)).toEqual(render(s));
  });
});

describe('install prompt: IO layer (raw-mode interaction, driven by a fake stream)', () => {
  it('resolves the toggled selection and clears the drawn region', async () => {
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough() as any;
    const stdout = new PassThrough() as any;
    let drawn = '';
    stdout.on('data', (d: Buffer) => (drawn += d.toString()));
    const tick = () => new Promise((r) => setTimeout(r, 5));

    const promise = selectClients(buildItems(clients()), { stdin, stdout });
    await tick();
    stdin.write('\x1b[B'); // down → cursor 到 cursor 行
    await tick();
    stdin.write(' '); // 取消选中 cursor（原本预选）
    await tick();
    stdin.write('\r'); // enter
    const result = await promise;

    expect(result.cancelled).toBe(false);
    expect(result.selected).toEqual(['workbuddy']); // cursor 被取消，workbuddy 保持
    expect(drawn).toContain('omem install');
    expect(drawn).toContain('\x1b[?25l'); // 隐藏光标
    expect(drawn).toContain('\x1b[?25h'); // 结束时恢复光标
  });

  it('q cancels without selecting anything', async () => {
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough() as any;
    const stdout = new PassThrough() as any;
    stdout.on('data', () => {});
    const tick = () => new Promise((r) => setTimeout(r, 5));

    const promise = selectClients(buildItems(clients()), { stdin, stdout });
    await tick();
    stdin.write('q');
    const result = await promise;
    expect(result.cancelled).toBe(true);
  });
});
