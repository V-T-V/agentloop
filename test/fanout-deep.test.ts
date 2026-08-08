/**
 * fanout.ts 深层路径测试（R10-D2）。
 *
 * 补 fanout.test.ts 未触达的分支：
 *   1. maxConcurrency 信号量节流：高并发上限被严格串行化（不突破 max）
 *   2. AbortSignal 在超时后确实 abort（signal.aborted === true），允许 runner 主动清理
 *   3. timeoutMs=0 表示不超时（慢任务也能完成）
 *   4. 非 Error 对象抛错（throw 字符串/对象）→ output 走 String(e) 兜底
 *   5. timeoutMs 默认值 30000：不传 options 时 runner 仍能拿到 signal
 *   6. summary 中失败项带 ❌ 标记、成功项带 ✅
 *   7. 单个任务耗时 durationMs 在失败时也 > 0（除立即抛错）
 *   8. 默认无 maxConcurrency：N 个任务全部并发（无信号量分支）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fanOut, type FanOutTask } from '../src/fanout.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('maxConcurrency：严格限制同时在途数量（峰值 = max）', async () => {
  let inFlight = 0;
  let peak = 0;
  const tasks: FanOutTask[] = Array.from({ length: 6 }, (_, i) => ({
    id: `t${i}`,
    input: '',
  }));
  const runner = async (_t: FanOutTask) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(40);
    inFlight--;
    return 'ok';
  };
  await fanOut(tasks, runner, { maxConcurrency: 2, timeoutMs: 2000 });
  assert.ok(peak <= 2, `峰值在途不应超过 max=2，实际 ${peak}`);
  assert.ok(peak >= 2, `应能跑满 max=2 并发，实际峰值 ${peak}`);
});

test('maxConcurrency=1：完全串行化（峰值=1）', async () => {
  let inFlight = 0;
  let peak = 0;
  const tasks: FanOutTask[] = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, input: '' }));
  const runner = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(20);
    inFlight--;
    return 'done';
  };
  await fanOut(tasks, runner, { maxConcurrency: 1, timeoutMs: 2000 });
  assert.equal(peak, 1, 'maxConcurrency=1 时必须严格串行');
});

test('maxConcurrency=0/负数：不节流，全部并发', async () => {
  let inFlight = 0;
  let peak = 0;
  const tasks: FanOutTask[] = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, input: '' }));
  const runner = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(30);
    inFlight--;
    return 'ok';
  };
  // 0 表示不限制
  await fanOut(tasks, runner, { maxConcurrency: 0, timeoutMs: 2000 });
  assert.ok(peak >= 4, `无节流时应接近全并发，峰值 ${peak}`);
});

test('AbortSignal：超时后 abort 事件触发，runner 可感知并清理', async () => {
  let aborted = false;
  const tasks: FanOutTask[] = [{ id: 'slow', input: '' }];
  const runner = async (_t: FanOutTask, signal: AbortSignal) => {
    // 用 abort 事件同步捕获（比轮询 signal.aborted 更确定，不受 microtask 时序影响）
    return new Promise<string>((_resolve, _reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      // 永不自然完成——只能靠超时
    });
  };
  const r = await fanOut(tasks, runner, { timeoutMs: 50 });
  assert.equal(r.results[0]!.ok, false);
  // 关键：abort 事件确实同步触发（runner 拿到了 cleanup 机会）
  assert.equal(aborted, true, 'abort 事件应在超时时同步触发');
  // 注意：withTimeout 自身的 setTimeout reject 优先（同一 tick），
  // 故 output 反映「超时」而非 runner 内部的 reject —— 这是 fanout 的确定性行为
  assert.match(r.results[0]!.output, /超时/);
});

test('AbortSignal：超时前 signal.aborted 为 false（正常执行期）', async () => {
  let snapshot: boolean | undefined;
  const runner = async (_t: FanOutTask, signal: AbortSignal): Promise<string> => {
    snapshot = signal.aborted;
    return 'ok';
  };
  await fanOut([{ id: 'a', input: '' }], runner, { timeoutMs: 1000 });
  assert.equal(snapshot, false, '执行期内 signal 不应被 abort');
});

test('timeoutMs=0：不超时，慢任务也能完成', async () => {
  const r = await fanOut(
    [{ id: 'slow', input: '' }],
    async () => {
      await sleep(80);
      return 'finished';
    },
    { timeoutMs: 0 },
  );
  assert.equal(r.succeeded, 1);
  assert.equal(r.results[0]!.ok, true);
  assert.equal(r.results[0]!.output, 'finished');
});

test('非 Error 抛错：字符串被 String(e) 兜底', async () => {
  const r = await fanOut(
    [{ id: 'x', input: '' }],
    async () => {
      throw '原始字符串错误';
    },
    { timeoutMs: 1000 },
  );
  assert.equal(r.failed, 1);
  assert.equal(r.results[0]!.ok, false);
  assert.match(r.results[0]!.output, /原始字符串错误/);
});

test('非 Error 抛错：普通对象兜底为 [object Object]', async () => {
  const r = await fanOut(
    [{ id: 'x', input: '' }],
    async () => {
      throw { code: 42, reason: 'weird' };
    },
    { timeoutMs: 1000 },
  );
  assert.equal(r.results[0]!.ok, false);
  // String({code:42}) → [object Object]
  assert.match(r.results[0]!.output, /\[object Object\]/);
});

test('默认 options：不传第三参，runner 仍能拿到 signal 且不超时（快速任务）', async () => {
  const captured: AbortSignal[] = [];
  const r = await fanOut([{ id: 'a', input: '' }], async (_t, signal) => {
    captured.push(signal);
    return 'ok';
  });
  assert.equal(r.succeeded, 1);
  assert.equal(captured.length, 1, '默认 options 下 runner 仍能收到 signal');
  assert.equal(captured[0]!.aborted, false, '任务正常完成时 signal 未 abort');
});

test('summary 格式：失败项带 ❌、成功项带 ✅', async () => {
  const r = await fanOut(
    [
      { id: 'good', input: '' },
      { id: 'bad', input: '' },
    ],
    async (t) => {
      if (t.id === 'bad') throw new Error('炸了');
      return '好的';
    },
    { timeoutMs: 1000 },
  );
  assert.match(r.summary, /共 2 个子任务：成功 1，失败 1/);
  assert.match(r.summary, /【good】✅ 好的/);
  assert.match(r.summary, /【bad】❌ 失败：炸了/);
});

test('失败项也记录 durationMs（> 0，除非立即抛错）', async () => {
  const r = await fanOut(
    [{ id: 'slow-fail', input: '' }],
    async () => {
      await sleep(40);
      throw new Error('慢失败');
    },
    { timeoutMs: 1000 },
  );
  assert.equal(r.results[0]!.ok, false);
  assert.ok(r.results[0]!.durationMs >= 30, `失败项 durationMs 应记录实际耗时，实际 ${r.results[0]!.durationMs}`);
});

test('大量任务并发的正确性（stress，maxConcurrency 节流下无错乱）', async () => {
  const N = 20;
  const tasks: FanOutTask[] = Array.from({ length: N }, (_, i) => ({ id: `n${i}`, input: String(i) }));
  let inFlight = 0;
  let peak = 0;
  const r = await fanOut(
    tasks,
    async (t) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
      return `r${t.input}`;
    },
    { maxConcurrency: 4, timeoutMs: 5000 },
  );
  assert.equal(r.succeeded, N);
  assert.equal(r.failed, 0);
  assert.ok(peak <= 4, `stress 峰值不超 4，实际 ${peak}`);
  // 每个 id 都对应唯一结果
  const ids = new Set(r.results.map((x) => x.id));
  assert.equal(ids.size, N, '结果 id 无丢失/重复');
});

test('runner 接收的 task 对象含正确 id/input（透传不丢字段）', async () => {
  let seen: { id: string; input: number } | null = null;
  await fanOut(
    [{ id: 'task-xyz', input: 999 }],
    async (t) => {
      seen = { id: t.id, input: t.input };
      return 'ok';
    },
    { timeoutMs: 500 },
  );
  assert.equal(seen!.id, 'task-xyz');
  assert.equal(seen!.input, 999);
});

test('泛型 TInput：非 string 类型 input 透传正确', async () => {
  type In = { k: string; v: number };
  const r = await fanOut<In>(
    [
      { id: 'a', input: { k: 'x', v: 1 } },
      { id: 'b', input: { k: 'y', v: 2 } },
    ],
    async (t) => `${t.input.k}=${t.input.v}`,
    { timeoutMs: 500 },
  );
  assert.equal(r.succeeded, 2);
  assert.match(r.summary, /x=1/);
  assert.match(r.summary, /y=2/);
});
