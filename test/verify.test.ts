/**
 * verify.ts 客观验证层的测试。
 *
 * 覆盖所有断言类型：答案匹配、数值范围、工具使用、步数、停止原因、自定义。
 * 重点验证「确定性」——同样输入永远同样输出（无 LLM 随机性）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyTask, renderVerify, type Assertion } from '../src/verify.ts';
import type { RunLoopOutput } from '../src/loop.ts';
import type { Span } from '../src/trace.ts';

/** 造一个带工具调用的假 trace（用于 tool_used 断言） */
function traceWithTools(toolNames: string[]): Span {
  const toolChildren: Span[] = toolNames.map((name, i) => ({
    id: `t${i}`,
    name: 'tool',
    parentId: 'step',
    start: 0,
    end: 1,
    status: 'ok',
    attributes: { step: 1, tool: name },
    children: [],
  }));
  return {
    id: 'run',
    name: 'run',
    parentId: null,
    start: 0,
    end: 2,
    status: 'ok',
    attributes: { answer: 'x', stopReason: 'final' },
    children: [
      {
        id: 'step',
        name: 'step',
        parentId: 'run',
        start: 0,
        end: 2,
        status: 'ok',
        attributes: { step: 1 },
        children: toolChildren,
      },
    ],
  };
}

function makeResult(over: Partial<RunLoopOutput>): RunLoopOutput {
  return {
    answer: '',
    steps: 1,
    stopReason: 'final',
    memory: {} as RunLoopOutput['memory'],
    trace: null,
    totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ...over,
  } as RunLoopOutput;
}

// —————————— answer_contains ——————————

test('answer_contains：答案含期望字符串 → 通过', () => {
  const r = verifyTask(makeResult({ answer: '还有 186 天' }), [
    { type: 'answer_contains', value: '186' },
  ]);
  assert.equal(r.passed, 1);
  assert.equal(r.allPassed, true);
});

test('answer_contains：答案不含 → 失败', () => {
  const r = verifyTask(makeResult({ answer: '不知道' }), [
    { type: 'answer_contains', value: '186' },
  ]);
  assert.equal(r.passed, 0);
  assert.equal(r.allPassed, false);
  assert.match(r.results[0]!.detail, /未找到/);
});

test('answer_not_contains：答案不含禁词 → 通过', () => {
  const r = verifyTask(makeResult({ answer: '正确答案' }), [
    { type: 'answer_not_contains', value: '不知道' },
  ]);
  assert.equal(r.allPassed, true);
});

// —————————— answer_regex ——————————

