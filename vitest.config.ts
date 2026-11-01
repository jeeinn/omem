import { defineConfig } from 'vitest/config';

// B 阶段去掉了 node:sqlite：不再需要 --experimental-sqlite，也不再依赖 FTS5。
// 保留 forks 池（进程隔离对文件系统测试更稳），但不再注入实验 flag。
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {

    },
    include: ['tests/unit/**/*.test.ts'],
    // 20s 在并行满载时不够：auto-commit / review-server 会真的起 git 与本地 HTTP，
    // 两个文件同时跑时会被挤到超时，表现为「单独跑绿、全量跑红」的噪声。
    testTimeout: 40000,
    hookTimeout: 40000,
  },
});
