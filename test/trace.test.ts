/**
 * trace.ts Span 可观测性的测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Tracer, costOf, renderSpanTree, ZERO_USAGE } from '../src/trace.ts';
import type { TokenUsage } from '../src/types.ts';

async function tick(ms = 2): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test('启用时：嵌套 span 建立父子关系', async () => {
  const t = new Tracer(true);
  const run = t.startSpan('run');
  await tick();
  const step = t.startSpan('step');
  await tick();
  const llm = t.startSpan('llm');
  await tick();
  t.endSpan(llm);
  t.endSpan(step);
  t.endSpan(run);

  const root = t.getRoot();
  assert.ok(root);
  assert.equal(root!.name, 'run');
  assert.equal(root!.children.length, 1);
  assert.equal(root!.children[0]!.name, 'step');
  assert.equal(root!.children[0]!.children[0]!.name, 'llm');
});

test('结束的 span 有正的时长', async () => {
  const t = new Tracer(true);
  const s = t.startSpan('x');
  await tick(5);
  t.endSpan(s);
  assert.ok((s.end ?? 0) - s.start > 0);
});

test('totalUsage 聚合所有 llm span 的 usage', async () => {
  const t = new Tracer(true);
  const run = t.startSpan('run');
  const u1: TokenUsage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
  const u2: TokenUsage = { promptTokens: 200, completionTokens: 30, totalTokens: 230 };

  const s1 = t.startSpan('llm');
  t.setUsage(s1, u1);
  t.endSpan(s1);

  const s2 = t.startSpan('llm');
  t.setUsage(s2, u2);
  t.endSpan(s2);

  t.endSpan(run);
  const total = t.totalUsage();
  assert.equal(total.promptTokens, 300);
  assert.equal(total.completionTokens, 50);
  assert.equal(total.totalTokens, 350);
});

test('setError 标记 span 状态', () => {
  const t = new Tracer(true);
  const s = t.startSpan('tool');
  t.setError(s);
  t.endSpan(s);
  assert.equal(s.status, 'error');
});

test('totalDurationMs：根 span 时长', async () => {
  const t = new Tracer(true);
  const run = t.startSpan('run');
  await tick(10);
  t.endSpan(run);
  assert.ok(t.totalDurationMs() > 0);
});

test('关闭时：startSpan/endSpan 退化为 no-op，getRoot 返回 null', () => {
  const t = new Tracer(false);
  const s = t.startSpan('run');
  t.endSpan(s);
  t.setUsage(s, ZERO_USAGE);
  assert.equal(t.getRoot(), null);
  assert.equal(t.isEnabled, false);
});

test('costOf：按 /1K 价格计算成本', () => {
  const usage: TokenUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
  const cost = costOf(usage, 0.001, 0.002); // 1K 输入 $0.001，1K 输出 $0.002
  assert.equal(cost, 0.001 * 1 + 0.002 * 0.5);
});

test('renderSpanTree：渲染含层级与属性', async () => {
  const t = new Tracer(true);
  const run = t.startSpan('run');
  const step = t.startSpan('step', { n: 1 });
  const llm = t.startSpan('llm');
  t.setUsage(llm, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  t.endSpan(llm);
  t.endSpan(step);
  t.endSpan(run);
  const text = renderSpanTree(t.getRoot());
  assert.match(text, /run/);
  assert.match(text, /step/);
  assert.match(text, /llm/);
  assert.match(text, /tokens=15/);
});