test('answer_regex：正则匹配 → 通过', () => {
  const r = verifyTask(makeResult({ answer: '结果是 42' }), [
    { type: 'answer_regex', value: '\\d+' },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_regex：非法正则 → 失败且不抛', () => {
  const r = verifyTask(makeResult({ answer: 'x' }), [
    { type: 'answer_regex', value: '(' },
  ]);
  assert.equal(r.passed, 0);
  assert.match(r.results[0]!.detail, /正则非法/);
});

// —————————— answer_number_in_range ——————————

test('answer_number_in_range：数值在范围内 → 通过', () => {
  const r = verifyTask(makeResult({ answer: '还有 186 天' }), [
    { type: 'answer_number_in_range', min: 180, max: 190 },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_number_in_range：数值超范围 → 失败', () => {
  const r = verifyTask(makeResult({ answer: '还有 500 天' }), [
    { type: 'answer_number_in_range', min: 180, max: 190 },
  ]);
  assert.equal(r.allPassed, false);
  assert.match(r.results[0]!.detail, /超出范围/);
});

test('answer_number_in_range：答案无数值 → 失败', () => {
  const r = verifyTask(makeResult({ answer: '没有数字' }), [
    { type: 'answer_number_in_range', min: 0, max: 10 },
  ]);
  assert.equal(r.allPassed, false);
  assert.match(r.results[0]!.detail, /未提取到数字/);
});

test('answer_number_in_range：支持小数', () => {
  const r = verifyTask(makeResult({ answer: '总额 16288.95 元' }), [
    { type: 'answer_number_in_range', min: 16000, max: 16500 },
  ]);
  assert.equal(r.allPassed, true);
});

// —————————— near 关键词锁定（L1 修复）——————————

test('answer_number_in_range + near：锁定关键词附近的数字，避开年份干扰', () => {
  // L1 真实场景：答案含年份 2026，但「还有 186 天」才是目标
  const r = verifyTask(makeResult({ answer: '从 2026年6月28日 到 2026年12月31日 还有 186 天' }), [
    { type: 'answer_number_in_range', min: 180, max: 190, near: '还有' },
  ]);
  assert.equal(r.allPassed, true);
  assert.match(r.results[0]!.detail, /186/);
});

test('answer_number_in_range + near：无 near 时仍取首个（撞年份失败，符合旧行为）', () => {
  const r = verifyTask(makeResult({ answer: '从 2026年 还有 186 天' }), [
    { type: 'answer_number_in_range', min: 180, max: 190 },
  ]);
  assert.equal(r.allPassed, false); // 取首个 2026，超出范围
  assert.match(r.results[0]!.detail, /2026/);
});

test('answer_number_in_range + near：关键词不存在 → 失败', () => {
  const r = verifyTask(makeResult({ answer: '还有 186 天' }), [
    { type: 'answer_number_in_range', min: 180, max: 190, near: '价格' },
  ]);
  assert.equal(r.allPassed, false);
  assert.match(r.results[0]!.detail, /未找到/);
});

// —————————— all_numbers_in_range ——————————

test('answer_all_numbers_in_range：所有数值都在范围 → 通过', () => {
  const r = verifyTask(makeResult({ answer: 'n=6: 9步, n=27: 111步' }), [
    { type: 'answer_all_numbers_in_range', min: 1, max: 500 },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_all_numbers_in_range：有超范围数值 → 失败且列出', () => {
  const r = verifyTask(makeResult({ answer: '结果：186 和 9999' }), [
    { type: 'answer_all_numbers_in_range', min: 0, max: 500 },
  ]);
  assert.equal(r.allPassed, false);
  assert.match(r.results[0]!.detail, /9999/);
});

test('answer_all_numbers_in_range：答案无数值 → 失败', () => {
  const r = verifyTask(makeResult({ answer: '无数字' }), [
    { type: 'answer_all_numbers_in_range', min: 0, max: 10 },
  ]);
  assert.equal(r.allPassed, false);
});

// —————————— tool_used / tool_not_used ——————————

test('tool_used：用了指定工具 → 通过', () => {
  const r = verifyTask(
    makeResult({ trace: traceWithTools(['calculator', 'datetime']) }),
    [{ type: 'tool_used', name: 'calculator' }],
  );
  assert.equal(r.allPassed, true);
});

test('tool_used：没用指定工具 → 失败且列出实际用的', () => {
  const r = verifyTask(
    makeResult({ trace: traceWithTools(['datetime']) }),
    [{ type: 'tool_used', name: 'calculator' }],
  );
  assert.equal(r.allPassed, false);
  assert.match(r.results[0]!.detail, /datetime/);
});

test('tool_not_used：没用禁用工具 → 通过', () => {
  const r = verifyTask(
    makeResult({ trace: traceWithTools(['calculator']) }),
    [{ type: 'tool_not_used', name: 'http_get' }],
  );
  assert.equal(r.allPassed, true);
});

// —————————— steps_at_most / stop_reason ——————————

test('steps_at_most：步数达标 → 通过', () => {
  const r = verifyTask(makeResult({ steps: 3 }), [{ type: 'steps_at_most', max: 5 }]);
  assert.equal(r.allPassed, true);
});

test('steps_at_most：步数超标 → 失败', () => {
  const r = verifyTask(makeResult({ steps: 8 }), [{ type: 'steps_at_most', max: 5 }]);
  assert.equal(r.allPassed, false);
});

test('stop_reason：匹配 → 通过', () => {
  const r = verifyTask(makeResult({ stopReason: 'final' }), [{ type: 'stop_reason', value: 'final' }]);
  assert.equal(r.allPassed, true);
});

// —————————— custom ——————————

test('custom：自定义函数通过', () => {
  const r = verifyTask(makeResult({ answer: 'hello' }), [
    { type: 'custom', check: (res) => res.answer.length > 3, description: '答案长度>3' },
  ]);
  assert.equal(r.allPassed, true);
});

test('custom：自定义函数抛错 → 失败且不崩', () => {
  const r = verifyTask(makeResult({}), [
    { type: 'custom', check: () => { throw new Error('炸了'); } },
  ]);
  assert.equal(r.passed, 0);
  assert.match(r.results[0]!.detail, /炸了/);
});

// —————————— 组合与确定性 ——————————

test('组合断言：多条混合，部分通过', () => {
  const r = verifyTask(
    makeResult({ answer: '答案是 42', steps: 3, stopReason: 'final', trace: traceWithTools(['calculator']) }),
    [
      { type: 'answer_contains', value: '42' },
      { type: 'answer_contains', value: '999' }, // 失败
      { type: 'tool_used', name: 'calculator' },
      { type: 'steps_at_most', max: 5 },
    ],
  );
  assert.equal(r.passed, 3);
  assert.equal(r.total, 4);
  assert.equal(r.passRate, 75);
  assert.equal(r.allPassed, false);
});

test('空断言列表：passRate 100', () => {
  const r = verifyTask(makeResult({}), []);
  assert.equal(r.passRate, 100);
  assert.equal(r.allPassed, false); // 无断言不算全过
});

test('确定性：同样输入两次结果完全一致', () => {
  const result = makeResult({ answer: '186 天', steps: 2 });
  const assertions: Assertion[] = [
    { type: 'answer_contains', value: '186' },
    { type: 'steps_at_most', max: 5 },
  ];
  const r1 = verifyTask(result, assertions);
  const r2 = verifyTask(result, assertions);
  assert.deepEqual(r1, r2); // 确定性：无随机性
});

test('renderVerify：渲染含通过率与逐条', () => {
  const r = verifyTask(makeResult({ answer: '186' }), [
    { type: 'answer_contains', value: '186' },
    { type: 'answer_contains', value: '999' },
  ]);
  const text = renderVerify(r);
  assert.match(text, /1\/2 通过/);
  assert.match(text, /✓/);
  assert.match(text, /✗/);
});

test('description 自定义优先', () => {
  const r = verifyTask(makeResult({ answer: 'x' }), [
    { type: 'answer_contains', value: 'x', description: '我的自定义描述' },
  ]);
  assert.equal(r.results[0]!.description, '我的自定义描述');
});

// —————————— 新增断言类型测试 ——————————

test('answer_json_path：路径存在且 equals 匹配 → 通过', () => {
  const r = verifyTask(makeResult({ answer: '{"name":"Alice","age":30}' }), [
    { type: 'answer_json_path', path: '$.name', equals: 'Alice' },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_json_path：路径存在但 equals 不匹配 → 失败', () => {
  const r = verifyTask(makeResult({ answer: '{"name":"Bob"}' }), [
    { type: 'answer_json_path', path: '$.name', equals: 'Alice' },
  ]);
  assert.equal(r.allPassed, false);
});

test('answer_json_path：路径不存在 → 失败', () => {
  const r = verifyTask(makeResult({ answer: '{"a":1}' }), [
    { type: 'answer_json_path', path: '$.b', equals: 2 },
  ]);
  assert.equal(r.allPassed, false);
});

test('answer_json_path：contains 子串匹配', () => {
  const r = verifyTask(makeResult({ answer: '{"msg":"hello world"}' }), [
    { type: 'answer_json_path', path: '$.msg', contains: 'world' },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_json_path：嵌套路径', () => {
  const r = verifyTask(makeResult({ answer: '{"user":{"profile":{"age":25}}}' }), [
    { type: 'answer_json_path', path: '$.user.profile.age', equals: 25 },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_json_path：数组下标', () => {
  const r = verifyTask(makeResult({ answer: '{"items":[10,20,30]}' }), [
    { type: 'answer_json_path', path: '$.items[1]', equals: 20 },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_json_path：带 markdown fence 的 JSON', () => {
  const r = verifyTask(makeResult({ answer: '```json\n{"x":42}\n```' }), [
    { type: 'answer_json_path', path: '$.x', equals: 42 },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_json_path：非 JSON 答案 → 失败', () => {
  const r = verifyTask(makeResult({ answer: '这是纯文本' }), [
    { type: 'answer_json_path', path: '$.x', equals: 1 },
  ]);
  assert.equal(r.allPassed, false);
});

test('answer_length：长度在范围内 → 通过', () => {
  const r = verifyTask(makeResult({ answer: 'hello' }), [
    { type: 'answer_length', min: 3, max: 10 },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_length：长度不足 → 失败', () => {
  const r = verifyTask(makeResult({ answer: 'hi' }), [
    { type: 'answer_length', min: 3 },
  ]);
  assert.equal(r.allPassed, false);
});

test('answer_length：仅 min', () => {
  const r = verifyTask(makeResult({ answer: 'a'.repeat(100) }), [
    { type: 'answer_length', min: 50 },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_matches_schema：object 类型匹配', () => {
  const r = verifyTask(makeResult({ answer: '{"a":1}' }), [
    { type: 'answer_matches_schema', schema: { type: 'object' } },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_matches_schema：类型不匹配', () => {
  const r = verifyTask(makeResult({ answer: '[1,2,3]' }), [
    { type: 'answer_matches_schema', schema: { type: 'object' } },
  ]);
  assert.equal(r.allPassed, false);
});

test('answer_matches_schema：array 匹配', () => {
  const r = verifyTask(makeResult({ answer: '[1,2,3]' }), [
    { type: 'answer_matches_schema', schema: { type: 'array' } },
  ]);
  assert.equal(r.allPassed, true);
});

test('answer_matches_schema：非 JSON → 失败', () => {
  const r = verifyTask(makeResult({ answer: '纯文本' }), [
    { type: 'answer_matches_schema', schema: { type: 'object' } },
  ]);
  assert.equal(r.allPassed, false);
});
