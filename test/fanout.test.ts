/**
 * fanout.ts 并行扇出编排器的测试。
 *
 * 验证：并发执行（总耗时≈最慢而非之和）、落后者超时、部分失败隔离、结果聚合。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fanOut, type FanOutTask } from '../src/fanout.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('并发执行：总耗时约等于最慢任务，而非之和', async () => {
  const tasks: FanOutTask[] = [
    { id: 'a', input: '50ms' },
    { id: 'b', input: '100ms' },
    { id: 'c', input: '80ms' },
  ];
  const runner = async (t: FanOutTask) => {
    const ms = Number(t.input);
    await sleep(ms);
    return `${t.id} done`;
  };
  const start = performance.now();
  const r = await fanOut(tasks, runner, { timeoutMs: 1000 });
  const elapsed = performance.now() - start;
  assert.equal(r.succeeded, 3);
  // 并发：应远小于 50+100+80=230ms（给些余量，<200ms 说明是并发）
  assert.ok(elapsed < 200, `期望并发 <200ms，实际 ${elapsed.toFixed(0)}ms`);
});

test('落后者超时：超时的任务标记失败，不拖垮全局', async () => {
  const tasks: FanOutTask[] = [
    { id: 'fast', input: '10' },
    { id: 'slow', input: '500' }, // 会超时
  ];
  const runner = async (t: FanOutTask, signal: AbortSignal) => {
    const ms = Number(t.input);
    await sleep(ms);
    if (signal.aborted) throw new Error('被中断');
    return `${t.id} ok`;
  };
  const start = performance.now();
  const r = await fanOut(tasks, runner, { timeoutMs: 80 });
  const elapsed = performance.now() - start;
  assert.equal(r.succeeded, 1);
  assert.equal(r.failed, 1);
  const fast = r.results.find((x) => x.id === 'fast')!;
  assert.equal(fast.ok, true);
  const slow = r.results.find((x) => x.id === 'slow')!;
  assert.equal(slow.ok, false);
  assert.match(slow.output, /超时/);
  // 全局不应被慢任务拖到 500ms
  assert.ok(elapsed < 250, `期望超时及早返回 <250ms，实际 ${elapsed.toFixed(0)}ms`);
});

test('部分失败隔离：一个抛错不影响其他', async () => {
  const tasks: FanOutTask[] = [
    { id: 'ok1', input: 'good' },
    { id: 'boom', input: 'bad' },
    { id: 'ok2', input: 'good' },
  ];
  const runner = async (t: FanOutTask) => {
    if (t.input === 'bad') throw new Error('故意爆炸');
    return `${t.id} 成功`;
  };
  const r = await fanOut(tasks, runner, { timeoutMs: 1000 });
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 1);
  const boom = r.results.find((x) => x.id === 'boom')!;
  assert.equal(boom.ok, false);
  assert.match(boom.output, /故意爆炸/);
  // 成功的不受影响
  assert.equal(r.results.find((x) => x.id === 'ok1')!.ok, true);
});

test('全部成功：summary 列出每项', async () => {
  const tasks: FanOutTask[] = [
    { id: 'a', input: 'x' },
    { id: 'b', input: 'y' },
  ];
  const r = await fanOut(tasks, async (t) => `结果-${t.id}`, { timeoutMs: 1000 });
  assert.equal(r.succeeded, 2);
  assert.match(r.summary, /成功 2/);
  assert.match(r.summary, /结果-a/);
  assert.match(r.summary, /结果-b/);
});

test('空任务列表：返回空结果', async () => {
  const r = await fanOut([], async () => 'x');
  assert.equal(r.results.length, 0);
  assert.equal(r.succeeded, 0);
  assert.equal(r.failed, 0);
});

test('durationMs：成功项记录正耗时', async () => {
  const r = await fanOut(
    [{ id: 'a', input: '' }],
    async () => {
      await sleep(30);
      return 'done';
    },
    { timeoutMs: 1000 },
  );
  assert.ok(r.results[0]!.durationMs >= 20);
});
