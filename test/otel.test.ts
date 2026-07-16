/**
 * otel.ts OTLP 导出的测试。
 *
 * 用 mock fetch 验证：Span→OTLP 映射、gen_ai.* 语义属性、
 * 端点为空时跳过、HTTP 发送、失败容错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toOTLP, exportTrace } from '../src/otel.ts';
import type { Span } from '../src/trace.ts';

/** 造一个带层级的 span 树用于转换测试 */
function sampleTree(): Span {
  const llmUsage = { promptTokens: 50, completionTokens: 10, totalTokens: 60 };
  const tool: Span = {
    id: 'span_4',
    name: 'tool',
    parentId: 'span_3',
    start: 10,
    end: 15,
    status: 'ok',
    attributes: { step: 1, tool: 'datetime', ok: true },
    children: [],
  };
  const llm: Span = {
    id: 'span_3',
    name: 'llm',
    parentId: 'span_2',
    start: 5,
    end: 20,
    status: 'ok',
    attributes: { step: 1 },
    children: [],
    usage: llmUsage,
  };
  const step: Span = {
    id: 'span_2',
    name: 'step',
    parentId: 'span_1',
    start: 4,
    end: 21,
    status: 'ok',
    attributes: { step: 1 },
    children: [llm, tool],
  };
  return {
    id: 'span_1',
    name: 'run',
    parentId: null,
    start: 0,
    end: 100,
    status: 'ok',
    attributes: {},
    children: [step],
  };
}

test('toOTLP：展平为扁平 span 数组，靠 parentSpanId 关联', () => {
  const payload = toOTLP(sampleTree());
  const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
  assert.equal(spans.length, 4); // run + step + llm + tool
  // 所有 span 共享同一 traceId
  const traceIds = new Set(spans.map((s) => s.traceId));
  assert.equal(traceIds.size, 1);
  // 根 span 无 parentSpanId
  const root = spans.find((s) => s.name === 'run')!;
  assert.equal(root.parentSpanId, undefined);
  // step 的 parent 是 run 的 spanId
  const stepSpan = spans.find((s) => s.name === 'step')!;
  assert.equal(stepSpan.parentSpanId, root.spanId);
});

test('toOTLP：spanId 是 16 hex 字符', () => {
  const payload = toOTLP(sampleTree());
  const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
  for (const s of spans) {
    assert.equal(s.spanId.length, 16);
    assert.match(s.spanId, /^[0-9a-f]{16}$/);
  }
});

test('toOTLP：时间戳为纳秒字符串', () => {
  const payload = toOTLP(sampleTree());
  const root = payload.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === 'run')!;
  assert.match(root.startTimeUnixNano, /^\d+$/);
  assert.match(root.endTimeUnixNano, /^\d+$/);
});

test('toOTLP：llm span 带 gen_ai.* 语义属性', () => {
  const payload = toOTLP(sampleTree());
  const llm = payload.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === 'llm')!;
  const keys = llm.attributes.map((a) => a.key);
  assert.ok(keys.includes('gen_ai.system'));
  assert.ok(keys.includes('gen_ai.request.model'));
  assert.ok(keys.includes('gen_ai.usage.input_tokens'));
  assert.ok(keys.includes('gen_ai.usage.output_tokens'));
});

test('toOTLP：tool span 带 gen_ai.tool.name', () => {
  const payload = toOTLP(sampleTree());
  const tool = payload.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === 'tool')!;
  const attr = tool.attributes.find((a) => a.key === 'gen_ai.tool.name');
  assert.ok(attr);
  assert.equal(attr!.value.stringValue, 'datetime');
});

test('toOTLP：resource 含 service.name', () => {
  const payload = toOTLP(sampleTree(), { serviceName: 'my-service' });
  const attrs = payload.resourceSpans[0]!.resource.attributes;
  const svc = attrs.find((a) => a.key === 'service.name');
  assert.ok(svc);
  assert.equal(svc!.value.stringValue, 'my-service');
});

test('toOTLP：error span 的 status code 为 2', () => {
  const errTree: Span = {
    id: 'e1',
    name: 'llm',
    parentId: null,
    start: 0,
    end: 1,
    status: 'error',
    attributes: {},
    children: [],
  };
  const payload = toOTLP(errTree);
  const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  assert.equal(span.status.code, 2);
});

test('exportTrace：端点为空时跳过（exported:false）', async () => {
  const r = await exportTrace(sampleTree(), { endpoint: '' });
  assert.equal(r.exported, false);
  assert.equal(r.spanCount, 0);
});

test('exportTrace：用 mock fetch 验证发送', async () => {
  const captured: { url: string; init: RequestInit } = { url: '', init: {} };
  const mockFetch = ((url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;

  const r = await exportTrace(sampleTree(), {
    endpoint: 'http://localhost:4318/v1/traces',
    fetchImpl: mockFetch,
  });
  assert.equal(r.exported, true);
  assert.equal(r.spanCount, 4);
  assert.equal(captured.url, 'http://localhost:4318/v1/traces');
  assert.equal(captured.init.method as string, 'POST');
  // body 是合法 JSON 且含 resourceSpans
  const body = JSON.parse(captured.init.body as string);
  assert.ok(body.resourceSpans);
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans.length, 4);
});

test('exportTrace：HTTP 失败时 exported:false 且带 error', async () => {
  const mockFetch = (() =>
    Promise.resolve(new Response('err', { status: 500 }))) as unknown as typeof fetch;
  const r = await exportTrace(sampleTree(), {
    endpoint: 'http://localhost:4318/v1/traces',
    fetchImpl: mockFetch,
  });
  assert.equal(r.exported, false);
  assert.match(r.error ?? '', /500/);
});

test('exportTrace：网络异常不抛出（best-effort）', async () => {
  const mockFetch = (() => Promise.reject(new Error('连接拒绝'))) as unknown as typeof fetch;
  const r = await exportTrace(sampleTree(), {
    endpoint: 'http://localhost:4318/v1/traces',
    fetchImpl: mockFetch,
  });
  assert.equal(r.exported, false);
  assert.match(r.error ?? '', /连接拒绝/);
});
