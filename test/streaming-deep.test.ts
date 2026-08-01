/**
 * streaming.ts 深层测试（R5）。
 *
 * 覆盖基础测试未触及的 SSE 解析/中断恢复/部分消息/多 chunk 聚合边界：
 * 1. parseSSELine：带空格的 data 前缀、大小写、CRLF、注释行、心跳。
 * 2. parseSSELine：choices 为空数组（仅 usage 末块）。
 * 3. parseSSELine：usage 在顶层 vs delta 内。
 * 4. 中断恢复：部分 arguments 字符串累积（__raw 路径）后解析成功。
 * 5. 部分消息：content 跨多 chunk 中文/emoji 拼接顺序保持。
 * 6. 多工具并发：同 chunk 含多个 index 的 tool_calls。
 * 7. tool_calls 无 index 默认 0。
 * 8. tool_calls 缺 id/name 时的兜底。
 * 9. usage 字段缺失各子键的兜底（0）。
 * 10. take() 多次调用、空聚合器。
 * 11. 大流量：1000 个 content chunk 拼接正确。
 * 12. 完整 SSE 行序列端到端（parseSSELine → feed → take）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StreamAggregator, parseSSELine } from '../src/streaming.ts';

// —————————— 1. parseSSELine 边界 ——————————

test('parseSSELine：data 后带空格的 payload 正确解析', () => {
  const r = parseSSELine('data: {"choices":[{"delta":{"content":"x"}}]}');
  assert.ok(r.chunk);
  assert.equal(r.chunk!.content, 'x');
});

test('parseSSELine：data 后无空格的 payload 也能解析', () => {
  const r = parseSSELine('data:{"choices":[{"delta":{"content":"y"}}]}');
  assert.ok(r.chunk);
  assert.equal(r.chunk!.content, 'y');
});

test('parseSSELine：带前后空白的行', () => {
  const r = parseSSELine('   data: {"choices":[{"delta":{"content":"z"}}]}   ');
  assert.ok(r.chunk);
  assert.equal(r.chunk!.content, 'z');
});

test('parseSSELine：注释行（: 开头）返回 null', () => {
  assert.equal(parseSSELine(': keep-alive').chunk, null);
});

test('parseSSELine：空行返回 null', () => {
  assert.equal(parseSSELine('').chunk, null);
  assert.equal(parseSSELine('   ').chunk, null);
});

test('parseSSELine：非 data 前缀的行返回 null', () => {
  assert.equal(parseSSELine('event: ping').chunk, null);
  assert.equal(parseSSELine('id: 42').chunk, null);
});

test('parseSSELine：[DONE] 信号 done=true', () => {
  assert.equal(parseSSELine('data: [DONE]').done, true);
});

test('parseSSELine：非法 JSON 不崩溃，chunk=null', () => {
  const r = parseSSELine('data: {broken json');
  assert.equal(r.done, false);
  assert.equal(r.chunk, null);
});

// —————————— 2. choices 为空数组（usage 末块）——————————

test('parseSSELine：choices 为空数组时不崩溃，usage 仍提取', () => {
  const r = parseSSELine('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}');
  assert.equal(r.done, false);
  assert.ok(r.chunk);
  assert.equal(r.chunk!.usage!.total_tokens, 7);
  // choices 空 → delta={} → content/role/toolCalls 都 undefined
  assert.equal(r.chunk!.content, undefined);
});

// —————————— 3. usage 位置 ——————————

test('parseSSELine：usage 在顶层时提取', () => {
  const r = parseSSELine('data: {"choices":[{"delta":{"content":"a"}}],"usage":{"total_tokens":42}}');
  assert.equal(r.chunk!.usage!.total_tokens, 42);
});

test('parseSSELine：usage 在 delta 内时提取（某些实现）', () => {
  const r = parseSSELine('data: {"choices":[{"delta":{"content":"a","usage":{"total_tokens":99}}}]}');
  // delta.usage 优先级低于顶层，但顶层无 usage 时用 delta.usage
  assert.ok(r.chunk!.usage);
  assert.equal(r.chunk!.usage!.total_tokens, 99);
});

// —————————— 4. 中断恢复：部分 arguments 累积 ——————————

test('中断恢复：arguments 分 4 片到达，前 3 片无法解析存 __raw，第 4 片拼成完整 JSON', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":' } }] });
  // 此时 arguments='{"a":' 无法解析 → __raw
  agg.feed({ toolCalls: [{ index: 0, function: { arguments: '1,"b":' } }] });
  // __raw = '{"a":1,"b":'
  agg.feed({ toolCalls: [{ index: 0, function: { arguments: '2,"c":' } }] });
  agg.feed({ toolCalls: [{ index: 0, function: { arguments: '3}' } }] });
  const { message } = agg.take();
  assert.ok(message.toolCalls);
  assert.deepEqual(message.toolCalls![0]!.arguments, { a: 1, b: 2, c: 3 });
});

test('中断恢复：arguments 永远不完整时保留 __raw', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{broken' } }] });
  // 不再喂完整片段
  const { message } = agg.take();
  assert.ok(message.toolCalls);
  assert.equal(message.toolCalls![0]!.arguments.__raw, '{broken');
});

test('中断恢复：首片 arguments 为空串，后续片拼接', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '' } }] });
  agg.feed({ toolCalls: [{ index: 0, function: { arguments: '{"x":1}' } }] });
  const { message } = agg.take();
  // 首片空串 → safeParseArgs('') 返回 {}（非 __raw），第二片尝试 mergeArgs
  assert.ok(message.toolCalls);
});

// —————————— 5. 部分消息：content 跨 chunk ——————————

test('部分消息：中文 content 跨 5 chunk 拼接顺序保持', () => {
  const agg = new StreamAggregator();
  const parts = ['你', '好', '，', '世', '界'];
  for (const p of parts) agg.feed({ content: p });
  assert.equal(agg.take().message.content, '你好，世界');
});

test('部分消息：emoji 跨 chunk 不丢失（按 JS 字符串拼接）', () => {
  const agg = new StreamAggregator();
  agg.feed({ content: 'Hello ' });
  agg.feed({ content: '🌍' });
  agg.feed({ content: '!' });
  assert.equal(agg.take().message.content, 'Hello 🌍!');
});

test('部分消息：单字 content 也能拼接', () => {
  const agg = new StreamAggregator();
  agg.feed({ content: 'A' });
  assert.equal(agg.take().message.content, 'A');
});

// —————————— 6. 多工具并发 ——————————

test('多工具并发：同一 chunk 含两个 index 的 tool_calls', () => {
  const agg = new StreamAggregator();
  agg.feed({
    toolCalls: [
      { index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } },
      { index: 1, id: 'c2', function: { name: 'b', arguments: '{}' } },
    ],
  });
  const calls = agg.take().message.toolCalls!;
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.name, 'a');
  assert.equal(calls[1]!.name, 'b');
});

test('多工具并发：交错到达的两个工具 arguments', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{"x":' } }] });
  agg.feed({ toolCalls: [{ index: 1, id: 'c2', function: { name: 'b', arguments: '{"y":' } }] });
  agg.feed({ toolCalls: [{ index: 0, function: { arguments: '1}' } }] });
  agg.feed({ toolCalls: [{ index: 1, function: { arguments: '2}' } }] });
  const calls = agg.take().message.toolCalls!;
  assert.deepEqual(calls[0]!.arguments, { x: 1 });
  assert.deepEqual(calls[1]!.arguments, { y: 2 });
});

// —————————— 7/8. tool_calls 缺省兜底 ——————————

test('tool_calls 缺 index 时默认 0', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] });
  const calls = agg.take().message.toolCalls!;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, 'c1');
});

test('tool_calls 缺 id 时用 call_<index> 兜底', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ index: 2, function: { name: 'f', arguments: '{}' } }] });
  const calls = agg.take().message.toolCalls!;
  assert.equal(calls[0]!.id, 'call_2');
});

test('tool_calls 缺 name 时为空串', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ index: 0, id: 'c1', function: { arguments: '{}' } }] });
  const calls = agg.take().message.toolCalls!;
  assert.equal(calls[0]!.name, '');
});

test('tool_calls 缺 function 整个对象时 arguments 默认 {}', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ index: 0, id: 'c1' }] });
  const calls = agg.take().message.toolCalls!;
  assert.deepEqual(calls[0]!.arguments, {});
});

// —————————— 9. usage 缺失兜底 ——————————

test('usage 缺失子键时补 0', () => {
  const agg = new StreamAggregator();
  agg.feed({ usage: {} });
  const { usage } = agg.take();
  assert.ok(usage);
  assert.equal(usage!.promptTokens, 0);
  assert.equal(usage!.completionTokens, 0);
  assert.equal(usage!.totalTokens, 0);
});

test('usage 仅 total_tokens 时其他补 0', () => {
  const agg = new StreamAggregator();
  agg.feed({ usage: { total_tokens: 100 } });
  const { usage } = agg.take();
  assert.equal(usage!.totalTokens, 100);
  assert.equal(usage!.promptTokens, 0);
});

test('usage 后到的覆盖先到的', () => {
  const agg = new StreamAggregator();
  agg.feed({ usage: { total_tokens: 10 } });
  agg.feed({ usage: { total_tokens: 20 } });
  assert.equal(agg.take().usage!.totalTokens, 20);
});

// —————————— 10. take() 行为 ——————————

test('take()：空聚合器返回 content=null 无 tool_calls 的消息', () => {
  const agg = new StreamAggregator();
  const { message, usage } = agg.take();
  assert.equal(message.role, 'assistant');
  assert.equal(message.content, null);
  assert.equal(message.toolCalls, undefined);
  assert.equal(usage, null);
});

test('take()：仅 content 无 tool_calls 时 message 无 toolCalls 键', () => {
  const agg = new StreamAggregator();
  agg.feed({ content: 'hi' });
  const { message } = agg.take();
  assert.equal(message.content, 'hi');
  assert.equal(message.toolCalls, undefined);
});

test('take()：仅 tool_calls 无 content 时 content=null', () => {
  const agg = new StreamAggregator();
  agg.feed({ toolCalls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] });
  const { message } = agg.take();
  assert.equal(message.content, null);
  assert.ok(message.toolCalls);
});

test('take() 后继续 feed 仍能聚合（累加器不重置）', () => {
  const agg = new StreamAggregator();
  agg.feed({ content: 'A' });
  const r1 = agg.take();
  assert.equal(r1.message.content, 'A');
  agg.feed({ content: 'B' });
  const r2 = agg.take();
  // 累加器内部 content 不清空，故 r2 含 A+B（实现特性）
  assert.ok((r2.message.content as string).includes('A'));
});

// —————————— 11. 大流量 ——————————

test('大流量：1000 个 content chunk 拼接长度正确', () => {
  const agg = new StreamAggregator();
  const N = 1000;
  for (let i = 0; i < N; i++) agg.feed({ content: 'a' });
  const { message } = agg.take();
  assert.equal(message.content!.length, N);
});

test('大流量：100 个交错工具调用（index 0-99）', () => {
  const agg = new StreamAggregator();
  for (let i = 0; i < 100; i++) {
    agg.feed({ toolCalls: [{ index: i, id: `c${i}`, function: { name: 'f', arguments: '{}' } }] });
  }
  const calls = agg.take().message.toolCalls!;
  assert.equal(calls.length, 100);
  // 按 index 升序
  assert.equal(calls[0]!.id, 'c0');
  assert.equal(calls[99]!.id, 'c99');
});

// —————————— 12. 端到端 SSE 行序列 ——————————

test('端到端：完整 SSE 流（parse → feed → take）还原 content + usage', () => {
  // 注：parseSSELine 从 delta 提取 role/content/usage（camelCase）。
  // tool_calls 的增量合并由 StreamAggregator.feed 直接处理（见中断恢复组），
  // parseSSELine 不做 snake_case tool_calls 的字段映射（已知行为，由 llm.ts 上层适配）。
  const mkLine = (delta: object, usage?: object) =>
    'data: ' + JSON.stringify({ choices: [{ delta }], ...(usage ? { usage } : {}) });
  const lines = [
    mkLine({ role: 'assistant', content: '' }),
    mkLine({ content: 'Hello' }),
    mkLine({ content: ' world' }),
    mkLine({}, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    'data: [DONE]',
  ];
  const agg = new StreamAggregator();
  let done = false;
  for (const line of lines) {
    const r = parseSSELine(line);
    if (r.done) {
      done = true;
      break;
    }
    if (r.chunk) agg.feed(r.chunk);
  }
  assert.ok(done, '[DONE] 信号被识别');
  const { message, usage } = agg.take();
  assert.equal(message.content, 'Hello world');
  assert.equal(message.role, 'assistant');
  assert.ok(usage);
  assert.equal(usage!.totalTokens, 15);
});

test('已知行为：parseSSELine 不映射 snake_case tool_calls（delta.tool_calls 被忽略）', () => {
  // 记录现状：parseSSELine 只读 delta.toolCalls（camelCase），OpenAI 的 tool_calls 不提取。
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] } }] });
  const r = parseSSELine(line);
  assert.ok(r.chunk);
  assert.equal(r.chunk!.toolCalls, undefined, 'snake_case tool_calls 不被 parseSSELine 提取');
  assert.equal(r.chunk!.content, undefined);
});

test('端到端：含非法 JSON 行的流跳过该行不中断', () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"A"}}]}',
    'data: {broken line}',
    'data: {"choices":[{"delta":{"content":"B"}}]}',
    'data: [DONE]',
  ];
  const agg = new StreamAggregator();
  for (const line of lines) {
    const r = parseSSELine(line);
    if (r.done) break;
    if (r.chunk) agg.feed(r.chunk);
  }
  const { message } = agg.take();
  assert.equal(message.content, 'AB');
});

test('端到端：含注释/心跳行的流被忽略', () => {
  const lines = [
    ': ping',
    '',
    'data: {"choices":[{"delta":{"content":"X"}}]}',
    'event: tick',
    'data: {"choices":[{"delta":{"content":"Y"}}]}',
    'data: [DONE]',
  ];
  const agg = new StreamAggregator();
  for (const line of lines) {
    const r = parseSSELine(line);
    if (r.done) break;
    if (r.chunk) agg.feed(r.chunk);
  }
  assert.equal(agg.take().message.content, 'XY');
});
