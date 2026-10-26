// omem sync 的单行进度（TTY 上覆盖同一行；非 TTY 不刷屏）。
// 形态对齐 codegraph sync：轨道 + 条 + 百分比。不做动画线程。

const WIDTH = 24;

function glyphs(): { rail: string; filled: string; empty: string } {
  const ascii = process.env.OMEM_ASCII === '1'
    || (process.platform === 'win32' && !process.env.WT_SESSION && !process.env.TERM_PROGRAM);
  return ascii
    ? { rail: '|', filled: '#', empty: '-' }
    : { rail: '│', filled: '█', empty: '░' };
}

/** 执行期间的进度条。非 TTY（定时任务、测试）里 update/clear 都是空操作。 */
export function createRunProgress(): {
  update: (phase: string, done: number, total: number) => void;
  clear: () => void;
} {
  const tty = Boolean(process.stdout.isTTY);
  const g = glyphs();
  let shown = false;
  return {
    update(phase, done, total) {
      if (!tty) return;
      const pct = total <= 0 ? 100 : Math.min(100, Math.round((done / total) * 100));
      const filled = Math.round((WIDTH * pct) / 100);
      const bar = g.filled.repeat(filled) + g.empty.repeat(WIDTH - filled);
      process.stdout.write(`\r\x1b[2K${g.rail}  ${phase}  ${bar}  ${pct}%`);
      shown = true;
    },
    clear() {
      if (!tty || !shown) return;
      process.stdout.write('\r\x1b[2K');
      shown = false;
    },
  };
}
