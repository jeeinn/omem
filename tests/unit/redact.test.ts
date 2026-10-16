// 脱敏测试（吸收 lore redact.py 检测模式——NOTICE 署名）。
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../src/core/redact.js';

describe('redact: secret redaction', () => {
  it('OpenAI/Anthropic key', () => {
    const r = redactSecrets('key 是 sk-ant-abc123def456ghi789jkl012mno345');
    expect(r.hits).toBeGreaterThan(0);
    expect(r.text).not.toContain('abc123def456');
    expect(r.text).toContain('REDACTED');
  });

  it('GitHub token / AWS AKID / JWT', () => {
    expect(redactSecrets('ghp_' + 'a'.repeat(40)).text).toContain('REDACTED');
    expect(redactSecrets('AKIAABCDEFGHIJKLMNOP').text).toContain('REDACTED');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    expect(redactSecrets(`token ${jwt}`).text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('PEM private key redacted as a whole block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----';
    const r = redactSecrets(`配置：\n${pem}`);
    expect(r.text).toContain('PEM***REDACTED***');
    expect(r.text).not.toContain('MIIEabc');
  });

  it('generic password assignment redacted but key name kept', () => {
    const r = redactSecrets('password: supersecretvalue123');
    expect(r.text).toContain('password');
    expect(r.text).not.toContain('supersecretvalue123');
  });

  it('zero hits when there is no sensitive content', () => {
    const r = redactSecrets('普通的技术讨论内容，没有任何密钥');
    expect(r.hits).toBe(0);
    expect(r.text).toBe('普通的技术讨论内容，没有任何密钥');
  });
});
