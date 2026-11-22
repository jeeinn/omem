import { defineConfig } from 'vitest/config';

// B 阶段去掉了 node:sqlite：不再需要 --experimental-sqlite，也不再依赖 FTS5。
// 保留 forks 池（进程隔离对文件系统测试更稳），但不再注入实验 flag。
export default defineConfig({
  test: {
    pool: 'forks',
    // 2026-11-22 实测（发版门禁 flaky 排查）：
    // 并行跑 86 个文件时，偶发 `[vitest-worker]: Timeout calling "onTaskUpdate"`
    // —— birpc 默认 60s 超时，多 fork worker 同时向主进程上报任务状态时互锁。
    // 843 个用例其实全绿，但 vitest 记成 unhandled error 并让 `npm test` 退出 1，
    // 导致 `prepublishOnly` 的 `build && test && release-check` 整链中断。
    // 试过并**证伪**的两条路：
    //   - `maxForks: 3` 降并发：仍报 1 error，且全量从 ~68s 拖到 ~190s；
    //   - `reporters: ['dot']` 减少 stdout 写入：仍报 1 error。
    // 单 worker 全串行（`--no-file-parallelism`）连续验证 exit=0 / 843 passed / 0 error。
    // 结论是 RPC 互锁而非拥塞或 reporter 阻塞，故固化关闭文件级并行。
    // 代价：全量墙钟约 195s（并行时 ~68s）。发布门禁要的是确定性，不是速度。
    // 本地快速迭代可用 `npx vitest run tests/unit/<file>.test.ts` 单文件跑，不受此限。
    fileParallelism: false,
    // tests/eval/ 是数据与离线脚本目录（golden-search.json + scripts/eval-search.mjs），
    // 不是 vitest 的测试发现范围；golden-dataset.test.ts 在 unit 里读同一份数据做回归。
    include: ['tests/unit/**/*.test.ts'],
    // 20s 在并行满载时不够：auto-commit / review-server 会真的起 git 与本地 HTTP，
    // 两个文件同时跑时会被挤到超时，表现为「单独跑绿、全量跑红」的噪声。
    testTimeout: 40000,
    hookTimeout: 40000,
  },
});
