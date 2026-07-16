/**
 * iterate.ts 迭代工具的测试。
 *
 * 重点：Collatz 分支步进收敛（这正是 v2 任务失败的关键场景）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { iterateTool } from '../src/tools/iterate.ts';

test('Collatz 分支步进：n=7 收敛到 1', async () => {
  const r = await iterateTool.execute({
    start: 7,
    stepOdd: '3*x+1',
    stepEven: 'x/2',
    stopWhen: { equals: 1 },
  });
  assert.equal(r.ok, true);
  assert.match(r.output, /收敛到 1/);
  // n=7 的 Collatz 序列长度应为 17（含起点 7 和终点 1）
  assert.match(r.output, /序列长度 17/);
});

test('Collatz：n=27 收敛（序列较长，验证截断展示）', async () => {
  const r = await iterateTool.execute({
    start: 27,
    stepOdd: '3*x+1',
    stepEven: 'x/2',
    stopWhen: { equals: 1 },
  });
  assert.equal(r.ok, true);
  assert.match(r.output, /收敛到 1/);
  // n=27 序列有 112 项，应触发截断展示
  assert.match(r.output, /共 112 项/);
});

test('统一步进：累加斐波那契式（x+x 用不了，改用 2*x 验证倍增）', async () => {
  const r = await iterateTool.execute({
    start: 1,
    step: '2*x',
    stopWhen: { greaterThan: 100 },
  });
  assert.equal(r.ok, true);
  assert.match(r.output, /\[1, 2, 4, 8, 16, 32, 64, 128\]/);
});

test('统一步进：等于目标停止', async () => {
  const r = await iterateTool.execute({
    start: 2,
    step: 'x+3',
    stopWhen: { equals: 11 },
  });
  assert.equal(r.ok, true);
  assert.match(r.output, /收敛到 11/);
  assert.match(r.output, /\[2, 5, 8, 11\]/);
});

test('达到 maxIter 未收敛', async () => {
  const r = await iterateTool.execute({
    start: 1,
    step: 'x+1',
    stopWhen: { equals: 1000 },
    maxIter: 5,
  });
  assert.equal(r.ok, true);
  assert.match(r.output, /达到迭代上限未收敛/);
});

test('缺少步进表达式 → 失败', async () => {
  const r = await iterateTool.execute({
    start: 5,
    stopWhen: { equals: 1 },
  });
  assert.equal(r.ok, false);
  assert.match(r.output, /step|stepOdd/);
});

test('非法表达式（含代码注入字符）→ 失败，不执行任意代码', async () => {
  const r = await iterateTool.execute({
    start: 1,
    step: 'x+1);process.exit(1',
    stopWhen: { equals: 5 },
  });
  assert.equal(r.ok, false);
});

test('非有限数（除零抛错）→ 失败，不执行任意代码', async () => {
  const r = await iterateTool.execute({
    start: 1,
    step: 'x/(x-x)', // 1/0 在 calculator 里抛「除零错误」
    stopWhen: { equals: 5 },
    maxIter: 3,
  });
  assert.equal(r.ok, false);
  assert.match(r.output, /除零错误|非有限数/);
});
