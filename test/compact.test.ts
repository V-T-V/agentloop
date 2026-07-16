/**
 * compact.ts 自动压缩的测试。
 *
 * 用假 LLM 验证：双重阈值判定、压缩后 system 保留、recent window 保留、
 * token/消息数下降、历史太短时不触发。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Memory } from '../src/memory.ts';
import { compactMemory, shouldCompact, currentTokens, loadCompactConfig, type CompactConfig } from '../src/compact.ts';
import type { ChatResult, LLMClient, Message } from '../src/types.ts';

/** 返回固定摘要的假 LLM */
function fakeSummaryLLM(summary: string): LLMClient {
  return {
    isStub: true,
    supportsStream: false,
    async chat(): Promise<ChatResult> {
      const message: Message = { role: 'assistant', content: summary };
      return { message, usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 } };
    },
    async chatStream(): Promise<ChatResult> {
      const message: Message = { role: 'assistant', content: summary };
      return { message, usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 } };
    },
  };
}

const cfg = (over: Partial<CompactConfig> = {}): CompactConfig => ({
  tokenBudget: 1000,
  threshold: 0.85,
  maxMessages: 10,
  recentWindow: 3,
  ...over,
});

/** 造一个有 N 条用户消息的记忆 */
function filledMemory(n: number, content = '这是一段较长的对话内容用于测试压缩'): Memory {
  const m = new Memory('系统提示');
  for (let i = 0; i < n; i++) m.add({ role: 'user', content: `${content}-${i}` });
  return m;
}

test('shouldCompact：消息条数超阈值 → true', () => {
  const m = filledMemory(12);
  assert.equal(shouldCompact(m, cfg({ maxMessages: 10 })), true);
});

test('shouldCompact：消息条数未超且 token 未超 → false', () => {
  const m = filledMemory(5);
  assert.equal(shouldCompact(m, cfg({ maxMessages: 50, tokenBudget: 100000 })), false);
});

test('shouldCompact：token 超阈值 → true（条数未超也触发）', () => {
  const m = filledMemory(10, 'x'.repeat(200)); // 每条约 50 token
  // tokenBudget 设很低，强制 token 触发
  assert.equal(shouldCompact(m, cfg({ maxMessages: 1000, tokenBudget: 200 })), true);
});

test('shouldCompact：历史太短（不足 system+摘要目标+recent）→ false', () => {
  const m = new Memory('sys');
  m.add({ role: 'user', content: 'hi' });
  // recentWindow=3，minMessages=2+3+1=6，当前只有 2 条
  assert.equal(shouldCompact(m, cfg({ maxMessages: 1, tokenBudget: 1 })), false);
});

test('compactMemory：执行压缩，token 与消息数下降，system 保留', async () => {
  const m = filledMemory(12, '很长的测试内容用于触发压缩并验证摘要生效');
  const before = m.length;
  const result = await compactMemory(m, fakeSummaryLLM('这是压缩后的摘要'), cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(result.performed, true);
  assert.ok(result.afterMessages < before);
  assert.ok(result.afterTokens <= result.beforeTokens);
  // 压缩后首条仍是 system
  assert.equal(m.snapshot()[0]!.role, 'system');
  // 摘要被写入
  assert.ok(m.snapshot().some((msg) => typeof msg.content === 'string' && msg.content.includes('压缩后的摘要')));
});

test('compactMemory：recent window 被完整保留在末尾', async () => {
  const m = filledMemory(12);
  // 标记最后 2 条为可识别内容
  m.clear('sys');
  for (let i = 0; i < 12; i++) m.add({ role: 'user', content: `msg-${i}` });
  await compactMemory(m, fakeSummaryLLM('摘要'), cfg({ maxMessages: 5, recentWindow: 2 }));
  const snap = m.snapshot();
  // 末尾两条应是 msg-10、msg-11（recent window 原样保留）
  const lastTwo = snap.slice(-2);
  assert.ok(typeof lastTwo[1]!.content === 'string' && lastTwo[1]!.content.includes('msg-11'));
  assert.ok(typeof lastTwo[0]!.content === 'string' && lastTwo[0]!.content.includes('msg-10'));
});

test('compactMemory：未达阈值时不执行（performed:false，记忆不变）', async () => {
  const m = filledMemory(3);
  const before = m.snapshot();
  const result = await compactMemory(m, fakeSummaryLLM('摘要'), cfg({ maxMessages: 100, tokenBudget: 100000 }));
  assert.equal(result.performed, false);
  // 记忆原样不变
  assert.deepEqual(m.snapshot(), before);
});

test('loadCompactConfig：从环境变量读取（带默认）', () => {
  const c = loadCompactConfig();
  assert.ok(c.tokenBudget > 0);
  assert.ok(c.threshold > 0 && c.threshold <= 1);
  assert.ok(c.recentWindow >= 0);
});

test('currentTokens：返回正数', () => {
  const m = filledMemory(5);
  assert.ok(currentTokens(m) > 0);
});
