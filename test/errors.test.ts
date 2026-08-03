/**
 * errors.ts 测试 —— 结构化 HTTP 错误类。
 *
 * 覆盖：
 *   - LlmHttpError 字段：name / status / message / stack
 *   - 错误消息格式（"LLM 请求失败 {status}: {detail}"）
 *   - instanceof Error 与 instanceof LlmHttpError 判定
 *   - 与 isRetryableStatus 协同：429/5xx 可重试、4xx 不可重试
 *   - 与 withRetry 的 retryOn 集成：按 status 决定重试
 *   - 不同 status 构造的实例互不干扰
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmHttpError } from '../src/errors.ts';
import { withRetry, isRetryableStatus } from '../src/retry.ts';

test('LlmHttpError：基本字段 status/message/name', () => {
  const err = new LlmHttpError(500, '服务端错误');
  assert.equal(err.status, 500);
  assert.equal(err.name, 'LlmHttpError');
  assert.equal(err.message, 'LLM 请求失败 500: 服务端错误');
});

test('LlmHttpError：是 Error 的实例', () => {
  const err = new LlmHttpError(429, '限流');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof LlmHttpError);
});

test('LlmHttpError：含 stack 信息', () => {
  const err = new LlmHttpError(503, '不可用');
  assert.ok(typeof err.stack === 'string');
  assert.ok(err.stack!.length > 0);
});

test('LlmHttpError：不同 status 不互相干扰', () => {
  const a = new LlmHttpError(400, 'bad');
  const b = new LlmHttpError(500, 'server');
  assert.equal(a.status, 400);
  assert.equal(b.status, 500);
  assert.notEqual(a.message, b.message);
});

test('LlmHttpError：detail 含特殊字符保留原样', () => {
  const err = new LlmHttpError(401, '未授权: token={abc} 中文');
  assert.equal(err.message, 'LLM 请求失败 401: 未授权: token={abc} 中文');
});

test('LlmHttpError：detail 为空字符串', () => {
  const err = new LlmHttpError(502, '');
  assert.equal(err.message, 'LLM 请求失败 502: ');
  assert.equal(err.status, 502);
});

test('LlmHttpError：JSON.stringify 输出 status/name（message 不可枚举）', () => {
  const err = new LlmHttpError(500, 'x');
  const serialized = JSON.stringify(err);
  // status 是实例字段（可枚举），name 通过类赋值（可枚举）
  // Error 基类的 message/stack 不可枚举，标准 JSON.stringify 不输出
  const parsed = JSON.parse(serialized) as { status?: number; name?: string };
  assert.equal(parsed.status, 500);
  assert.equal(parsed.name, 'LlmHttpError');
  assert.ok(!('message' in parsed), 'message 不可枚举，不被序列化');
  // 但 message 属性可读
  assert.ok(err.message.includes('500'));
});

test('LlmHttpError：toString 输出 name: message', () => {
  const err = new LlmHttpError(404, '未找到');
  const str = err.toString();
  assert.ok(str.startsWith('LlmHttpError:'));
  assert.ok(str.includes('404'));
});

test('集成：status=429 经 isRetryableStatus 判定可重试', () => {
  const err = new LlmHttpError(429, 'rate');
  assert.equal(isRetryableStatus(err.status), true);
});

test('集成：status=400 经 isRetryableStatus 判定不可重试', () => {
  const err = new LlmHttpError(400, 'bad request');
  assert.equal(isRetryableStatus(err.status), false);
});

test('集成：withRetry + retryOn 按 LlmHttpError.status 重试', async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new LlmHttpError(503, '不可用');
      return 'ok';
    },
    {
      retries: 5,
      baseDelayMs: 1,
      retryOn: (e) => e instanceof LlmHttpError && isRetryableStatus(e.status),
    },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('集成：withRetry 对 400 LlmHttpError 立即抛出不重试', async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts++;
        throw new LlmHttpError(400, 'bad');
      },
      {
        retries: 5,
        baseDelayMs: 1,
        retryOn: (e) => e instanceof LlmHttpError && isRetryableStatus(e.status),
      },
    ),
    /LLM 请求失败 400/,
  );
  assert.equal(attempts, 1);
});

test('集成：retryOn 区分 LlmHttpError 与普通 Error', async () => {
  let attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts++;
        // 普通 Error（无 status）→ retryOn 返回 false（因 instanceof 检查失败）
        throw new Error('network-blip');
      },
      {
        retries: 5,
        baseDelayMs: 1,
        retryOn: (e) => e instanceof LlmHttpError && isRetryableStatus(e.status),
      },
    ),
    /network-blip/,
  );
  // 普通 Error 不满足 retryOn 谓词 → 立即抛出
  assert.equal(attempts, 1);
});

test('LlmHttpError：可读地嵌入 catch 逻辑（typeof guard）', () => {
  function classify(e: unknown): string {
    if (e instanceof LlmHttpError) {
      return `http-${e.status}`;
    }
    return 'unknown';
  }
  assert.equal(classify(new LlmHttpError(429, 'r')), 'http-429');
  assert.equal(classify(new Error('x')), 'unknown');
  assert.equal(classify('string'), 'unknown');
  assert.equal(classify(null), 'unknown');
});
