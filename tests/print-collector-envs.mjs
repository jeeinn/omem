// 从构建产物读取采集器注册表里的隔离环境变量名，供 tests/smoke.sh 使用。
//
// 为什么要这个脚本：每加一个采集器都要给冒烟脚本补一行 export，否则端到端冒烟会扫到
// 开发者本机的真实会话目录（2026-10-26 实测：catpaw 采集器漏配，冒烟把 ~/.catpaw 的真实
// 对话写进了测试产物）。手写清单必然会漏，所以清单从注册表派生——新增采集器自动纳入隔离。
//
// 用法：node tests/print-collector-envs.mjs → 每行一个 OMEM_*_PROJECTS
import { allCollectorEnvKeys } from '../dist/collect/registry.js';

const keys = allCollectorEnvKeys();
if (keys.length === 0) {
  console.error('print-collector-envs: registry returned no env keys (is dist/ built?)');
  process.exit(1);
}
process.stdout.write(keys.join('\n') + '\n');
