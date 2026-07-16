/**
 * streaming.ts SSE 流式聚合器的测试。
 *
 * 用合成的 SSE chunk 序列验证：content 拼接、tool_calls 增量合并、usage 末块提取。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StreamAggregator, parseSSELine } from '../src/streaming.ts';

test('parseSSELine：解析普通 data 行', () => {
  const r = parseSSELine('data: {"choices":[{"delta":{"content":"hello"}}]}');
  assert.equal(r.done, false);
  assert.ok(r.chunk);
  assert.equal(r.chunk!.content, 'hello');
});

test('parseSSELine：[DONE] 信号', () => {
  const r = parseSSELine('data: [DONE]');
  assert.equal(r.done, true);
});

test('parseSSELine：空行与非 data 行返回 null chunk', () => {
  assert.equal(parseSSELine('').chunk, null);
  assert.equal(parseSSELine(': comment').chunk, null);
});

test('parseSSELine：非法 JSON 行不崩溃，返回 null chunk', () => {
  const r = parseSSELine('data: {broken');
  assert.equal(r.done, false);
  assert.equal(r.chunk, null);
});

test('聚合：content 增量拼接', () => {
  const agg = new StreamAggregator();
  agg.feed({ content: '你' });
  agg.feed({ content: '好' });
  agg.feed({ content: '！' });
  const { message, usage } = agg.take();
  assert.equal(message.content, '你好！');
  assert.equal(message.toolCalls, undefined);
  assert.equal(usage, null);
});

test('聚合：role 记录', () => {
  const agg = new StreamAggregator();
  agg.feed({ role: 'assistant' });
  agg.feed({ content: 'hi' });
  assert.equal(agg.take().message.role, 'assistant');
});

test('聚合：tool_calls 增量——首块带 id/name，后续块拼 arguments', () => {
  const agg = new StreamAggregator();
  agg.feed({
    toolCalls: [{ index: 0, id: 'c1', function: { name: 'calc', arguments: '{"expression":' } }],
  });
  agg.feed({
    toolCalls: [{ index: 0, function: { arguments: ' "1+2"}' } }],
  });
  const { message } = agg.take();
  assert.ok(message.toolCalls);
  assert.equal(message.toolCalls!.length, 1);
  assert.equal(message.toolCalls![0]!.id, 'c1');
  assert.equal(message.toolCalls![0]!.name, 'calc');
  assert.deepEqual(message.toolCalls![0]!.arguments, { expression: '1+2' });
});

test('聚合：多个工具调用按 index 排序', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ index: 1, id: 'c2', function: { name: 'b', arguments: '{}' } }] });
  agg.feed({ toolCalls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } }] });
  const calls = agg.take().message.toolCalls!;
  assert.equal(calls[0]!.name, 'a');
  assert.equal(calls[1]!.name, 'b');
});

test('聚合：usage 在末块提取', () => {
  const agg = new StreamAggregator();
  agg.feed({ content: 'x' });
  agg.feed({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  const { usage } = agg.take();
  assert.ok(usage);
  assert.equal(usage!.promptTokens, 10);
  assert.equal(usage!.completionTokens, 5);
  assert.equal(usage!.totalTokens, 15);
});

test('聚合：混合 content + tool_calls + usage', () => {
  const agg = new StreamAggregator();
  agg.feed({ role: 'assistant', content: '计算中' });
  agg.feed({
    toolCalls: [{ index: 0, id: 'c1', function: { name: 'calc', arguments: '{"expression":"1+1"}' } }],
  });
  agg.feed({ usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } });
  const { message, usage } = agg.take();
  assert.equal(message.content, '计算中');
  assert.ok(message.toolCalls);
  assert.ok(usage);
  assert.equal(usage!.totalTokens, 11);
});
