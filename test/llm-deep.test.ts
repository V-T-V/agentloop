/**
 * llm.ts toUsage 深层路径测试（R10-D7）。
 *
 * 回归：旧条件 `raw.prompt_tokens || raw.completion_tokens` 把合法 0 当 falsy 跳过，
 * 导致服务端明确返回「0 token」（纯工具调用/空响应）被误判为「未返回 usage」走估算兜底，
 * 覆盖了服务端的真实计量。改用 `typeof === 'number'` 判定后，0 被正确保留。
 *
 * toUsage 未导出，通过 HttpLLMClient.chat 注入 mock fetch 间接验证。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { HttpLLMClient } from '../src/llm.ts';
import { resetLlmSemaphore } from '../src/concurrency.ts';

const originalFetch = globalThis.fetch;

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockUsageOnce(usage: unknown, content = 'x'): void {
  globalThis.fetch = (async () =>
    mockResponse(200, {
      choices: [{ message: { role: 'assistant', content } }],
      usage,
    })) as typeof fetch;
}

beforeEach(() => {
  resetLlmSemaphore(10);
  process.env.LOOP_LLM_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LOOP_LLM_API_KEY;
});

test('回归：usage.prompt_tokens=0 不被吞（服务端明确返回 0 token）', async () => {
  // prompt=0, completion=0, total=0 —— 服务端明确告知「这次调用花了 0 token」
  // 旧实现 0||0=falsy → 走估算（content 'x' → 1 token），覆盖了真实计量
  mockUsageOnce({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const client = new HttpLLMClient();
  const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(r.usage!.promptTokens, 0, '合法的 0 必须保留');
  assert.equal(r.usage!.completionTokens, 0);
  assert.equal(r.usage!.totalTokens, 0, '不应被估算兜底覆盖');
});

test('usage：prompt=0 completion=5（缓存命中场景）正确保留 0', async () => {
  mockUsageOnce({ prompt_tokens: 0, completion_tokens: 5, total_tokens: 5 });
  const client = new HttpLLMClient();
  const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(r.usage!.promptTokens, 0, 'prompt=0 保留');
  assert.equal(r.usage!.completionTokens, 5);
  assert.equal(r.usage!.totalTokens, 5);
});

test('usage：prompt=10 completion=0（空生成/纯工具）正确保留 0', async () => {
  mockUsageOnce({ prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 });
  const client = new HttpLLMClient();
  const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(r.usage!.completionTokens, 0, 'completion=0 保留');
  assert.equal(r.usage!.totalTokens, 10);
});

test('usage：total_tokens 缺失时用 prompt+completion 求和', async () => {
  mockUsageOnce({ prompt_tokens: 7, completion_tokens: 3 }); // 无 total_tokens
  const client = new HttpLLMClient();
  const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(r.usage!.promptTokens, 7);
  assert.equal(r.usage!.completionTokens, 3);
  assert.equal(r.usage!.totalTokens, 10, '缺 total 时应 prompt+completion=10');
});

test('usage：完全缺失（无 usage 字段）→ 本地估算兜底（completion > 0）', async () => {
  mockUsageOnce(undefined, '这是一个较长的回复内容用于估算');
  const client = new HttpLLMClient();
  const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(r.usage!.promptTokens, 0, '估算时 prompt=0');
  assert.ok(r.usage!.completionTokens > 0, '估算 completion > 0');
  assert.ok(r.usage!.totalTokens > 0);
});

test('usage：prompt/completion 都缺失但有 total_tokens → 仍走服务端值', async () => {
  // 只有 total_tokens，无 prompt/completion —— typeof number 判定成立，走服务端分支
  mockUsageOnce({ total_tokens: 42 });
  const client = new HttpLLMClient();
  const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(r.usage!.totalTokens, 42);
  assert.equal(r.usage!.promptTokens, 0, '缺 prompt 默认 0');
  assert.equal(r.usage!.completionTokens, 0, '缺 completion 默认 0');
});

test('usage：prompt 为字符串「100」（畸形）→ 走估算兜底', async () => {
  // 非数字字段不触发 hasUsage（typeof !== 'number'），走估算
  mockUsageOnce({ prompt_tokens: '100', completion_tokens: '50' });
  const client = new HttpLLMClient();
  const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  // 字符串字段 → hasUsage=false → 走估算（completion 基于 content 长度）
  assert.ok(r.usage!.totalTokens > 0);
});
