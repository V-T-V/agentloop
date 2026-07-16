/**
 * tokens.ts 估算器的测试。
 *
 * 重点验证：单调性（更长文本估算更大）、边界（空串）、中英文差异方向正确。
 * 不断言精确数值——估算本质是近似，断言精确值会让测试脆弱。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens,
  estimateMessageTokens,
  estimateMemoryTokens,
} from '../src/tokens.ts';
import type { Message } from '../src/types.ts';

test('estimateTokens：空串为 0', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens：单调性——更长文本估算更大', () => {
  const short = 'hello';
  const long = 'hello world this is a much longer sentence';
  assert.ok(estimateTokens(short) < estimateTokens(long));
});

test('estimateTokens：中文比同长度英文费更多 token', () => {
  // 同样字符数，中文应比纯英文估算出更多 token
  const en = 'aaaaaaaa'; // 8 ASCII
  const zh = '你好你好你好你好'; // 8 中文
  assert.ok(estimateTokens(zh) > estimateTokens(en));
});

test('estimateTokens：英文按 ~4 字符/token', () => {
  // 8 个 ASCII 字符 ≈ 2 token
  assert.equal(estimateTokens('abcdefgh'), 2);
});

test('estimateMessageTokens：含 content 的开销', () => {
  const m: Message = { role: 'user', content: 'abcdefgh' }; // 4 开销 + 2 内容
  assert.ok(estimateMessageTokens(m) >= 6);
});

test('estimateMessageTokens：toolCalls 也计入', () => {
  const withCalls: Message = {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'c1', name: 'calc', arguments: { x: 1 } }],
  };
  const withoutCalls: Message = { role: 'assistant', content: null };
  assert.ok(estimateMessageTokens(withCalls) > estimateMessageTokens(withoutCalls));
});

test('estimateMemoryTokens：累加多条', () => {
  const messages: Message[] = [
    { role: 'system', content: 'abcdefgh' },
    { role: 'user', content: 'ijklmnop' },
  ];
  assert.ok(estimateMemoryTokens(messages) > estimateMessageTokens(messages[0]!));
});

test('estimateMemoryTokens：空数组为 0', () => {
  assert.equal(estimateMemoryTokens([]), 0);
});
