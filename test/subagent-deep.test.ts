/**
 * subagent.ts 深层路径测试（R10-D6）。
 *
 * 回归测试：LOOP_SUBAGENT_TIMEOUT_MS=0（不超时）被旧实现
 * `Number(env('...', '30000')) || 30000` 当 falsy 吞成 30000 的 bug。
 *
 * 同时覆盖：
 *   - resolveSubAgentFanoutOptions 默认值（timeout 30000 / maxConcurrency 0）
 *   - LOOP_SUBAGENT_MAX_CONCURRENT=N 正确读取
 *   - 合法 0 不被吞（timeout=0 → 0，maxConcurrency=0 → 0）
 *   - 非法值（空串/abc）回退默认
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSubAgentFanoutOptions } from '../src/subagent.ts';

function withEnv(env: Record<string, string>, fn: () => void): void {
  const backup: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    backup[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('默认值：未设环境变量时 timeout=30000, maxConcurrency=0', () => {
  withEnv(
    { LOOP_SUBAGENT_TIMEOUT_MS: '', LOOP_SUBAGENT_MAX_CONCURRENT: '' },
    () => {
      // 空串 env() 返回 fallback，envInt 用默认
      const opt = resolveSubAgentFanoutOptions();
      assert.equal(opt.timeoutMs, 30000);
      assert.equal(opt.maxConcurrency, 0);
    },
  );
});

test('回归：LOOP_SUBAGENT_TIMEOUT_MS=0 不被吞成默认 30000（修 Number(env)||d bug）', () => {
  withEnv({ LOOP_SUBAGENT_TIMEOUT_MS: '0', LOOP_SUBAGENT_MAX_CONCURRENT: '' }, () => {
    const opt = resolveSubAgentFanoutOptions();
    assert.equal(opt.timeoutMs, 0, '合法的 0（=不超时）必须保留，不能吞成 30000');
  });
});

test('LOOP_SUBAGENT_TIMEOUT_MS=N 正确读取', () => {
  withEnv({ LOOP_SUBAGENT_TIMEOUT_MS: '12345', LOOP_SUBAGENT_MAX_CONCURRENT: '' }, () => {
    const opt = resolveSubAgentFanoutOptions();
    assert.equal(opt.timeoutMs, 12345);
  });
});

test('LOOP_SUBAGENT_MAX_CONCURRENT=N 正确读取', () => {
  withEnv({ LOOP_SUBAGENT_TIMEOUT_MS: '', LOOP_SUBAGENT_MAX_CONCURRENT: '4' }, () => {
    const opt = resolveSubAgentFanoutOptions();
    assert.equal(opt.maxConcurrency, 4);
  });
});

test('LOOP_SUBAGENT_MAX_CONCURRENT=0 正确保留（=不限制）', () => {
  withEnv({ LOOP_SUBAGENT_TIMEOUT_MS: '', LOOP_SUBAGENT_MAX_CONCURRENT: '0' }, () => {
    const opt = resolveSubAgentFanoutOptions();
    assert.equal(opt.maxConcurrency, 0, '合法的 0（=不限制）必须保留');
  });
});

test('非法值（abc）回退默认（envInt 对 NaN 回退）', () => {
  withEnv({ LOOP_SUBAGENT_TIMEOUT_MS: 'abc', LOOP_SUBAGENT_MAX_CONCURRENT: 'xyz' }, () => {
    const opt = resolveSubAgentFanoutOptions();
    // envInt 内部：Number('abc')=NaN → 不是有限数 → 回退 fallback
    assert.equal(opt.timeoutMs, 30000);
    assert.equal(opt.maxConcurrency, 0);
  });
});

test('负数 timeout 被 envInt 的 min=0 钳制为 0', () => {
  // envInt(key, fallback, min) 对小于 min 的值取 max
  withEnv({ LOOP_SUBAGENT_TIMEOUT_MS: '-5', LOOP_SUBAGENT_MAX_CONCURRENT: '' }, () => {
    const opt = resolveSubAgentFanoutOptions();
    assert.ok(opt.timeoutMs >= 0, `timeoutMs 不应为负（实际 ${opt.timeoutMs}）`);
  });
});
