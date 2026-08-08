/**
 * R13-D6（agentloop）：loop-stats.ts 运行统计摘要器测试。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLoop, isHealthyRun, efficiencyRating } from '../src/loop-stats.ts';
import type { Span } from '../src/trace.ts';
import type { TokenUsage } from '../src/types.ts';

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

/** 构造一次完整 runLoop 的 span 树 */
function makeRun(over: { steps?: number; tools?: number; errors?: number; compacts?: number; completed?: boolean; durationMs?: number } = {}): Span {
  const { steps = 3, tools = 2, errors = 0, compacts = 0, completed = true, durationMs = 1000 } = over;
  const children: Span[] = [];
  for (let i = 0; i < steps; i++) {
    children.push(span({ id: `step${i}`, name: 'step', start: i * 100, end: i * 100 + 80 }));
  }
  for (let i = 0; i < tools; i++) {
    const status = i < errors ? 'error' : 'ok';
    children.push(span({ id: `tool${i}`, name: 'tool', status: status as Span['status'] }));
  }
  for (let i = 0; i < compacts; i++) {
    children.push(span({ id: `compact${i}`, name: 'compact' }));
  }
  if (completed) {
    children.push(span({ id: 'final', name: 'final' }));
  }
  return span({
    id: 'run',
    name: 'run',
    start: 0,
    end: durationMs,
    children,
  });
}

describe('summarizeLoop', () => {
  test('null → 空摘要', () => {
    const s = summarizeLoop(null);
    assert.equal(s.steps, 0);
    assert.equal(s.durationMs, 0);
    assert.equal(s.summary, '无运行数据');
  });

  test('基本统计', () => {
    const s = summarizeLoop(makeRun({ steps: 3, tools: 2 }));
    assert.equal(s.steps, 3);
    assert.equal(s.toolCalls, 2);
    assert.equal(s.toolSuccess, 2);
    assert.equal(s.completed, true);
  });

  test('耗时计算', () => {
    const s = summarizeLoop(makeRun({ durationMs: 5000 }));
    assert.equal(s.durationMs, 5000);
  });

  test('未结束的 run → durationMs=0', () => {
    const root = span({ name: 'run', end: null, children: [] });
    const s = summarizeLoop(root);
    assert.equal(s.durationMs, 0);
  });

  test('错误计数', () => {
    const s = summarizeLoop(makeRun({ tools: 3, errors: 1 }));
    assert.equal(s.errors, 1);
    assert.equal(s.toolSuccess, 2);
  });

  test('压缩计数', () => {
    const s = summarizeLoop(makeRun({ compacts: 2 }));
    assert.equal(s.compacts, 2);
  });

  test('未完成（无 final）→ completed=false', () => {
    const s = summarizeLoop(makeRun({ completed: false }));
    assert.equal(s.completed, false);
  });

  test('token 汇总', () => {
    const root = span({
      name: 'run',
      children: [
        span({ name: 'llm', usage: usage(500) }),
        span({ name: 'llm', usage: usage(300) }),
      ],
    });
    const s = summarizeLoop(root);
    assert.equal(s.totalTokens, 800);
  });

  test('slowestStepMs', () => {
    const root = span({
      name: 'run',
      children: [
        span({ name: 'step', start: 0, end: 100 }),
        span({ name: 'step', start: 100, end: 400 }), // 300ms 最慢
        span({ name: 'step', start: 400, end: 450 }),
      ],
    });
    const s = summarizeLoop(root);
    assert.equal(s.slowestStepMs, 300);
  });
});

describe('summarizeLoop summary 文本', () => {
  test('含步数', () => {
    const s = summarizeLoop(makeRun({ steps: 5 }));
    assert.match(s.summary, /5 步/);
  });

  test('含耗时（秒）', () => {
    const s = summarizeLoop(makeRun({ durationMs: 2300 }));
    assert.match(s.summary, /2\.3s/);
  });

  test('含耗时（毫秒，<1s）', () => {
    const s = summarizeLoop(makeRun({ durationMs: 500 }));
    assert.match(s.summary, /500ms/);
  });

  test('完成 → ✅', () => {
    const s = summarizeLoop(makeRun({ completed: true }));
    assert.match(s.summary, /✅/);
  });

  test('未完成 → ⚠️', () => {
    const s = summarizeLoop(makeRun({ completed: false }));
    assert.match(s.summary, /⚠️/);
  });

  test('有工具 → 含工具调用数', () => {
    const s = summarizeLoop(makeRun({ tools: 3 }));
    assert.match(s.summary, /3 次工具/);
  });

  test('有错误 → 含错误数', () => {
    const s = summarizeLoop(makeRun({ tools: 2, errors: 1 }));
    assert.match(s.summary, /1 错误/);
  });

  test('有压缩 → 含压缩数', () => {
    const s = summarizeLoop(makeRun({ compacts: 2 }));
    assert.match(s.summary, /2 次压缩/);
  });
});

describe('isHealthyRun', () => {
  test('无错+完成+未超时 → 健康', () => {
    const s = summarizeLoop(makeRun({ errors: 0, completed: true, durationMs: 5000 }));
    assert.ok(isHealthyRun(s));
  });

  test('有错 → 不健康', () => {
    const s = summarizeLoop(makeRun({ errors: 1 }));
    assert.ok(!isHealthyRun(s));
  });

  test('未完成 → 不健康', () => {
    const s = summarizeLoop(makeRun({ completed: false }));
    assert.ok(!isHealthyRun(s));
  });

  test('超时 → 不健康', () => {
    const s = summarizeLoop(makeRun({ durationMs: 120000 }));
    assert.ok(!isHealthyRun(s, 60000));
  });

  test('自定义 maxDurationMs', () => {
    const s = summarizeLoop(makeRun({ durationMs: 30000 }));
    assert.ok(isHealthyRun(s, 60000));
    assert.ok(!isHealthyRun(s, 20000));
  });
});

describe('efficiencyRating', () => {
  test('空运行 → 正常', () => {
    const s = summarizeLoop(null);
    assert.equal(efficiencyRating(s), '正常');
  });

  test('低 token/步 → 高效', () => {
    const root = span({
      name: 'run',
      children: [
        span({ name: 'step' }),
        span({ name: 'llm', usage: usage(200) }),
      ],
    });
    const s = summarizeLoop(root);
    assert.equal(efficiencyRating(s), '高效');
  });

  test('高 token/步 → 低效', () => {
    const root = span({
      name: 'run',
      children: [
        span({ name: 'step' }),
        span({ name: 'llm', usage: usage(1500) }),
      ],
    });
    const s = summarizeLoop(root);
    assert.equal(efficiencyRating(s), '低效');
  });

  test('中等 token/步 → 正常', () => {
    const root = span({
      name: 'run',
      children: [
        span({ name: 'step' }),
        span({ name: 'llm', usage: usage(500) }),
      ],
    });
    const s = summarizeLoop(root);
    assert.equal(efficiencyRating(s), '正常');
  });
});
