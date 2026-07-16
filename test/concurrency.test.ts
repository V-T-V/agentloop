/**
 * concurrency.ts 并发限制器的测试。
 *
 * 覆盖：信号量 acquire/release、并发不超限、withConcurrency 包装、
 * 全局 LLM 信号量单例、fanout maxConcurrency 集成。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Semaphore, withConcurrency, getLlmSemaphore, resetLlmSemaphore } from '../src/concurrency.ts';
import { fanOut } from '../src/fanout.ts';

/** 用延时模拟并发操作，返回实际峰值并发数 */
async function measurePeakConcurrency(sem: Semaphore, count: number, workMs = 50): Promise<number> {
  let current = 0;
  let peak = 0;
  const tasks = Array.from({ length: count }, (_, i) => i);
  await Promise.all(
    tasks.map(async () => {
      const release = await sem.acquire();
      current++;
      if (current > peak) peak = current;
      await new Promise((r) => setTimeout(r, workMs));
      current--;
      release();
    }),
  );
  return peak;
}

test('Semaphore：容量正确', () => {
  const sem = new Semaphore(5);
  assert.equal(sem.capacity, 5);
  assert.equal(sem.currentInFlight, 0);
  assert.equal(sem.pending, 0);
});

test('Semaphore：最小容量 1', () => {
  const sem = new Semaphore(0);
  assert.equal(sem.capacity, 1);
});

test('Semaphore：并发数不超过限制', async () => {
  const sem = new Semaphore(3);
  const peak = await measurePeakConcurrency(sem, 10);
  assert.ok(peak <= 3, `峰值并发 ${peak} 应 <= 3`);
  assert.ok(peak >= 2, `峰值并发 ${peak} 应 >= 2（确实并行了）`);
});

test('Semaphore：容量 1 时串行执行', async () => {
  const sem = new Semaphore(1);
  const peak = await measurePeakConcurrency(sem, 5);
  assert.equal(peak, 1, '容量 1 应完全串行');
});

test('Semaphore：release 后 inFlight 归零', async () => {
  const sem = new Semaphore(2);
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  assert.equal(sem.currentInFlight, 2);
  r1();
  assert.equal(sem.currentInFlight, 1);
  r2();
  assert.equal(sem.currentInFlight, 0);
});

test('Semaphore：重复 release 不出错（幂等）', async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  release();
  release(); // 幂等，不抛
  assert.equal(sem.currentInFlight, 0);
});

test('Semaphore：等待者被正确唤醒', async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];
  // 第一个立即获取
  const r1 = await sem.acquire();
  order.push('acquire1');
  // 第二个排队等待
  const p2 = sem.acquire().then((r) => {
    order.push('acquire2');
    return r;
  });
  assert.equal(sem.pending, 1, '应有 1 个等待者');
  // 释放第一个，第二个应被唤醒
  r1();
  const r2 = await p2;
  assert.ok(order.includes('acquire2'), '等待者被唤醒');
  r2();
});

test('withConcurrency：自动 acquire/release', async () => {
  const sem = new Semaphore(2);
  const result = await withConcurrency(sem, async () => {
    assert.equal(sem.currentInFlight, 1, '执行期间 inFlight=1');
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(sem.currentInFlight, 0, '执行后 inFlight 归零');
});

test('withConcurrency：异常时仍释放', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(
    withConcurrency(sem, async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(sem.currentInFlight, 0, '异常后仍释放许可');
  assert.equal(sem.capacity, 1, '许可全部归还');
});

test('withConcurrency：并发不超限', async () => {
  const sem = new Semaphore(3);
  let peak = 0;
  let current = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withConcurrency(sem, async () => {
        current++;
        if (current > peak) peak = current;
        await new Promise((r) => setTimeout(r, 20));
        current--;
      }),
    ),
  );
  assert.ok(peak <= 3, `峰值 ${peak} <= 3`);
});

test('全局 LLM 信号量：单例', () => {
  resetLlmSemaphore(5);
  const s1 = getLlmSemaphore();
  const s2 = getLlmSemaphore();
  assert.equal(s1, s2, '同一实例');
  assert.equal(s1.capacity, 5);
});

// —————————— fanout maxConcurrency 集成 ——————————

test('fanout：maxConcurrency 限制并发', async () => {
  let current = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, input: `task${i}` }));
  await fanOut(
    tasks,
    async () => {
      current++;
      if (current > peak) peak = current;
      await new Promise((r) => setTimeout(r, 30));
      current--;
      return 'ok';
    },
    { maxConcurrency: 2, timeoutMs: 5000 },
  );
  assert.ok(peak <= 2, `fanout 峰值并发 ${peak} 应 <= 2`);
});

test('fanout：不传 maxConcurrency 时全部并发', async () => {
  let current = 0;
  let peak = 0;
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, input: `task${i}` }));
  await fanOut(
    tasks,
    async () => {
      current++;
      if (current > peak) peak = current;
      await new Promise((r) => setTimeout(r, 30));
      current--;
      return 'ok';
    },
    { timeoutMs: 5000 },
  );
  assert.equal(peak, 5, '无限制时全部并发');
});
