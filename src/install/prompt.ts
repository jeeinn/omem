// 交互式客户端选择器（规格 §6.3）：纯状态机 + 纯渲染，与 IO 分离以便单测。
// 约束：不引入运行时依赖（规格 §10），只用 Node 内建 readline 的 keypress + raw mode。
import { emitKeypressEvents } from 'node:readline';

export interface ChoiceItem {
  id: string;
  name: string;
  detail: string;
  detected: boolean;
  selected: boolean;
  /** other = 非注册表内的客户端，选中后只打印通用片段，不写任何文件 */
  kind: 'client' | 'other';
}

export interface PromptState {
  items: ChoiceItem[];
  cursor: number;
  done: boolean;
  cancelled: boolean;
}

export type KeyName = 'up' | 'down' | 'space' | 'all' | 'none' | 'enter' | 'cancel' | 'ignore';

/** 构建选项：预选 detected && verified 的客户端（规格 §6.3：路径已核实者优先）。 */
export function buildItems(
  clients: { id: string; name: string; path: string; detected: boolean; verified: boolean; note?: string }[],
): ChoiceItem[] {
  const items: ChoiceItem[] = clients.map((c) => ({
    id: c.id,
    name: c.name,
    detail: c.path,
    detected: c.detected,
    selected: c.detected && c.verified,
    kind: 'client',
  }));
  items.push({
    id: 'other',
    name: 'Not listed',
    detail: 'print a generic mcpServers snippet',
    detected: false,
    selected: false,
    kind: 'other',
  });
  return items;
}

export function initialState(items: ChoiceItem[]): PromptState {
  return { items, cursor: 0, done: false, cancelled: false };
}

/** 把 readline 的 key 对象归一化为我们的键名。 */
export function keyName(key: { name?: string; ctrl?: boolean; sequence?: string } | undefined): KeyName {
  if (!key) return 'ignore';
  if (key.ctrl && key.name === 'c') return 'cancel';
  switch (key.name) {
    case 'up':
    case 'k':
      return 'up';
    case 'down':
    case 'j':
      return 'down';
    case 'space':
      return 'space';
    case 'a':
      return 'all';
    case 'n':
      return 'none';
    case 'return':
    case 'enter':
      return 'enter';
    case 'q':
    case 'escape':
      return 'cancel';
    default:
      return key.sequence === ' ' ? 'space' : 'ignore';
  }
}

/** 纯归约：按键 → 新状态。不触碰终端。 */
export function reduce(state: PromptState, key: KeyName): PromptState {
  if (state.done || state.cancelled) return state;
  const n = state.items.length;
  const move = (delta: number): PromptState => ({
    ...state,
    cursor: n === 0 ? 0 : (state.cursor + delta + n) % n,
  });
  const setAll = (selected: boolean): PromptState => ({
    ...state,
    items: state.items.map((it) => ({ ...it, selected })),
  });

  switch (key) {
    case 'up':
      return move(-1);
    case 'down':
      return move(1);
    case 'space': {
      const items = state.items.map((it, i) => (i === state.cursor ? { ...it, selected: !it.selected } : it));
      return { ...state, items };
    }
    case 'all':
      return setAll(true);
    case 'none':
      return setAll(false);
    case 'enter':
      return { ...state, done: true };
    case 'cancel':
      return { ...state, cancelled: true };
    default:
      return state;
  }
}

export function selectedIds(state: PromptState): string[] {
  return state.items.filter((it) => it.selected).map((it) => it.id);
}

const MARK = { on: '◉', off: '◯' };

/** 纯渲染：返回要打印的行。宽度自适应终端列数（默认 100）。 */
export function render(state: PromptState, columns = 100): string[] {
  const width = Math.max(40, Math.min(columns, 120));
  const idW = Math.max(...state.items.map((it) => it.id.length), 4);
  const nameW = Math.max(...state.items.map((it) => it.name.length), 4);
  const detailW = width - (2 + 2 + idW + 2 + nameW + 2 + 12);

  const lines = ['omem install — select clients to wire up', ''];
  state.items.forEach((it, i) => {
    const pointer = i === state.cursor ? '>' : ' ';
    const mark = it.selected ? MARK.on : MARK.off;
    const detail = it.detail.length > detailW ? it.detail.slice(0, Math.max(8, detailW - 1)) + '…' : it.detail;
    const flags = it.kind === 'other' ? '' : it.detected ? '  [detected]' : '  [not detected]';
    lines.push(`${pointer} ${mark} ${it.id.padEnd(idW)}  ${it.name.padEnd(nameW)}  ${detail.padEnd(Math.max(8, detailW))}${flags}`);
  });
  lines.push('');
  lines.push('  space toggle · a all · n none · ↑/↓ move · enter confirm · q cancel');
  return lines;
}

/** IO 层：进入 raw mode 交互。仅应在 stdin.isTTY 时调用。 */
export async function selectClients(
  items: ChoiceItem[],
  io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } = { stdin: process.stdin, stdout: process.stdout },
): Promise<{ selected: string[]; cancelled: boolean }> {
  let state = initialState(items);
  const { stdin, stdout } = io;
  let drawn = 0;

  const paint = (): void => {
    const lines = render(state, stdout.columns ?? 100);
    if (drawn > 0) stdout.write(`\x1b[${drawn}A\x1b[J`);
    stdout.write(lines.map((l) => `\x1b[2K${l}`).join('\n') + '\n');
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    // Ctrl+C 在 raw mode 下由 keypress 捕获；但外部 kill -INT 会绕过它，
    // 这时若不恢复 raw mode，用户的终端会卡在原始模式（输入不可见）。
    const onSigint = (): void => {
      cleanup();
      process.exit(130);
    };
    const cleanup = (): void => {
      process.removeListener('SIGINT', onSigint);
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?25h');
      stdout.write(`\x1b[${drawn}A\x1b[J`);
    };
    const onKey = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
      state = reduce(state, keyName(key));
      if (state.done || state.cancelled) {
        const result = { selected: selectedIds(state), cancelled: state.cancelled };
        cleanup();
        resolve(result);
        return;
      }
      paint();
    };

    emitKeypressEvents(stdin);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.resume();
    process.once('SIGINT', onSigint);
    stdout.write('\x1b[?25l');
    paint();
    stdin.on('keypress', onKey);
  });
}
