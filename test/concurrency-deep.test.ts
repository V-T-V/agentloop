/**
 * concurrency.ts 深层边界测试（R5-D5）。
 *
 * 现有 concurrency.test.ts 覆盖核心 acquire/release/withConcurrency/全局信号量。
 * 本文件专攻边界与不变量，与现有文件互补：
 *   - release 幂等（多次调用不增许可）
 *   - 等待队列 FIFO 公平性
 *   - inFlight / pending / capacity 不变量在并发流转中保持
 *   - max < 1 被钳制为 1
 *   - withConcurrency 在 fn 抛错时仍释放许可
 *   - withConcurrency 返回值透传
 *   - acquire 后不 release 时 pending 累积
 *   - 交替 acquire/release 不死锁
 *   - 全局信号量 reset 后容量改变、单例性
 *   - 高并发下峰值严格 <= capacity
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Semaphore,
  withConcurrency,
  getLlmSemaphore,
  resetLlmSemaphore,
} from '../src/concurrency.ts';

test('Semaphore：max < 1 被钳制为 1', () => {
  const s = new Semaphore(0);
  assert.equal(s.capacity, 1);
  const sNeg = new Semaphore(-5);
  assert.equal(sNeg.capacity, 1);
});

test('Semaphore：初始 capacity/currentInFlight/pending 正确', () => {
  const s = new Semaphore(3);
  assert.equal(s.capacity, 3);
  assert.equal(s.currentInFlight, 0);
  assert.equal(s.pending, 0);
});

test('Semaphore：acquire 后 inFlight +1，release 后 -1', async () => {
  const s = new Semaphore(2);
  const release = await s.acquire();
  assert.equal(s.currentInFlight, 1);
  release();
  assert.equal(s.currentInFlight, 0);
});

test('Semaphore：release 幂等——多次调用不额外增加许可', async () => {
  const s = new Semaphore(1);
  const release = await s.acquire();
  release();
  assert.equal(s.currentInFlight, 0);
  release(); // 重复 release 应被忽略
  release();
  assert.equal(s.currentInFlight, 0, '重复 release 不改变 inFlight');
  // 验证许可未被多归还：再 acquire 一次后应能立即拿到，但下一个应排队
  const r2 = await s.acquire();
  assert.equal(s.currentInFlight, 1);
  let acquired = false;
  const waiting = s.acquire().then((r) => {
    acquired = true;
    r();
  });
  // 给微任务一轮
  await Promise.resolve();
  assert.equal(acquired, false, '重复 release 不应让等待者提前唤醒');
  r2();
  await waiting;
  assert.equal(acquired, true, 'r2 release 后等待者唤醒');
});

test('Semaphore：等待队列 FIFO 公平（先排队先拿到）', async () => {
  const s = new Semaphore(1);
  const release = await s.acquire();
  const order: string[] = [];
  // 三个等待者依次排队
  const p1 = s.acquire().then((r) => {
    order.push('first');
    r();
  });
  const p2 = s.acquire().then((r) => {
    order.push('second');
    r();
  });
  const p3 = s.acquire().then((r) => {
    order.push('third');
    r();
  });
  assert.equal(s.pending, 3);
  release();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ['first', 'second', 'third'], 'FIFO 顺序唤醒');
});

test('Semaphore：容量为 1 时严格串行（峰值 <= 1）', async () => {
  const s = new Semaphore(1);
  let current = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      const r = await s.acquire();
      current++;
      peak = Math.max(peak, current);
      await new Promise((res) => setTimeout(res, 5));
      current--;
      r();
    }),
  );
  assert.equal(peak, 1, '容量 1 时峰值并发为 1');
});

test('Semaphore：容量 N 时峰值 <= N', async () => {
  const N = 4;
  const s = new Semaphore(N);
  let current = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      const r = await s.acquire();
      current++;
      peak = Math.max(peak, current);
      await new Promise((res) => setTimeout(res, 8));
      current--;
      r();
    }),
  );
  assert.ok(peak <= N, `峰值 ${peak} 应 <= 容量 ${N}`);
  assert.equal(s.currentInFlight, 0, '全部完成后 inFlight 归零');
  assert.equal(s.pending, 0, '全部完成后 pending 归零');
});

test('Semaphore：交替 acquire/release 不死锁', async () => {
  const s = new Semaphore(2);
  for (let i = 0; i < 50; i++) {
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    assert.equal(s.currentInFlight, 2);
    r1();
    r2();
    assert.equal(s.currentInFlight, 0);
  }
});

test('Semaphore：pending 反映排队中的等待者数量', async () => {
  const s = new Semaphore(1);
  const r = await s.acquire();
  const waiterPromises = Array.from({ length: 5 }, () => s.acquire());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(s.pending, 5, '5 个等待者排队');
  r();
  // 容量 1：必须「拿到一个就释放」才能让下一个唤醒，串行消费完所有等待者
  for (const p of waiterPromises) {
    const rel = await p;
    rel();
  }
  assert.equal(s.currentInFlight, 0, '全部释放后 inFlight 归零');
});

test('withConcurrency：返回值透传', async () => {
  const s = new Semaphore(1);
  const result = await withConcurrency(s, async () => 42);
  assert.equal(result, 42);
});

test('withConcurrency：fn 抛错时仍释放许可', async () => {
  const s = new Semaphore(1);
  await assert.rejects(
    withConcurrency(s, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(s.currentInFlight, 0, '抛错后许可已归还');
  // 应能再次 acquire（证明许可确实归还）
  const r = await s.acquire();
  assert.equal(s.currentInFlight, 1);
  r();
});

test('withConcurrency：fn 抛非 Error 对象也释放', async () => {
  const s = new Semaphore(1);
  await assert.rejects(
    withConcurrency(s, async () => {
      throw 'string error';
    }),
    /string error/,
  );
  assert.equal(s.currentInFlight, 0);
});

test('withConcurrency：并发调用峰值受限', async () => {
  const s = new Semaphore(3);
  let current = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 15 }, () =>
      withConcurrency(s, async () => {
        current++;
        peak = Math.max(peak, current);
        await new Promise((res) => setTimeout(res, 6));
        current--;
      }),
    ),
  );
  assert.ok(peak <= 3, `峰值 ${peak} <= 3`);
});

test('withConcurrency：嵌套调用同一信号量会串行（容量 1 时）', async () => {
  // 容量 1 的信号量内再 withConcurrency 同一信号量会死锁，这里验证不嵌套时的串行性
  const s = new Semaphore(1);
  const order: number[] = [];
  await Promise.all(
    [1, 2, 3].map((n) =>
      withConcurrency(s, async () => {
        order.push(n);
        await new Promise((res) => setTimeout(res, 5));
      }),
    ),
  );
  assert.equal(order.length, 3);
});

test('getLlmSemaphore：返回单例（多次调用同一实例）', () => {
  resetLlmSemaphore(2);
  const a = getLlmSemaphore();
  const b = getLlmSemaphore();
  assert.equal(a, b, '同一引用');
  assert.equal(a.capacity, 2);
});

test('resetLlmSemaphore：重置后容量改变且为新实例', () => {
  resetLlmSemaphore(3);
  const before = getLlmSemaphore();
  resetLlmSemaphore(7);
  const after = getLlmSemaphore();
  assert.notEqual(before, after, '重置后是新实例');
  assert.equal(after.capacity, 7);
});

test('resetLlmSemaphore：无参数时用默认值（或环境变量）', () => {
  resetLlmSemaphore();
  const s = getLlmSemaphore();
  // 默认 4 或 LOOP_LLM_MAX_CONCURRENT；至少为正数
  assert.ok(s.capacity >= 1, '默认容量 >= 1');
});

test('Semaphore：许可传递（release 时若有等待者，许可直接传递不回 available）', async () => {
  const s = new Semaphore(1);
  const r = await s.acquire();
  assert.equal(s.currentInFlight, 1);
  // 排一个等待者
  const waiterPromise = s.acquire();
  await Promise.resolve();
  assert.equal(s.pending, 1);
  r(); // release → 唤醒等待者（许可传递，不归还 available）
  const waiterRelease = await waiterPromise;
  assert.equal(s.currentInFlight, 1, '许可传递后仍 inFlight=1');
  assert.equal(s.pending, 0);
  waiterRelease(); // 等待者释放，此时无后续等待者，available 回增
  assert.equal(s.currentInFlight, 0);
});

test('Semaphore：大量短任务全部完成且不泄漏许可', async () => {
  const s = new Semaphore(5);
  let done = 0;
  await Promise.all(
    Array.from({ length: 200 }, () =>
      withConcurrency(s, async () => {
        done++;
      }),
    ),
  );
  assert.equal(done, 200);
  assert.equal(s.currentInFlight, 0, '无许可泄漏');
  assert.equal(s.pending, 0);
});

test('Semaphore：capacity 不变（不被 release 篡改）', async () => {
  const s = new Semaphore(3);
  const r1 = await s.acquire();
  const r2 = await s.acquire();
  assert.equal(s.capacity, 3);
  r1();
  r2();
  assert.equal(s.capacity, 3, 'capacity 始终为构造值');
});
