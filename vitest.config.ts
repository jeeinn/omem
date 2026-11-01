import { defineConfig } from 'vitest/config';

// node:sqlite 在 Node 22 需要 --experimental-sqlite；
// forks 池 + execArgv 显式注入，保证测试工作进程内 FTS5 可用。
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: { execArgv: ['--experimental-sqlite'] },
    },
    include: ['tests/unit/**/*.test.ts'],
    // 20s 在并行满载时不够：auto-commit / review-server 会真的起 git 与本地 HTTP，
    // 两个文件同时跑时会被挤到超时，表现为「单独跑绿、全量跑红」的噪声。
    testTimeout: 40000,
    hookTimeout: 40000,
  },
});
