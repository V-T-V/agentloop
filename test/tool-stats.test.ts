/**
 * R13-D8（agentloop）：工具调用统计器测试。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateToolStats,
  rankTools,
  identifyProblemTools,
  renderToolStats,
} from '../src/tool-stats.ts';
import type { Span } from '../src/trace.ts';

function toolSpan(name: string, over: Partial<Span> = {}): Span {
  return {
    id: `t${Math.random().toString(36).slice(2, 6)}`,
    name: 'tool',
    parentId: null,
    start: 0,
    end: 100,
    status: 'ok',
    attributes: { name },
    children: [],
    ...over,
  };
}

describe('aggregateToolStats', () => {
  test('空列表 → 空报告', () => {
    const r = aggregateToolStats([]);
    assert.equal(r.tools.length, 0);
    assert.equal(r.totalCalls, 0);
    assert.equal(r.overallSuccessRate, 1); // 默认 1
  });

  test('按工具名分组', () => {
    const r = aggregateToolStats([
      toolSpan('http_get'),
      toolSpan('http_get'),
      toolSpan('memory_store'),
    ]);
    assert.equal(r.tools.length, 2);
    assert.equal(r.tools[0]!.calls, 2); // http_get 出现 2 次
  });

  test('成功率计算', () => {
    const r = aggregateToolStats([
      toolSpan('search', { status: 'ok' }),
      toolSpan('search', { status: 'error' }),
      toolSpan('search', { status: 'ok' }),
      toolSpan('search', { status: 'ok' }),
    ]);
    const search = r.tools.find((t) => t.name === 'search')!;
    assert.equal(search.calls, 4);
    assert.equal(search.successes, 3);
    assert.equal(search.failures, 1);
    assert.ok(Math.abs(search.successRate - 0.75) < 1e-9);
  });

  test('overallSuccessRate', () => {
    const r = aggregateToolStats([
      toolSpan('a', { status: 'ok' }),
      toolSpan('b', { status: 'error' }),
    ]);
    assert.ok(Math.abs(r.overallSuccessRate - 0.5) < 1e-9);
  });

  test('按调用次数降序', () => {
    const r = aggregateToolStats([
      toolSpan('rare'),
      toolSpan('common'), toolSpan('common'), toolSpan('common'),
      toolSpan('mid'), toolSpan('mid'),
    ]);
    assert.equal(r.tools[0]!.name, 'common');
    assert.equal(r.tools[0]!.calls, 3);
    assert.equal(r.tools[1]!.name, 'mid');
    assert.equal(r.tools[2]!.name, 'rare');
  });

  test('耗时统计', () => {
    const r = aggregateToolStats([
      toolSpan('t', { start: 0, end: 100 }),
      toolSpan('t', { start: 0, end: 300 }),
    ]);
    const t = r.tools[0]!;
    assert.equal(t.totalMs, 400);
    assert.equal(t.avgMs, 200);
    assert.equal(t.maxMs, 300);
  });

  test('未结束 span（end=null）耗时为 0', () => {
    const r = aggregateToolStats([toolSpan('t', { end: null })]);
    assert.equal(r.tools[0]!.totalMs, 0);
  });

  test('问题工具（成功率 <70% 且 ≥2 调用）', () => {
    const r = aggregateToolStats([
      toolSpan('bad', { status: 'error' }),
      toolSpan('bad', { status: 'error' }),
      toolSpan('bad', { status: 'ok' }),
    ]);
    assert.equal(r.problemTools.length, 1);
    assert.equal(r.problemTools[0]!.name, 'bad');
  });

  test('单次失败的 Tool 不算问题工具（<2 调用）', () => {
    const r = aggregateToolStats([toolSpan('once', { status: 'error' })]);
    assert.equal(r.problemTools.length, 0);
  });

  test('无 name 属性的 span → 用 "tool" 作名', () => {
    const r = aggregateToolStats([toolSpan('', { attributes: {} })]);
    assert.equal(r.tools.length, 1);
  });
});

describe('rankTools', () => {
  test('返回前 N', () => {
    const r = aggregateToolStats([
      toolSpan('a'), toolSpan('a'),
      toolSpan('b'), toolSpan('b'), toolSpan('b'),
      toolSpan('c'),
    ]);
    const top2 = rankTools(r, 2);
    assert.equal(top2.length, 2);
    assert.equal(top2[0]!.name, 'b');
    assert.equal(top2[1]!.name, 'a');
  });

  test('默认 top 5', () => {
    const r = aggregateToolStats([toolSpan('x')]);
    assert.ok(rankTools(r).length <= 5);
  });
});

describe('identifyProblemTools', () => {
  test('自定义阈值', () => {
    const r = aggregateToolStats([
      toolSpan('ok', { status: 'ok' }),
      toolSpan('ok', { status: 'ok' }),
      toolSpan('mid', { status: 'ok' }),
      toolSpan('mid', { status: 'error' }),
    ]);
    // mid 成功率 50%，阈值 0.6 → 问题
    const problems = identifyProblemTools(r, 0.6, 2);
    assert.ok(problems.some((t) => t.name === 'mid'));
  });

  test('minCalls 过滤', () => {
    const r = aggregateToolStats([
      toolSpan('rare', { status: 'error' }),
    ]);
    // 1 次调用，minCalls=2 → 不算
    assert.equal(identifyProblemTools(r, 0.7, 2).length, 0);
  });
});

describe('renderToolStats', () => {
  test('空 → 标题', () => {
    const s = renderToolStats(aggregateToolStats([]));
    assert.match(s, /工具调用统计/);
  });

  test('有工具 → 含表格', () => {
    const r = aggregateToolStats([toolSpan('test'), toolSpan('test')]);
    const s = renderToolStats(r);
    assert.match(s, /test/);
    assert.match(s, /2/); // 次数
  });

  test('有问题工具 → 含警告', () => {
    const r = aggregateToolStats([
      toolSpan('bad', { status: 'error' }),
      toolSpan('bad', { status: 'error' }),
    ]);
    const s = renderToolStats(r);
    assert.match(s, /问题工具|⚠️/);
  });

  test('含成功率百分比', () => {
    const r = aggregateToolStats([
      toolSpan('t', { status: 'ok' }),
      toolSpan('t', { status: 'error' }),
    ]);
    const s = renderToolStats(r);
    assert.match(s, /50%/);
  });
});
