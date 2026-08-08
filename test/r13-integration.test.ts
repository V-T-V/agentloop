/**
 * R13-D10（agentloop）：综合集成测试——把 R13 的 5 个新模块串起来。
 *
 * 模拟一次完整的 runLoop 诊断流程：
 *   trace span → summarizeLoop → aggregateToolStats → forecastBudget → 健康判定
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Span } from '../src/trace.ts';
import type { TokenUsage } from '../src/types.ts';
import { summarizeLoop, isHealthyRun, efficiencyRating } from '../src/loop-stats.ts';
import { aggregateToolStats, identifyProblemTools } from '../src/tool-stats.ts';
import { forecastBudget } from '../src/budget-forecast.ts';
import { checkCheckpointHealth, canRestore } from '../src/checkpoint-health.ts';

function span(over: Partial<Span> = {}): Span {
  return {
    id: `s${Math.random().toString(36).slice(2, 6)}`,
    name: 'test',
    parentId: null,
    start: 0,
    end: 100,
    status: 'ok',
    attributes: {},
    children: [],
    ...over,
  };
}

function usage(t: number): TokenUsage {
  return { promptTokens: Math.floor(t * 0.7), completionTokens: Math.floor(t * 0.3), totalTokens: t };
}

describe('R13 综合集成', () => {
  test('完整诊断流程（健康运行）', () => {
    // 构造一次健康的 3 步运行
    const root = span({
      id: 'run',
      name: 'run',
      start: 0,
      end: 5000,
      children: [
        span({ name: 'step', start: 0, end: 1500, attributes: { step: 1 } }),
        span({ name: 'llm', usage: usage(800) }),
        span({ name: 'tool', attributes: { name: 'search' } }),
        span({ name: 'step', start: 1500, end: 3000, attributes: { step: 2 } }),
        span({ name: 'llm', usage: usage(600) }),
        span({ name: 'tool', attributes: { name: 'http_get' } }),
        span({ name: 'step', start: 3000, end: 4500, attributes: { step: 3 } }),
        span({ name: 'llm', usage: usage(400) }),
        span({ name: 'final' }),
      ],
    });

    // 1. 运行摘要
    const summary = summarizeLoop(root);
    assert.equal(summary.steps, 3);
    assert.equal(summary.completed, true);
    assert.equal(summary.errors, 0);

    // 2. 健康判定
    assert.ok(isHealthyRun(summary));

    // 3. 效率
    const rating = efficiencyRating(summary);
    assert.ok(['高效', '正常', '低效'].includes(rating));

    // 4. 工具统计（需要 flatten）
    const allSpans = [root, ...root.children];
    const toolReport = aggregateToolStats(allSpans);
    assert.ok(toolReport.totalCalls >= 2);
    assert.equal(toolReport.overallSuccessRate, 1); // 全成功

    // 5. 预算预测
    const budget = forecastBudget({
      spent: summary.totalTokens,
      limit: 100000,
      steps: summary.steps,
      elapsedMs: summary.durationMs,
    });
    assert.ok(budget.action === '继续'); // 只用了少量 token
  });

  test('问题运行诊断（有错误）', () => {
    const root = span({
      name: 'run',
      start: 0,
      end: 10000,
      children: [
        span({ name: 'step' }),
        span({ name: 'tool', attributes: { name: 'broken_api' }, status: 'error' }),
        span({ name: 'tool', attributes: { name: 'broken_api' }, status: 'error' }),
        span({ name: 'tool', attributes: { name: 'broken_api' }, status: 'error' }),
        span({ name: 'error' }),
      ],
    });

    const summary = summarizeLoop(root);
    assert.ok(summary.errors >= 1);

    const allSpans = [root, ...root.children];
    const toolReport = aggregateToolStats(allSpans);
    const problems = identifyProblemTools(toolReport);
    assert.ok(problems.some((t) => t.name === 'broken_api'));

    // 有错误 → 不健康
    assert.ok(!isHealthyRun(summary));
  });

  test('预算耗尽场景', () => {
    const root = span({
      name: 'run',
      start: 0,
      end: 60000,
      children: [
        span({ name: 'step' }),
        span({ name: 'llm', usage: usage(50000) }), // 大量 token
      ],
    });

    const summary = summarizeLoop(root);
    const budget = forecastBudget({
      spent: summary.totalTokens,
      limit: 50000, // 恰好耗尽
      steps: summary.steps,
      elapsedMs: summary.durationMs,
    });
    assert.equal(budget.action, '停止');
    assert.equal(budget.remaining, 0);
  });

  test('检查点恢复流程', () => {
    // 模拟一个从检查点恢复的场景
    const cp = {
      version: 1,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '继续' },
        { role: 'assistant', content: '好的' },
      ],
      totalUsage: usage(1000),
      step: 5,
    };

    const report = checkCheckpointHealth(cp);
    assert.equal(report.health, 'healthy');
    assert.ok(canRestore(report));
  });

  test('损坏检查点不可恢复', () => {
    const report = checkCheckpointHealth({ version: 'bad', messages: null });
    assert.equal(report.health, 'corrupt');
    assert.ok(!canRestore(report));
  });

  test('空数据全模块不崩溃', () => {
    assert.equal(summarizeLoop(null).steps, 0);
    assert.equal(aggregateToolStats([]).totalCalls, 0);
    const f = forecastBudget({ spent: 0, limit: 1000, steps: 0, elapsedMs: 0 });
    assert.equal(f.action, '继续');
    const r = checkCheckpointHealth(null);
    assert.equal(r.health, 'corrupt');
  });
});
