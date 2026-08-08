/**
 * R13-D4（agentloop）：metrics.ts 深层边界测试。
 *
 * 补 metrics.test.ts 未覆盖的：
 *   - flattenSpans 深嵌套树/无子节点
 *   - aggregateMetrics 混合 status（ok/error/cancelled）
 *   - 工具成功率边界（0%/100%/无工具）
 *   - renderMetrics 格式（表格/对齐/百分比）
 *   - 单 span 各字段
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSpans, aggregateMetrics, renderMetrics } from '../src/metrics.ts';
import type { Span } from '../src/trace.ts';
import type { TokenUsage } from '../src/types.ts';

function span(over: Partial<Span> = {}): Span {
  return {
    id: `s${Math.random().toString(36).slice(2, 8)}`,
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

describe('flattenSpans 深层', () => {
  test('无子节点的单 span → 返回自身', () => {
    const s = span();
    assert.deepEqual(flattenSpans(s), [s]);
  });

  test('3 层嵌套 → 全部展平', () => {
    const leaf = span({ id: 'leaf', name: 'tool' });
    const mid = span({ id: 'mid', name: 'step', children: [leaf] });
    const root = span({ id: 'root', name: 'run', children: [mid] });
    const flat = flattenSpans(root);
    assert.equal(flat.length, 3);
    assert.ok(flat.some((s) => s.id === 'leaf'));
    assert.ok(flat.some((s) => s.id === 'mid'));
    assert.ok(flat.some((s) => s.id === 'root'));
  });

  test('多分支树 → 全展平', () => {
    const root = span({
      id: 'root',
      children: [
        span({ id: 'a', children: [span({ id: 'a1' }), span({ id: 'a2' })] }),
        span({ id: 'b', children: [span({ id: 'b1' })] }),
      ],
    });
    assert.equal(flattenSpans(root).length, 6); // root + a + a1 + a2 + b + b1
  });
});

describe('aggregateMetrics 混合 status', () => {
  test('error 率 = errorCount / count', () => {
    const spans = [
      span({ name: 'tool', status: 'ok' }),
      span({ name: 'tool', status: 'error' }),
      span({ name: 'tool', status: 'ok' }),
      span({ name: 'tool', status: 'error' }),
    ];
    const r = aggregateMetrics(spans);
    const tool = r.byType.find((m) => m.name === 'tool')!;
    assert.equal(tool.count, 4);
    assert.equal(tool.errorCount, 2);
    assert.ok(Math.abs(tool.errorRate - 0.5) < 1e-9);
  });

  test('工具成功率 0%（全 error）', () => {
    const spans = [span({ name: 'tool', status: 'error' }), span({ name: 'tool', status: 'error' })];
    const r = aggregateMetrics(spans);
    assert.equal(r.toolSuccessRate, 0);
  });

  test('工具成功率 100%（全 ok）', () => {
    const spans = [span({ name: 'tool', status: 'ok' }), span({ name: 'tool', status: 'ok' })];
    const r = aggregateMetrics(spans);
    assert.equal(r.toolSuccessRate, 1);
  });

  test('无工具 span → toolSuccessRate=1（默认）', () => {
    const r = aggregateMetrics([span({ name: 'step' })]);
    assert.equal(r.toolSuccessRate, 1);
  });
});

describe('aggregateMetrics 耗时统计', () => {
  test('max/min/avg 正确', () => {
    const spans = [
      span({ name: 'llm', start: 0, end: 100 }),
      span({ name: 'llm', start: 0, end: 200 }),
      span({ name: 'llm', start: 0, end: 300 }),
    ];
    const r = aggregateMetrics(spans);
    const llm = r.byType.find((m) => m.name === 'llm')!;
    assert.equal(llm.minMs, 100);
    assert.equal(llm.maxMs, 300);
    assert.ok(Math.abs(llm.avgMs - 200) < 1e-9);
    assert.equal(llm.totalMs, 600);
  });

  test('未结束 span（end=null）耗时为 0', () => {
    const spans = [span({ name: 'step', end: null }), span({ name: 'step', end: 100 })];
    const r = aggregateMetrics(spans);
    const step = r.byType.find((m) => m.name === 'step')!;
    assert.equal(step.minMs, 0);
    assert.equal(step.maxMs, 100);
  });
});

describe('aggregateMetrics token 汇总', () => {
  test('token 总计', () => {
    const spans = [
      span({ name: 'llm', usage: usage(100) }),
      span({ name: 'llm', usage: usage(200) }),
      span({ name: 'tool' }), // 无 usage
    ];
    const r = aggregateMetrics(spans);
    assert.equal(r.totalTokens, 300);
    const llm = r.byType.find((m) => m.name === 'llm')!;
    assert.equal(llm.totalTokens, 300);
  });

  test('无 usage 的 span → token=0', () => {
    const r = aggregateMetrics([span({ name: 'step' })]);
    assert.equal(r.totalTokens, 0);
  });
});

describe('aggregateMetrics 计数', () => {
  test('totalSteps = step span 数', () => {
    const spans = [span({ name: 'step' }), span({ name: 'step' }), span({ name: 'llm' })];
    assert.equal(aggregateMetrics(spans).totalSteps, 2);
  });

  test('llmCalls = llm span 数', () => {
    const spans = [span({ name: 'llm' }), span({ name: 'llm' })];
    assert.equal(aggregateMetrics(spans).llmCalls, 2);
  });

  test('compactCount = compact span 数', () => {
    const spans = [span({ name: 'compact' }), span({ name: 'compact' }), span({ name: 'compact' })];
    assert.equal(aggregateMetrics(spans).compactCount, 3);
  });

  test('totalDurationMs = run span 耗时', () => {
    const spans = [span({ name: 'run', start: 1000, end: 5000 }), span({ name: 'step' })];
    assert.equal(aggregateMetrics(spans).totalDurationMs, 4000);
  });
});

describe('aggregateMetrics 空与单', () => {
  test('空列表 → 全零', () => {
    const r = aggregateMetrics([]);
    assert.equal(r.totalSteps, 0);
    assert.equal(r.totalTokens, 0);
    assert.equal(r.totalDurationMs, 0);
    assert.equal(r.byType.length, 0);
    assert.equal(r.toolSuccessRate, 1); // 无工具默认 1
  });

  test('单 span → 单组统计', () => {
    const r = aggregateMetrics([span({ name: 'run', start: 0, end: 100 })]);
    assert.equal(r.byType.length, 1);
    assert.equal(r.byType[0]!.name, 'run');
    assert.equal(r.byType[0]!.count, 1);
  });
});

describe('renderMetrics 格式', () => {
  test('含标题与分隔线', () => {
    const r = aggregateMetrics([span({ name: 'run', start: 0, end: 500 })]);
    const s = renderMetrics(r);
    assert.match(s, /运行指标/);
    assert.ok(s.includes('─'));
  });

  test('含总时长/步数/LLM调用', () => {
    const r = aggregateMetrics([
      span({ name: 'run', start: 0, end: 1500 }),
      span({ name: 'step' }),
      span({ name: 'llm', usage: usage(100) }),
    ]);
    const s = renderMetrics(r);
    assert.match(s, /步数/);
    assert.match(s, /LLM/);
    assert.match(s, /1\.\d+s|1500ms/); // 时长
  });

  test('工具成功率百分比', () => {
    const r = aggregateMetrics([
      span({ name: 'tool', status: 'ok' }),
      span({ name: 'tool', status: 'error' }),
    ]);
    const s = renderMetrics(r);
    assert.match(s, /50%/);
  });

  test('空报告 → 不崩溃', () => {
    const s = renderMetrics(aggregateMetrics([]));
    assert.ok(typeof s === 'string' && s.length > 0);
  });

  test('有 byType → 含表格', () => {
    const r = aggregateMetrics([span({ name: 'step' }), span({ name: 'llm' })]);
    const s = renderMetrics(r);
    assert.match(s, /按类型|类型/);
  });
});
