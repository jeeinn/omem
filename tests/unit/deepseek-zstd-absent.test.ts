// 事故现场回归：两个 zstd 解压源都不可用时，deepseek 模块必须仍能 import。
//
// 原实现顶层 `new Decoder()`，原生绑定缺失时 import 期就抛，`omem --version`
// 与另外八个采集器一起挂掉。这里把 node:zlib 的 zstd 入口和 createRequire
// 都打空，断言：模块可加载、自检给出原因、解析返回 null 而非抛错。
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:zlib', () => ({
  // 刻意不提供 zstdDecompressSync：模拟 Node < 22.15。
}));

vi.mock('node:module', () => ({
  createRequire: () => () => {
    throw new Error('Cannot find native binding');
  },
}));

const mod = await import('../../src/collect/deepseek.js');

describe('deepseek collector with no zstd source at all', () => {
  it('module loads without throwing', () => {
    expect(typeof mod.parseDeepSeekFile).toBe('function');
    expect(typeof mod.deepseekZstdError).toBe('function');
  });

  it('self-check reports why, instead of failing at import', () => {
    expect(mod.deepseekZstdError()).toContain('Cannot find native binding');
  });

  it('parse returns null for an existing file rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omem-ds-nozstd-'));
    try {
      const p = join(dir, 'session.jsonl.zstd');
      writeFileSync(p, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
      expect(mod.parseDeepSeekFile(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});