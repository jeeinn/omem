// 启动失败的诊断文案。必须自包含：dist 加载不了时，这里不能 import 任何 dist 代码。
//
// 为什么单独成文件：原实现把所有启动异常都归到一句
// "Hint: run `npm run build` first"——对全局装包的用户完全不成立（他们没有源码），
// 而真实原因（原生绑定缺失、包不完整、文件被占用）被埋进 err.cause 里看不见。
// 这里按错误分型给出可执行的修复命令，并把 cause 链打出来。

const MAX_CAUSE_DEPTH = 3;

/** 按 Error.cause 链取前几层非空 message，去重保序。 */
export function causeChain(err) {
  const out = [];
  let cur = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur; depth += 1) {
    // 跨 realm / 被 clone 过的错误不一定是 Error 实例，但有 message 就用它，
    // 否则 String() 会得到 "[object Object]" 这种毫无信息的东西。
    const msg =
      cur && typeof cur === 'object' && typeof cur.message === 'string'
        ? cur.message
        : String(cur);
    if (msg && out[out.length - 1] !== msg) out.push(msg);
    cur = cur && typeof cur === 'object' ? cur.cause : undefined;
  }
  return out;
}

/**
 * 把启动异常分类成可执行的修复建议。
 * 返回字符串数组，调用方逐行打印；kind 便于测试与后续 doctor 复用。
 */
export function diagnoseStartupFailure(err) {
  const chain = causeChain(err);
  const text = chain.join(' | ');

  if (/cannot find native binding|err_dlopen_failed|dlopen|\b[A-Za-z0-9._-]+\.node\b/i.test(text)) {
    return {
      kind: 'native',
      lines: [
        ...head('a native addon could not be loaded', chain),
        'This is an optional dependency (zstd decompression, used only by the DeepSeek collector).',
        'Fix: npm i -g @jeeinn/omem@latest --force    (reinstalls the matching prebuilt binary)',
        'If it persists, the .node file may be locked by an editor, antivirus, or another running omem process.',
      ],
    };
  }

  if (/cannot find module/i.test(text)) {
    const missingCli = /dist[\\/]cli\.js/i.test(text);
    return {
      kind: 'incomplete',
      lines: [
        ...head('the installed package is incomplete', chain),
        missingCli
          ? 'If you are running from a source checkout, build it first: npm run build'
          : 'Fix: npm i -g @jeeinn/omem@latest',
        missingCli
          ? 'If this is a global install, reinstall it: npm i -g @jeeinn/omem@latest --force'
          : 'Reinstalling replaces the half-written package left by an interrupted install.',
      ],
    };
  }

  if (/EPERM|EACCES|access is denied|permission denied/i.test(text)) {
    return {
      kind: 'permission',
      lines: [
        ...head('a file could not be accessed', chain),
        'Another process may be holding it (editor, antivirus, or a second omem instance).',
        'Fix: close it and retry; for a global install, rebuild with: npm i -g @jeeinn/omem@latest --force',
      ],
    };
  }

  if (/SyntaxError|Unexpected token/i.test(text) || /not supported in your current/i.test(text)) {
    return {
      kind: 'runtime',
      lines: [
        ...head('the runtime rejected the JavaScript', chain),
        'omem requires Node >= 22.5.0. Check with: node -v',
        'Fix: upgrade Node, then reinstall: npm i -g @jeeinn/omem@latest',
      ],
    };
  }

  return {
    kind: 'unknown',
    lines: [
      ...head('startup failed', chain),
      'Fix: npm i -g @jeeinn/omem@latest',
      'If it still fails, paste the lines above into an issue: https://github.com/jeeinn/omem/issues',
    ],
  };
}

/** 首行摘要 + cause 链（若有多层，逐层缩进列出）。 */
function head(summary, chain) {
  const lines = [`omem: startup failed: ${summary}.`];
  if (chain.length === 0) return lines;
  lines.push(`  ${chain[0]}`);
  for (let i = 1; i < chain.length; i += 1) lines.push(`  caused by: ${chain[i]}`);
  return lines;
}