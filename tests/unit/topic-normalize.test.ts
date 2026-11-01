// topic 归一化在 D1-B′ 之后同时是路径安全规则：不许出目录、不许撞 Windows 保留名、不许超长。
// 这一组断言钉住「身份即文件名」的前提——清洗一旦放松，写入就能写出知识库。
import { describe, it, expect } from 'vitest';
import { MAX_TOPIC_CHARS, normalizeTopic } from '../../src/core/entry.js';

describe('normalizeTopic: 身份即文件名', () => {
  it('小写 + 空白折成连字符', () => {
    expect(normalizeTopic('  Knee  Rehab ')).toBe('knee-rehab');
    expect(normalizeTopic('omem D1 Topic')).toBe('omem-d1-topic');
  });

  it('保留中文（个人级默认中文库）', () => {
    expect(normalizeTopic('记忆 置信度')).toBe('记忆-置信度');
  });

  it('路径分隔符与穿越序列被折叠，出不了知识库目录', () => {
    expect(normalizeTopic('../../etc/passwd')).toBe('etc-passwd');
    expect(normalizeTopic('a/b')).toBe('a-b');
    expect(normalizeTopic('a\\b')).toBe('a-b');
    expect(normalizeTopic('C:\\\\tmp')).toBe('c-tmp');
    for (const raw of ['../../x', 'a/b', 'a\\b', '..', '.', '/']) {
      const topic = normalizeTopic(raw);
      if (topic) {
        expect(topic).not.toContain('/');
        expect(topic).not.toContain('\\');
        expect(topic).not.toContain('.');
        expect(topic).not.toContain('..');
      }
    }
  });

  it('Windows 保留名加前缀而不是拒绝写入', () => {
    expect(normalizeTopic('CON')).toBe('topic-con');
    expect(normalizeTopic('com1')).toBe('topic-com1');
    // 只是前缀相同的不动
    expect(normalizeTopic('console')).toBe('console');
    expect(normalizeTopic('com10')).toBe('com10');
  });

  it('长度按 code point 截断，不硬切 surrogate', () => {
    const topic = normalizeTopic('啊'.repeat(100))!;
    expect([...topic].length).toBe(MAX_TOPIC_CHARS);
    expect(topic).toBe('啊'.repeat(MAX_TOPIC_CHARS));
  });

  it('空值或纯符号返回 undefined', () => {
    expect(normalizeTopic('   ')).toBeUndefined();
    expect(normalizeTopic('!!!')).toBeUndefined();
    expect(normalizeTopic('...')).toBeUndefined();
    expect(normalizeTopic('---')).toBeUndefined();
  });

  it('折叠重复连字符并去掉首尾', () => {
    expect(normalizeTopic('--a---b--')).toBe('a-b');
  });
});
