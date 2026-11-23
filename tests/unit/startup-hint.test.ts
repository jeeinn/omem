// 启动失败诊断：分型必须给出可执行命令，并且看得见 cause 链。
//
// 回到真实事故：全局安装的 omem 因原生绑定缺失起不来，用户看到的却是
// "run `npm run build` first"——他的机器上没有源码。这里钉住四类分型。
import { describe, it, expect } from 'vitest';
import { diagnoseStartupFailure, causeChain } from '../../bin/startup-hint.js';

function withCause(message, cause) {
  const err = new Error(message);
  err.cause = cause;
  return err;
}

describe('startup failure diagnosis', () => {
  it('native binding failure suggests a forced reinstall, never npm run build', () => {
    const { kind, lines } = diagnoseStartupFailure(
      new Error('Cannot find native binding. npm has a bug related to optional dependencies.'),
    );
    const text = lines.join('\n');
    expect(kind).toBe('native');
    expect(text).toContain('npm i -g @jeeinn/omem@latest --force');
    expect(text).not.toContain('npm run build');
    expect(text).toContain('DeepSeek collector');
  });

  it('ERR_DLOPEN_FAILED with a .node path is treated as native', () => {
    const { kind } = diagnoseStartupFailure(
      withCause('ERR_DLOPEN_FAILED', new Error("Cannot find module './node-zstd.win32-x64-msvc.node'")),
    );
    expect(kind).toBe('native');
  });

  it('a missing dist/cli.js offers both the source and the global path', () => {
    const { kind, lines } = diagnoseStartupFailure(new Error("Cannot find module 'X:/pkg/dist/cli.js'"));
    const text = lines.join('\n');
    expect(kind).toBe('incomplete');
    expect(text).toContain('npm run build');
    expect(text).toContain('npm i -g @jeeinn/omem@latest --force');
  });

  it('a missing dependency without dist/cli.js does not tell source users to build', () => {
    const { kind, lines } = diagnoseStartupFailure(
      new Error("Cannot find module '@modelcontextprotocol/sdk'"),
    );
    expect(kind).toBe('incomplete');
    expect(lines.join('\n')).not.toContain('npm run build');
  });

  it('EPERM / Access is denied points at a lock, not a rebuild', () => {
    const { kind, lines } = diagnoseStartupFailure(
      withCause('Access is denied.', new Error('EPERM: operation not permitted, unlink')),
    );
    expect(kind).toBe('permission');
    expect(lines.join('\n')).toMatch(/holding it|rebuild/i);
  });

  it('unknown errors still show the cause chain and an issue link', () => {
    const err = withCause('boom', new Error('inner detail'));
    const { kind, lines } = diagnoseStartupFailure(err);
    const text = lines.join('\n');
    expect(kind).toBe('unknown');
    expect(text).toContain('boom');
    expect(text).toContain('caused by: inner detail');
    expect(text).toContain('github.com/jeeinn/omem/issues');
  });

  it('causeChain is bounded, de-duplicated, and tolerates non-Error causes', () => {
    const deep = withCause('a', withCause('b', withCause('c', withCause('d', new Error('e')))));
    expect(causeChain(deep)).toEqual(['a', 'b', 'c']);
    expect(causeChain(withCause('same', new Error('same')))).toEqual(['same']);
    expect(causeChain({ message: 'plain' })).toEqual(['plain']);
  });
});