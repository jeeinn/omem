// 主题级审阅策略（review.toml）：让「这个主题我已经信得过」不必每次更新都回到队列。
//
// 为什么单独一个文件而不是塞进 config.toml：config.toml 有文本级段合并的写入纪律，
// 而 topic 是动态增长的高频写入，塞进去迟早会破坏用户手写的注释和未知键。
// 这里 omem 独占整个文件，格式是最小 TOML 子集：
//
//   [topics]
//   "fm-cmp-costlog-perf-fix" = "once"
//   "matea-architecture" = "always"
//
// 读取容忍手写内容：注释、空行、裸键（不带引号）都能识别。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './util.js';

export type TopicPolicy = 'always' | 'once' | 'never';

export const TOPIC_POLICIES: TopicPolicy[] = ['always', 'once', 'never'];

const SECTION = '[topics]';

export function policyPath(home: string): string {
  return join(home, 'review.toml');
}

/** 读 policy。文件不存在或格式不对时返回空表（等价于全部 always）。 */
export function loadTopicPolicies(home: string): Map<string, TopicPolicy> {
  const out = new Map<string, TopicPolicy>();
  const path = policyPath(home);
  if (!existsSync(path)) return out;

  let inTopics = false;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inTopics = line === SECTION;
      continue;
    }
    if (!inTopics) continue;
    const m = line.match(/^(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*"([^"]*)"\s*$/);
    if (!m) continue;
    const topic = (m[1] ?? m[2] ?? '').trim();
    const policy = (m[3] ?? '').trim() as TopicPolicy;
    if (!topic || !TOPIC_POLICIES.includes(policy)) continue;
    out.set(topic, policy);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 写入一条 policy。`null` 表示删除该条（回到默认 always）。
 *
 * 文本级编辑：只增删 `[topics]` 段里对应那一行，其余内容（注释、别的段、用户手写
 * 的裸键）原样保留。
 */
export function saveTopicPolicy(home: string, topic: string, policy: TopicPolicy | null): void {
  const path = policyPath(home);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing.length > 0 ? existing.replace(/\r\n/g, '\n').split('\n') : [];
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const keyRe = new RegExp(`^\\s*(?:"${escapeRe(topic)}"|${escapeRe(topic)})\\s*=`);
  const sectionIdx = lines.findIndex((l) => l.trim() === SECTION);
  const row = `"${topic}" = "${policy}"`;

  if (sectionIdx === -1) {
    if (policy === null) return;
    lines.push('', SECTION, row, '');
  } else {
    let end = lines.length;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('[')) {
        end = i;
        break;
      }
    }
    let found = -1;
    for (let i = sectionIdx + 1; i < end; i++) {
      if (keyRe.test(lines[i])) {
        found = i;
        break;
      }
    }
    if (policy === null) {
      if (found >= 0) lines.splice(found, 1);
    } else if (found >= 0) {
      lines[found] = row;
    } else {
      lines.splice(end, 0, row);
    }
  }

  atomicWrite(path, `${lines.join('\n')}\n`);
}
