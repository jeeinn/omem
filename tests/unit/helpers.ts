// 单元测试共享辅助：隔离的临时 OMEM_HOME。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHome } from '../../src/core/paths.js';
import { saveConfig, defaultConfig } from '../../src/core/config.js';
import type { OmemConfig } from '../../src/core/config.js';

export function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omem-test-'));
  ensureHome(dir);
  saveConfig(dir, defaultConfig());
  return dir;
}

export function cleanupHome(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function withConfig(home: string, mutate: (c: OmemConfig) => void): OmemConfig {
  const config = defaultConfig();
  mutate(config);
  saveConfig(home, config);
  return config;
}
