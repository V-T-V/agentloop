/**
 * bench.ts 性能基准测试模块的测试（R6）。
 *
 * 不断言具体耗时数值（机器相关），只验证：
 * 1. BenchmarkRunner.measure 返回结构正确、统计量自洽。
 * 2. measureAsync 正确计时异步函数。
 * 3. measureWithMemory 返回 heapDelta。
 * 4. format 输出可读字符串。
 * 5. 预置场景（makeText/makeMemory/stubLLM/runAllBenchmarks）可运行。
 * 6. 统计量单调性（min <= median <= p95 <= max）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BenchmarkRunner,
  makeText,
  makeMemory,
  stubLLM,
  runAllBenchmarks,
  type BenchmarkResult,
} from '../src/bench.ts';
import { estimateTokens } from '../src/tokens.ts';
import { runLoop } from '../src/loop.ts';

// —————————— BenchmarkRunner.measure ——————————

test('measure：返回完整 BenchmarkResult 结构', () => {
  const r = new BenchmarkRunner(10);
  const res = r.measure('noop', () => {}, 100);
  assert.equal(res.name, 'noop');
  assert.equal(res.iterations, 100);
  assert.ok(res.totalMs >= 0);
  assert.ok(res.avgUs >= 0);
  assert.ok(res.minUs >= 0);
  assert.ok(res.maxUs >= 0);
  assert.ok(res.medianUs >= 0);
  assert.ok(res.p95Us >= 0);
  assert.ok(res.opsPerSec >= 0);
});

test('measure：统计量单调性 min <= median <= p95 <= max', () => {
  const r = new BenchmarkRunner(10);
  const res = r.measure(
    'busy',
    () => {
      let s = 0;
      for (let i = 0; i < 100; i++) s += i;
      return s;
    },
    500,
  );
  assert.ok(res.minUs <= res.medianUs + 0.001, 'min <= median');
  assert.ok(res.medianUs <= res.p95Us + 0.001, 'median <= p95');
  assert.ok(res.p95Us <= res.maxUs + 0.001, 'p95 <= max');
});

test('measure：iterations 影响总次数与 opsPerSec', () => {
  const r = new BenchmarkRunner(0);
  const res1 = r.measure('n', () => 1 + 1, 50);
  const res2 = r.measure('n', () => 1 + 1, 200);
  assert.equal(res1.iterations, 50);
  assert.equal(res2.iterations, 200);
  // opsPerSec 应为正数
  assert.ok(res1.opsPerSec > 0);
  assert.ok(res2.opsPerSec > 0);
});

test('measure：执行被测函数（副作用可观测）', () => {
  let calls = 0;
  const r = new BenchmarkRunner(0);
  r.measure('counter', () => calls++, 100);
  assert.equal(calls, 100);
});

// —————————— measureAsync ——————————

test('measureAsync：正确计时异步函数', async () => {
  const r = new BenchmarkRunner(2);
  const res = await r.measureAsync(
    'async-resolve',
    async () => {
      await Promise.resolve(42);
    },
    30,
  );
  assert.equal(res.iterations, 30);
  assert.ok(res.totalMs >= 0);
});

test('measureAsync：执行被测异步函数', async () => {
  let calls = 0;
  const r = new BenchmarkRunner(0);
  await r.measureAsync(
    'async-counter',
    async () => {
      await Promise.resolve();
      calls++;
    },
    20,
  );
  assert.equal(calls, 20);
});

// —————————— measureWithMemory ——————————

test('measureWithMemory：返回 heapDelta（数值）', () => {
  const r = new BenchmarkRunner(5);
  const res = r.measureWithMemory(
    'alloc',
    () => {
      // 制造一些堆分配
      const arr = new Array(1000).fill('x');
      return arr.length;
    },
    50,
  );
  assert.equal(typeof res.heapDelta, 'number');
  // heapDelta 可能正可能负（GC 时机），只验证存在
  assert.ok(res.heapDelta !== undefined);
});

// —————————— format ——————————

test('format：输出含名称/迭代数/avg/p50/p95/ops', () => {
  const r = new BenchmarkRunner();
  const res = r.measure('fmt-test', () => 1, 50, '次');
  const text = r.format(res);
  assert.match(text, /fmt-test/);
  assert.match(text, /avg/);
  assert.match(text, /p50/);
  assert.match(text, /p95/);
  assert.match(text, /ops\/s/);
});

test('format：含 heapDelta 时输出 heap 信息', () => {
  const r = new BenchmarkRunner();
  const res = r.measureWithMemory('mem-test', () => new Array(100).fill(0), 20);
  const text = r.format(res);
  assert.match(text, /heap/);
});

test('format：含 unit 时输出单位', () => {
  const r = new BenchmarkRunner(0);
  const res = r.measure('unit-test', () => 1, 10, 'token');
  const text = r.format(res);
  assert.match(text, /token/);
});

// —————————— 预置场景 ——————————

test('makeText：生成长度近似指定的混合文本', () => {
  const t = makeText(500);
  assert.ok(t.length >= 500);
  // 含 CJK 字符
  assert.ok(/[\u4e00-\u9fff]/.test(t), '应含中文');
});

test('makeMemory：生成指定条数的 memory', () => {
  const m = makeMemory(50);
  // 1 system + 50 user
  assert.equal(m.length, 51);
  assert.equal(m.snapshot()[0]!.role, 'system');
});

test('stubLLM：返回固定回答的 ChatResult', async () => {
  const llm = stubLLM('测试答案');
  const res = await llm.chat({ messages: [], tools: [] });
  assert.equal(res.message.content, '测试答案');
  assert.ok(res.usage);
  assert.equal(res.usage!.totalTokens, 15);
});

test('stubLLM：chatStream 返回相同结构', async () => {
  const llm = stubLLM('流式答案');
  const res = await llm.chatStream({ messages: [], tools: [] }, {});
  assert.equal(res.message.content, '流式答案');
});

test('runAllBenchmarks：跑完全部 6 个场景且结构自洽', async () => {
  const results = await runAllBenchmarks();
  assert.equal(results.length, 6);
  // 每个结果结构自洽
  for (const res of results) {
    assert.ok(res.name.length > 0, '名称非空');
    assert.ok(res.iterations > 0);
    assert.ok(res.minUs <= res.maxUs, `${res.name}: min <= max`);
    assert.ok(res.opsPerSec > 0, `${res.name}: opsPerSec > 0`);
  }
  // 含预期的关键场景名
  const names = results.map((r) => r.name);
  assert.ok(names.some((n) => n.includes('estimateTokens')));
  assert.ok(names.some((n) => n.includes('runLoop')));
});

// —————————— runLoop 与 bench 协同 ——————————

test('runLoop 用 stubLLM 可跑通（基准场景的正确性校验）', async () => {
  const result = await runLoop({
    llm: stubLLM('基准答案'),
    tools: [],
    system: 'sys',
    user: '问题',
    stream: false,
    maxSteps: 2,
  });
  assert.equal(result.stopReason, 'final');
  assert.equal(result.answer, '基准答案');
});

// —————————— 大输入下的健壮性 ——————————

test('estimateTokens 与 bench makeText 协同（大文本不崩溃）', () => {
  const big = makeText(50_000);
  const tokens = estimateTokens(big);
  assert.ok(tokens > 0);
  assert.ok(tokens < 100_000, '估算在合理范围');
});

test('BenchmarkRunner：warmup 不超过 iterations 时不报错', () => {
  const r = new BenchmarkRunner(10_000); // warmup 远大于 iterations
  const res = r.measure('x', () => 1, 5);
  assert.equal(res.iterations, 5);
});
