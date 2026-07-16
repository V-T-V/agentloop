/**
 * long-task.ts 的 Karpathy Rule 3 + Rule 4 测试。
 *
 * Rule 3「Fixed time window」：阶段时间预算超时 → 抛 TimeoutError，不重试。
 * Rule 4「Keep only improvements」：BestTracker 贪心爬山，仅更优时覆盖 best-result.json。
 *
 * TimeoutError 直接测试（无需真跑 LLM）；BestTracker 用临时目录测试打分/比对/保留。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BestTracker, TimeoutError, runLoopWithRetry } from '../src/long-task.ts';
import { runLoop } from '../src/loop.ts';
import { CheckpointStore } from '../src/checkpoint.ts';
import type { ChatResult, LLMClient } from '../src/types.ts';

const U = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

/** 快速收敛的假 LLM（1 步直接回答） */
function quickLLM(answer: string): LLMClient {
  return {
    isStub: true,
    supportsStream: false,
    async chat(): Promise<ChatResult> {
      return { message: { role: 'assistant', content: answer }, usage: U };
    },
    async chatStream(): Promise<ChatResult> {
      return { message: { role: 'assistant', content: answer }, usage: U };
    },
  };
}

/** 永不返回的假 LLM（模拟卡死，触发超时） */
function hangingLLM(): LLMClient {
  const never = new Promise<ChatResult>(() => {});
  return {
    isStub: true,
    supportsStream: false,
    async chat(): Promise<ChatResult> {
      return never;
    },
    async chatStream(): Promise<ChatResult> {
      return never;
    },
  };
}

async function tmpDir(): Promise<[string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'agentloop-lt-'));
  return [dir, () => rm(dir, { recursive: true, force: true })];
}

// —————————— Rule 3：时间预算超时 ——————————

test('Rule 3：TimeoutError 在时间预算耗尽时抛出', () => {
  const e = new TimeoutError('test');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'TimeoutError');
  assert.equal(e.message, 'test');
});

test('Rule 3：runLoopWithRetry 超时后抛 TimeoutError（不重试）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    // hangingLLM 永不返回 → 50ms 后必然超时
    await assert.rejects(
      runLoopWithRetry(
        {
          llm: hangingLLM(),
          tools: [],
          system: 'sys',
          user: 'x',
          stream: false,
          durable: { runId: 'timeout-test', store },
        },
        { timeoutMs: 50, maxRetries: 3 },
      ),
      (err: unknown) => {
        assert.ok(err instanceof TimeoutError, '应抛 TimeoutError');
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test('Rule 3：未超时时正常返回（时间预算足够）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    const result = await runLoopWithRetry(
      {
        llm: quickLLM('快速答案'),
        tools: [],
        system: 'sys',
        user: 'x',
        stream: false,
        durable: { runId: 'fast-test', store },
      },
      { timeoutMs: 5000, maxRetries: 3 },
    );
    assert.equal(result.answer, '快速答案');
    assert.equal(result.stopReason, 'final');
  } finally {
    await cleanup();
  }
});

// —————————— Rule 4：BestTracker 最佳保留 ——————————

test('Rule 4：首次运行直接成为 best', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const tracker = new BestTracker(dir, 't1', true);
    const updated = await tracker.maybeUpdate('答案A', 80);
    assert.ok(updated, '首次应成为 best');
    const best = await tracker.current();
    assert.ok(best);
    assert.equal(best!.answer, '答案A');
    assert.equal(best!.score, 80);
  } finally {
    await cleanup();
  }
});

test('Rule 4：更优分数覆盖 best（higherIsBetter=true）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const tracker = new BestTracker(dir, 't2', true);
    await tracker.maybeUpdate('答案A', 80);
    const updated = await tracker.maybeUpdate('答案B', 90);
    assert.ok(updated, '90 > 80 应更新');
    const best = await tracker.current();
    assert.equal(best!.answer, '答案B');
    assert.equal(best!.score, 90);
  } finally {
    await cleanup();
  }
});

test('Rule 4：劣化分数不覆盖 best（贪心爬山保护）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const tracker = new BestTracker(dir, 't3', true);
    await tracker.maybeUpdate('答案A', 90);
    const updated = await tracker.maybeUpdate('答案B', 70);
    assert.ok(!updated, '70 < 90 不应更新');
    const best = await tracker.current();
    assert.equal(best!.answer, '答案A', '仍是旧的 best');
    assert.equal(best!.score, 90);
  } finally {
    await cleanup();
  }
});

test('Rule 4：higherIsBetter=false 时低分更优', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const tracker = new BestTracker(dir, 't4', false);
    await tracker.maybeUpdate('答案A', 90);
    const updated = await tracker.maybeUpdate('答案B', 70);
    assert.ok(updated, '低分更优场景下 70 < 90 应更新');
    const best = await tracker.current();
    assert.equal(best!.score, 70);
  } finally {
    await cleanup();
  }
});

test('Rule 4：打分表达式求值（answer.length）', () => {
  const score = BestTracker.score('answer.length', 'hello world', '');
  assert.equal(score, 11);
});

test('Rule 4：打分表达式非法时返回 0（不崩）', () => {
  const score = BestTracker.score('answer.undefined.prop', 'x', '');
  assert.equal(score, 0, '非法表达式返回 0');
});

test('Rule 4：打分表达式非数字返回 0', () => {
  const score = BestTracker.score('"not a number"', 'x', '');
  assert.equal(score, 0, '非数字返回 0');
});

test('Rule 4：best-result.json 损坏时 current() 返回 null', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    await writeFile(join(dir, 'best-result.json'), '坏 JSON', 'utf8');
    const tracker = new BestTracker(dir, 't5', true);
    const best = await tracker.current();
    assert.equal(best, null);
  } finally {
    await cleanup();
  }
});

test('Rule 4：best-result.json 不存在时 current() 返回 null', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const tracker = new BestTracker(dir, 't6', true);
    const best = await tracker.current();
    assert.equal(best, null);
    assert.ok(!existsSync(join(dir, 'best-result.json')));
  } finally {
    await cleanup();
  }
});

// —————————— 集成：runLoop 完成后 BestTracker 联动 ——————————

test('集成：runLoop 正常完成后可被 BestTracker 评分', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    const result = await runLoop({
      llm: quickLLM('这是一个包含5个数字12345的答案'),
      tools: [],
      system: 'sys',
      user: 'x',
      stream: false,
      durable: { runId: 'score-integration', store },
    });
    // 用「答案中的数字个数」作为分数
    const expr = '(answer.match(/\\d+/g) || []).length';
    const score = BestTracker.score(expr, result.answer, '');
    assert.equal(score, 2, '答案中有 2 组数字（5 和 12345）');

    const tracker = new BestTracker(dir, 'integration', true);
    const updated = await tracker.maybeUpdate(result.answer, score);
    assert.ok(updated);
    const best = await tracker.current();
    assert.equal(best!.score, 2);
  } finally {
    await cleanup();
  }
});
