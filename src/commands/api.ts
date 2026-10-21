// omem api status：档 3 生效配置 / 队列深度 / 模型探测（文档 §3.7）。
// 只读诊断命令；探测 /v1/models 不发送任何会话内容。
import { openCtx } from '../core/ctx.js';
import { resolveApiConfig, probeModels } from '../process/api.js';
import { materializeQueue, API_PROMPT_VERSION } from '../process/queue.js';
import type { ParsedArgs } from '../cli-args.js';

export async function cmdApi(args: ParsedArgs): Promise<number> {
  const sub = args._[0];
  if (sub !== 'status') {
    console.log('Usage: omem api status');
    return 0;
  }
  const { home, config, index } = openCtx();
  try {
    const cfg = resolveApiConfig(config, process.env);
    console.log('API tier configuration:');
    console.log(`  base: ${cfg.base} (${cfg.isLocal ? 'loopback' : 'non-local'})`);
    console.log(`  key: ${cfg.key ? 'set' : 'empty'}${cfg.keyWillSend ? ' and will be sent' : ' (Authorization header omitted)'}${cfg.isLocal && cfg.keyWillSend ? ' (loopback endpoint)' : ''}`);
    console.log(`  model: ${cfg.model || '(probe on first run)'}`);
    console.log(`  timeout_ms: ${cfg.timeoutMs}${config.api.timeout_ms === 0 ? ' (per-endpoint default)' : ''}`);
    console.log(`  max_input_chars: ${cfg.maxInputChars}${config.api.max_input_chars === 0 ? ' (per-endpoint default)' : ''}`);
    console.log(`  limit: ${cfg.limit}`);
    for (const w of cfg.warnings) console.log(`  warning: ${w}`);
    for (const n of cfg.notes) console.log(`  note: ${n}`);
    if (config.api.key) {
      // D5 警告：key 在 config.toml 里，会被 omem sync 提交进 git 数据仓
      console.log('  warning: [api].key is stored in config.toml; omem sync will commit it to the git data repo.');
      console.log('    → prefer OMEM_API_KEY in the environment, or add config.toml to .gitignore.');
    }

    const queue = materializeQueue(index, { limit: 0, promptVersion: API_PROMPT_VERSION });
    console.log(`Queue: pending ${queue.pending} · quarantined ${queue.quarantined}`);

    try {
      const ids = await probeModels(cfg);
      console.log(`Models at endpoint: ${ids.join(', ')}`);
      if (ids.length > 1 && !cfg.model) {
        console.log(`  (a run would use ${ids[0]}; set [api].model or --model to override)`);
      }
    } catch (e) {
      console.log(`Models at endpoint: probe failed — ${(e as Error).message}`);
    }
    return 0;
  } finally {
    // Windows：SQLite 句柄不释放会让临时 OMEM_HOME 删不掉（EBUSY）
    index.close();
  }
}
