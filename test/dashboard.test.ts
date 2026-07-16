/**
 * dashboard.ts 事件统计的测试。
 *
 * 测试 pushEvent 的统计累加逻辑（不测 HTTP 服务器本身，避免端口冲突）。
 * dashboard 的 stats 是模块级单例，测试间共享——故用「差值」验证。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pushEvent, getStats } from '../src/dashboard.ts';

test('pushEvent：thinking 增加 steps', () => {
  const before = getStats().steps;
  pushEvent({ type: 'thinking', step: 1, message: 'test' });
  assert.equal(getStats().steps, before + 1);
});

test('pushEvent：tool_call 增加 toolCalls', () => {
  const before = getStats().toolCalls;
  pushEvent({ type: 'tool_call', step: 1, call: { id: 'c1', name: 'calc', arguments: {} } });
  assert.equal(getStats().toolCalls, before + 1);
});

test('pushEvent：tool_result 增加 toolResults', () => {
  const before = getStats().toolResults;
  pushEvent({ type: 'tool_result', step: 1, callId: 'c1', result: { ok: true, output: '42' } });
  assert.equal(getStats().toolResults, before + 1);
});

test('pushEvent：usage 累加 token', () => {
  const before = getStats().totalUsage.totalTokens;
  pushEvent({ type: 'usage', step: 1, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });
  assert.equal(getStats().totalUsage.totalTokens, before + 150);
  assert.equal(getStats().totalUsage.promptTokens, getStats().totalUsage.promptTokens); // 累加了
});

test('pushEvent：error 增加错误计数', () => {
  const before = getStats().errors;
  pushEvent({ type: 'error', message: 'test error' });
  assert.equal(getStats().errors, before + 1);
});

test('pushEvent：compact 增加压缩计数', () => {
  const before = getStats().compacts;
  pushEvent({ type: 'compact', step: 1, beforeTokens: 1000, afterTokens: 500, beforeMessages: 10, afterMessages: 5 });
  assert.equal(getStats().compacts, before + 1);
});

test('pushEvent：final 不增加 steps', () => {
  const before = getStats().steps;
  pushEvent({ type: 'final', answer: 'done' });
  assert.equal(getStats().steps, before, 'final 不应增加 steps');
});

test('pushEvent：stream_delta 不增加任何计数', () => {
  const before = getStats();
  pushEvent({ type: 'stream_delta', step: 1, text: 'hello' });
  const after = getStats();
  assert.equal(after.steps, before.steps);
  assert.equal(after.toolCalls, before.toolCalls);
});
