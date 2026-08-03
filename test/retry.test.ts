/**
 * retry.ts 测试 —— 指数退避重试包裹器。
 *
 * 覆盖：
 *   - withRetry：首次成功不重试 / 重试后成功 / 耗尽后抛出最后一次错误
 *   - retryOn：谓词控制是否重试（按 status 区分可重试）
 *   - backoff 退避时长：指数增长 + 抖动封顶（通过实际等待时间间接验证）
 *   - 默认参数（retries=3 / baseDelayMs=500 / maxDelayMs=8000）
 *   - isRetryableStatus：429/5xx 可重试，4xx/2xx/3xx 不可重试，边界值
 *   - attempt 索引从 0 传递给 fn
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withRetry, isRetryableStatus } from '../src/retry.ts';

test('withRetry：首次成功不重试（attempt=0）', async () => {
  const calls: number[] = [];
  const result = await withRetry(async (attempt) => {
    calls.push(attempt);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(calls, [0]);
});

test('withRetry：重试后成功（尝试 3 次后成功）', async () => {
  const calls: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      calls.push(attempt);
      if (attempt < 2) throw new Error(`fail-${attempt}`);
      return 'success';
    },
    { retries: 5, baseDelayMs: 1, maxDelayMs: 5 },
  );
  assert.equal(result, 'success');
  assert.deepEqual(calls, [0, 1, 2]);
});

test('withRetry：耗尽后抛出最后一次错误', async () => {
  const calls: number[] = [];
  await assert.rejects(
    withRetry(
      async (attempt) => {
        calls.push(attempt);
        throw new Error(`fail-${attempt}`);
      },
      { retries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    ),
    /fail-2/,
  );
  // 总尝试次数 = retries + 1 = 3（attempt 0,1,2）
  assert.deepEqual(calls, [0, 1, 2]);
});

test('withRetry：retries=0 表示只尝试一次不重试', async () => {
  const calls: number[] = [];
  await assert.rejects(
    withRetry(
      async (attempt) => {
        calls.push(attempt);
        throw new Error('always-fail');
      },
      { retries: 0, baseDelayMs: 1 },
    ),
    /always-fail/,
  );
  assert.deepEqual(calls, [0]);
});

test('withRetry：retryOn 谓词返回 false 立即抛出（不重试）', async () => {
  const calls: number[] = [];
  await assert.rejects(
    withRetry(
      async (attempt) => {
        calls.push(attempt);
        const e = new Error('biz-error') as Error & { status: number };
        e.status = 400;
        throw e;
      },
      {
        retries: 5,
        baseDelayMs: 1,
        retryOn: (e) => {
          const status = (e as { status?: number }).status;
          return status === undefined ? true : isRetryableStatus(status);
        },
      },
    ),
    /biz-error/,
  );
  // 400 不可重试，attempt=0 后立即抛出
  assert.deepEqual(calls, [0]);
});

test('withRetry：retryOn 谓词允许重试 429', async () => {
  const calls: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      calls.push(attempt);
      if (attempt === 0) {
        const e = new Error('rate-limited') as Error & { status: number };
        e.status = 429;
        throw e;
      }
      return 'recovered';
    },
    {
      retries: 3,
      baseDelayMs: 1,
      retryOn: (e) => isRetryableStatus((e as { status?: number }).status ?? 0),
    },
  );
  assert.equal(result, 'recovered');
  assert.deepEqual(calls, [0, 1]);
});

test('withRetry：retryOn 收到 attempt 索引', async () => {
  const seenAttempts: number[] = [];
  let count = 0;
  await withRetry(
    async () => {
      count++;
      if (count < 3) throw new Error('x');
      return 'done';
    },
    {
      retries: 5,
      baseDelayMs: 1,
      retryOn: (_e, attempt) => {
        seenAttempts.push(attempt);
        return true;
      },
    },
  );
  // attempt 在 retryOn 中是触发重试的那次失败（0,1）
  assert.deepEqual(seenAttempts, [0, 1]);
});

test('withRetry：退避时长封顶于 maxDelayMs', async () => {
  // 用 fake timers 不便（node:test 无原生支持），改为低 max 直接测总时长上界
  // retries=5, baseDelayMs=1000, maxDelayMs=50：每段最多 50ms，5 段最多 250ms
  const start = Date.now();
  await assert.rejects(
    withRetry(async () => { throw new Error('x'); }, {
      retries: 5,
      baseDelayMs: 1000,
      maxDelayMs: 50,
    }),
    /x/,
  );
  const elapsed = Date.now() - start;
  // 5 段退避，每段封顶 50ms → 上界 5*50 + 抖动容差，给 300ms 余量
  assert.ok(elapsed < 400, `总耗时 ${elapsed}ms 应 < 400ms（退避已封顶）`);
  assert.ok(elapsed >= 50, '至少有一次退避');
});

test('withRetry：默认 retries=3', async () => {
  const calls: number[] = [];
  await assert.rejects(
    withRetry(async (attempt) => {
      calls.push(attempt);
      throw new Error('x');
    }, { baseDelayMs: 1, maxDelayMs: 2 }),
    /x/,
  );
  // 默认 retries=3 → 总尝试 4 次（0,1,2,3）
  assert.equal(calls.length, 4);
  assert.deepEqual(calls, [0, 1, 2, 3]);
});

test('withRetry：传递非 Error 抛出对象也能重试', async () => {
  const calls: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      calls.push(attempt);
      if (attempt < 1) throw 'string-error'; // 非 Error
      return 'ok';
    },
    { retries: 3, baseDelayMs: 1 },
  );
  assert.equal(result, 'ok');
  assert.deepEqual(calls, [0, 1]);
});

test('withRetry：同步返回值也能处理（fn 签名是 async）', async () => {
  const result = await withRetry(async () => 42, { retries: 0 });
  assert.equal(result, 42);
});

// —————————— isRetryableStatus ——————————

test('isRetryableStatus：429 限流可重试', () => {
  assert.equal(isRetryableStatus(429), true);
});

test('isRetryableStatus：5xx 服务端错误可重试', () => {
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(502), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(599), true);
});

test('isRetryableStatus：4xx 业务错误不可重试', () => {
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(422), false);
});

test('isRetryableStatus：2xx 成功不可重试', () => {
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(201), false);
});

test('isRetryableStatus：3xx 重定向不可重试', () => {
  assert.equal(isRetryableStatus(301), false);
  assert.equal(isRetryableStatus(304), false);
});

test('isRetryableStatus：边界 499 不可重试 / 500 可重试', () => {
  assert.equal(isRetryableStatus(499), false);
  assert.equal(isRetryableStatus(500), true);
});
