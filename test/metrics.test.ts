/**
 * metrics.ts 指标聚合的测试。
 *
 * 覆盖：按类型聚合、耗时/token 统计、错误率、工具成功率、
 * flattenSpans 递归展平、renderMetrics 渲染、空输入不崩。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateMetrics, flattenSpans, renderMetrics } from '../src/metrics.ts';
import type { Span } from '../src/trace.ts';
import type { TokenUsage } from '../src/types.ts';

const U: TokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };

/** 构造一个已结束的 span */
function mkSpan(name: string, start: number, end: number, status: 'ok' | 'error' = 'ok', usage?: TokenUsage, children: Span[] = []): Span {
  return { id: `${name}_${start}`, name, parentId: null, start, end, status, attributes: {}, children, usage };
}

test('flattenSpans：递归展平 span 树', () => {
  const root = mkSpan('run', 0, 100);
  const step = mkSpan('step', 10, 90);
  const llm = mkSpan('llm', 20, 50);
  const tool = mkSpan('tool', 60, 80);
  root.children = [step];
  step.children = [llm, tool];
  const flat = flattenSpans(root);
  assert.equal(flat.length, 4, '含 root 共 4 个 span');
  assert.ok(flat.some((s) => s.name === 'llm'));
  assert.ok(flat.some((s) => s.name === 'tool'));
});

test('aggregateMetrics：按类型分组聚合', () => {
  const spans = [
    mkSpan('run', 0, 1000),
    mkSpan('step', 10, 100),
    mkSpan('step', 110, 200),
    mkSpan('llm', 20, 50, 'ok', U),
    mkSpan('llm', 60, 90, 'ok', U),
    mkSpan('tool', 100, 150, 'ok'),
    mkSpan('tool', 200, 250, 'error'),
  ];
  const report = aggregateMetrics(spans);
  assert.equal(report.totalSteps, 2, '2 个 step');
  assert.equal(report.llmCalls, 2, '2 个 llm');
  const stepMetrics = report.byType.find((m) => m.name === 'step');
  assert.ok(stepMetrics);
  assert.equal(stepMetrics!.count, 2);
  assert.equal(stepMetrics!.avgMs, 90, '(90+90)/2');
});

test('aggregateMetrics：token 汇总正确', () => {
  const spans = [
    mkSpan('run', 0, 100),
    mkSpan('llm', 10, 50, 'ok', U),
    mkSpan('llm', 60, 90, 'ok', { promptTokens: 200, completionTokens: 100, totalTokens: 300 }),
  ];
  const report = aggregateMetrics(spans);
  assert.equal(report.totalTokens, 450, '150 + 300');
  const llmMetrics = report.byType.find((m) => m.name === 'llm');
  assert.equal(llmMetrics!.totalTokens, 450);
});

test('aggregateMetrics：错误率计算', () => {
  const spans = [
    mkSpan('run', 0, 100),
    mkSpan('tool', 10, 50, 'ok'),
    mkSpan('tool', 60, 90, 'error'),
    mkSpan('tool', 100, 120, 'ok'),
  ];
  const report = aggregateMetrics(spans);
  assert.equal(report.byType.find((m) => m.name === 'tool')!.errorCount, 1);
  assert.equal(report.byType.find((m) => m.name === 'tool')!.errorRate, 1 / 3);
  // 工具成功率 = (3-1)/3
  assert.equal(report.toolSuccessRate, 2 / 3);
});

test('aggregateMetrics：最大/最小/平均耗时', () => {
  const spans = [
    mkSpan('run', 0, 100),
    mkSpan('llm', 10, 50), // 40ms
    mkSpan('llm', 60, 90), // 30ms
    mkSpan('llm', 100, 200), // 100ms
  ];
  const report = aggregateMetrics(spans);
  const llm = report.byType.find((m) => m.name === 'llm')!;
  assert.equal(llm.minMs, 30);
  assert.equal(llm.maxMs, 100);
  assert.equal(llm.avgMs, (40 + 30 + 100) / 3);
  assert.equal(llm.totalMs, 170);
});

test('aggregateMetrics：空列表不崩', () => {
  const report = aggregateMetrics([]);
  assert.equal(report.totalSteps, 0);
  assert.equal(report.totalTokens, 0);
  assert.equal(report.byType.length, 0);
  assert.equal(report.toolSuccessRate, 1, '无工具时成功率默认 1');
});

test('aggregateMetrics：压缩次数统计', () => {
  const spans = [
    mkSpan('run', 0, 100),
    mkSpan('compact', 10, 20),
    mkSpan('compact', 30, 40),
  ];
  const report = aggregateMetrics(spans);
  assert.equal(report.compactCount, 2);
});

test('aggregateMetrics：未结束 span 耗时为 0', () => {
  const openSpan: Span = { id: 'open', name: 'step', parentId: null, start: 10, end: null, status: 'ok', attributes: {}, children: [] };
  const report = aggregateMetrics([openSpan]);
  assert.equal(report.byType[0]!.totalMs, 0);
});

test('renderMetrics：含表格输出', () => {
  const spans = [
    mkSpan('run', 0, 1000),
    mkSpan('step', 10, 100),
    mkSpan('llm', 20, 50, 'ok', U),
  ];
  const report = aggregateMetrics(spans);
  const text = renderMetrics(report);
  assert.match(text, /运行指标/);
  assert.match(text, /步数/);
  assert.match(text, /按类型统计/);
  assert.match(text, /llm/);
});

test('renderMetrics：空报告不崩', () => {
  const text = renderMetrics(aggregateMetrics([]));
  assert.match(text, /运行指标/);
});
