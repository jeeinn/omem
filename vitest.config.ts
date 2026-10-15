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
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
