/**
 * R13-D1（agentloop）：bench.ts 基准测试工具的纯函数测试。
 *
 * 覆盖：
 *   - BenchmarkRunner.measure/measureAsync/measureWithMemory 的正确性
 *   - computeStats 统计量（avg/median/p95/min/max/opsPerSec）
 *   - format 格式化输出
 *   - makeText/makeMemory/stubLLM 辅助函数
 *   - runAllBenchmarks 端到端
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BenchmarkRunner,
  makeText,
  makeMemory,
  stubLLM,
  runAllBenchmarks,
  type BenchmarkResult,
} from '../src/bench.ts';

describe('BenchmarkRunner.measure', () => {
  test('同步函数测量返回完整统计', () => {
    const r = new BenchmarkRunner(5);
    const res = r.measure('noop', () => {}, 100);
    assert.equal(res.name, 'noop');
    assert.equal(res.iterations, 100);
    assert.ok(res.totalMs >= 0);
    assert.ok(res.avgUs >= 0);
    assert.ok(res.minUs <= res.maxUs);
    assert.ok(res.medianUs >= res.minUs && res.medianUs <= res.maxUs);
    assert.ok(res.p95Us >= res.medianUs);
    assert.ok(res.opsPerSec > 0);
  });

  test('unit 标签透传', () => {
    const r = new BenchmarkRunner(1);
    const res = r.measure('with-unit', () => {}, 10, 'token');
    assert.equal(res.unit, 'token');
  });

  test('空 unit → undefined', () => {
    const r = new BenchmarkRunner(1);
    const res = r.measure('no-unit', () => {}, 10);
    assert.equal(res.unit, undefined);
  });

  test('warmup 不超过 iterations', () => {
    const r = new BenchmarkRunner(1000); // warmup=1000
    const res = r.measure('small', () => {}, 10); // iterations=10
    assert.equal(res.iterations, 10);
  });
});

describe('BenchmarkRunner.measureAsync', () => {
  test('异步函数测量', async () => {
    const r = new BenchmarkRunner(2);
    const res = await r.measureAsync('async-noop', async () => {}, 20);
    assert.equal(res.iterations, 20);
    assert.ok(res.totalMs >= 0);
  });

  test('含 await 的真实异步操作', async () => {
    const r = new BenchmarkRunner(1);
    const res = await r.measureAsync(
      'resolve',
      () => Promise.resolve(42),
      10,
    );
    assert.equal(res.iterations, 10);
    assert.ok(res.opsPerSec > 0);
  });
});

describe('BenchmarkRunner.measureWithMemory', () => {
  test('返回含 heapDelta（当 gc 可用时）', () => {
    const r = new BenchmarkRunner(1);
    const res = r.measureWithMemory('alloc', () => {
      // 分配一些对象
      const arr = new Array(100).fill('x');
      return arr.length;
    }, 10);
    assert.equal(res.iterations, 10);
    // heapDelta 可能为 undefined（无 --expose-gc）或数字
    if (res.heapDelta !== undefined) {
      assert.ok(typeof res.heapDelta === 'number');
    }
  });
});

describe('BenchmarkRunner.format', () => {
  test('格式化含名称与次数', () => {
    const r = new BenchmarkRunner(1);
    const res = r.measure('format-test', () => {}, 10);
    const s = r.format(res);
    assert.match(s, /format-test/);
    assert.match(s, /10 次/);
  });

  test('含 avg/p50/p95', () => {
    const r = new BenchmarkRunner(1);
    const res = r.measure('stats', () => {}, 10);
    const s = r.format(res);
    assert.match(s, /avg/);
    assert.match(s, /p50/);
    assert.match(s, /p95/);
  });

  test('含 ops/s', () => {
    const r = new BenchmarkRunner(1);
    const res = r.measure('ops', () => {}, 10);
    const s = r.format(res);
    assert.match(s, /ops\/s/);
  });

  test('unit 在格式化中体现', () => {
    const mock: BenchmarkResult = {
      name: 'unit-test', iterations: 100, totalMs: 10, avgUs: 100,
      minUs: 50, maxUs: 200, medianUs: 95, p95Us: 180, opsPerSec: 10000, unit: 'token',
    };
    const r = new BenchmarkRunner(1);
    const s = r.format(mock);
    assert.match(s, /\/token/);
  });

  test('heapDelta 在格式化中体现（当存在）', () => {
    const mock: BenchmarkResult = {
      name: 'mem-test', iterations: 100, totalMs: 10, avgUs: 100,
      minUs: 50, maxUs: 200, medianUs: 95, p95Us: 180, opsPerSec: 10000,
      heapDelta: 2048,
    };
    const r = new BenchmarkRunner(1);
    const s = r.format(mock);
    assert.match(s, /heap/);
  });
});

describe('makeText', () => {
  test('生成长度正确', () => {
    for (const n of [0, 10, 50, 100]) {
      assert.equal(makeText(n).length, n);
    }
  });

  test('含中文+ASCII 混合', () => {
    const text = makeText(100);
    assert.ok(text.length > 0);
    // 至少有一些非 ASCII 字符（中文）
    const hasCJK = /[^\x00-\x7F]/.test(text);
    assert.ok(hasCJK, '应含中文');
  });

  test('确定性（同长度同内容）', () => {
    const a = makeText(50);
    const b = makeText(50);
    assert.equal(a, b);
  });
});

describe('makeMemory', () => {
  test('生成指定条数消息', () => {
    const m = makeMemory(5);
    // Memory 内部消息数 = system(1) + user(5) = 6
    const snap = m.snapshot();
    assert.ok(snap.length >= 6);
  });

  test('自定义 contentLen', () => {
    const m1 = makeMemory(1, 10);
    const m2 = makeMemory(1, 100);
    const s1 = m1.snapshot();
    const s2 = m2.snapshot();
    // 第二条 user 消息长度应不同
    const u1 = s1.find((msg) => msg.role === 'user');
    const u2 = s2.find((msg) => msg.role === 'user');
    assert.ok(u1 && u2);
    assert.notEqual(u1!.content.length, u2!.content.length);
  });
});

describe('stubLLM', () => {
  test('返回固定回答', async () => {
    const llm = stubLLM('测试回答');
    const res = await llm.chat([]);
    assert.equal(res.message.content, '测试回答');
  });

  test('默认回答', async () => {
    const llm = stubLLM();
    const res = await llm.chat([]);
    assert.equal(res.message.content, '完成');
  });

  test('chatStream 也返回固定回答', async () => {
    const llm = stubLLM('流式回答');
    const res = await llm.chatStream?.([]);
    assert.equal(res?.message.content, '流式回答');
  });

  test('isStub = true', () => {
    assert.equal(stubLLM().isStub, true);
  });

  test('supportsStream = true', () => {
    assert.equal(stubLLM().supportsStream, true);
  });

  test('usage 含 token 统计', async () => {
    const res = await stubLLM().chat([]);
    assert.ok(res.usage);
    assert.ok(res.usage!.totalTokens > 0);
  });
});

describe('runAllBenchmarks', () => {
  test('返回非空结果数组', async () => {
    const results = await runAllBenchmarks();
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
  });

  test('每个结果结构完整', async () => {
    const results = await runAllBenchmarks();
    for (const r of results) {
      assert.ok(typeof r.name === 'string' && r.name.length > 0);
      assert.ok(r.iterations > 0);
      assert.ok(r.totalMs >= 0);
      assert.ok(Number.isFinite(r.avgUs));
    }
  });
});
