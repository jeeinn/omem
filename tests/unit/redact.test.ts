// 脱敏测试（吸收 lore redact.py 检测模式——NOTICE 署名）。
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../src/core/redact.js';

describe('redact: 密钥脱敏', () => {
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

  it('PEM 私钥整块脱敏', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----';
    const r = redactSecrets(`配置：\n${pem}`);
    expect(r.text).toContain('PEM***REDACTED***');
    expect(r.text).not.toContain('MIIEabc');
  });

  it('通用口令赋值脱敏但保留键名', () => {
    const r = redactSecrets('password: supersecretvalue123');
    expect(r.text).toContain('password');
    expect(r.text).not.toContain('supersecretvalue123');
  });

  it('无敏感内容时零命中', () => {
    const r = redactSecrets('普通的技术讨论内容，没有任何密钥');
    expect(r.hits).toBe(0);
    expect(r.text).toBe('普通的技术讨论内容，没有任何密钥');
  });
});
