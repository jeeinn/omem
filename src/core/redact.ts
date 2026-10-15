// 脱敏正则（吸收 lore redact.py 的检测模式——MIT，见 NOTICE）。
// 采集/入库前必须过一遍：OpenAI/Anthropic key、GitHub token、AWS AKID、JWT、PEM 私钥、通用口令赋值。
const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9\-_]{20,}/g, 'sk-ant-***REDACTED***'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-***REDACTED***'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, 'gh*_***REDACTED***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***REDACTED***'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt***REDACTED***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'PEM***REDACTED***'],
  [/(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"']{6,}/gi, '$& → ***REDACTED***'],
];

export interface RedactResult {
  text: string;
  hits: number;
}

export function redactSecrets(text: string): RedactResult {
  let out = text;
  let hits = 0;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, (m) => {
      hits++;
      // 通用口令规则保留键名，只脱敏值
      return replacement === '$& → ***REDACTED***' ? m.replace(/[:=]\s*["']?[^\s"']{6,}$/, ' → ***REDACTED***') : replacement;
    });
  }
  return { text: out, hits };
}
