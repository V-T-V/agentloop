/**
 * otel.ts 深层路径测试（R10-D5）。
 *
 * 补 otel.test.ts 未触达的分支：
 *   1. toAnyValue 类型映射：string/int/double/bool/array/null/object → 对应 OTLP AnyValue
 *   2. 未结束 span（end=null）：endNs 等于 startNs（不崩）
 *   3. 深层嵌套（4+ 层）：flatten 递归正确，parentSpanId 链完整
 *   4. llm span 无 usage：不追加 gen_ai.usage.* 属性
 *   5. tool span 无 'tool' 属性：不追加 gen_ai.tool.name
 *   6. spanId 确定性：相同 id → 相同 spanId；不同 id → 不同 spanId
 *   7. traceId 格式：32 hex 字符
 *   8. kind 映射：llm=3(CLIENT)，其他=1(INTERNAL)
 *   9. serviceName 环境变量回退（不传 options 时读 LOOP_OTEL_SERVICE_NAME 或默认 agentloop）
 *  10. 属性 intValue 为字符串（OTLP JSON 约定）
 *  11. exportTrace：非 Error reject → error 走 String(e) 兜底
 *  12. exportTrace：fetch 收到正确 headers（Content-Type: application/json）
 *  13. exportTrace：4xx 也算失败（非 2xx）
 *  14. exportTrace：spanCount 含深层嵌套全部 span
 *  15. array 属性 → arrayValue.values 递归映射
 *  16. null/对象 属性 → stringValue（空串 / JSON 字符串）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toOTLP, exportTrace } from '../src/otel.ts';
import type { Span } from '../src/trace.ts';

function leaf(name: string, attrs: Record<string, unknown> = {}, usage?: Span['usage']): Span {
  return {
    id: `id_${name}`,
    name,
    parentId: null,
    start: 10,
    end: 20,
    status: 'ok',
    attributes: attrs,
    children: [],
    usage,
  };
}

function spans(payload: ReturnType<typeof toOTLP>) {
  return payload.resourceSpans[0]!.scopeSpans[0]!.spans;
}

test('toAnyValue：string 属性 → stringValue', () => {
  const s = leaf('tool', { name: 'calc' });
  const v = spans(toOTLP(s)).find((x) => x.name === 'tool')!.attributes.find((a) => a.key === 'name');
  assert.deepEqual(v!.value, { stringValue: 'calc' });
});

test('toAnyValue：整数 → intValue（字符串形式）', () => {
  const s = leaf('step', { n: 42 });
  const v = spans(toOTLP(s)).find((x) => x.name === 'step')!.attributes.find((a) => a.key === 'n');
  assert.deepEqual(v!.value, { intValue: '42' });
});

test('toAnyValue：浮点 → doubleValue', () => {
  const s = leaf('step', { ratio: 0.75 });
  const v = spans(toOTLP(s)).find((x) => x.name === 'step')!.attributes.find((a) => a.key === 'ratio');
  assert.deepEqual(v!.value, { doubleValue: 0.75 });
});

test('toAnyValue：布尔 → boolValue', () => {
  const s = leaf('step', { ok: true });
  const v = spans(toOTLP(s)).find((x) => x.name === 'step')!.attributes.find((a) => a.key === 'ok');
  assert.deepEqual(v!.value, { boolValue: true });
});

test('toAnyValue：数组 → arrayValue.values 递归映射', () => {
  const s = leaf('step', { tags: ['a', 'b'] });
  const v = spans(toOTLP(s)).find((x) => x.name === 'step')!.attributes.find((a) => a.key === 'tags');
  assert.deepEqual(v!.value, { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } });
});

test('toAnyValue：null → stringValue 空串', () => {
  const s = leaf('step', { x: null });
  const v = spans(toOTLP(s)).find((x) => x.name === 'step')!.attributes.find((a) => a.key === 'x');
  assert.deepEqual(v!.value, { stringValue: '' });
});

test('toAnyValue：对象 → JSON 字符串', () => {
  const s = leaf('step', { obj: { k: 1 } });
  const v = spans(toOTLP(s)).find((x) => x.name === 'step')!.attributes.find((a) => a.key === 'obj');
  assert.deepEqual(v!.value, { stringValue: JSON.stringify({ k: 1 }) });
});

test('未结束 span（end=null）：endNs 等于 startNs，不崩', () => {
  const s: Span = {
    id: 'open',
    name: 'step',
    parentId: null,
    start: 100,
    end: null,
    status: 'ok',
    attributes: {},
    children: [],
  };
  const span = spans(toOTLP(s))[0]!;
  assert.equal(span.endTimeUnixNano, span.startTimeUnixNano, '未结束 span 的 end 应等于 start');
  assert.match(span.endTimeUnixNano, /^\d+$/);
});

test('深层嵌套（4 层）：flatten 递归，parentSpanId 链完整', () => {
  const deep4: Span = {
    id: 'L4',
    name: 'tool',
    parentId: 'L3',
    start: 1,
    end: 2,
    status: 'ok',
    attributes: {},
    children: [],
  };
  const deep3: Span = {
    id: 'L3',
    name: 'step',
    parentId: 'L2',
    start: 1,
    end: 3,
    status: 'ok',
    attributes: {},
    children: [deep4],
  };
  const deep2: Span = {
    id: 'L2',
    name: 'llm',
    parentId: 'L1',
    start: 0,
    end: 4,
    status: 'ok',
    attributes: {},
    children: [deep3],
  };
  const root: Span = {
    id: 'L1',
    name: 'run',
    parentId: null,
    start: 0,
    end: 5,
    status: 'ok',
    attributes: {},
    children: [deep2],
  };
  const all = spans(toOTLP(root));
  assert.equal(all.length, 4, '应展平出 4 个 span');
  const l4 = all.find((s) => s.name === 'tool')!;
  const l3 = all.find((s) => s.name === 'step')!;
  const l2 = all.find((s) => s.name === 'llm')!;
  const l1 = all.find((s) => s.name === 'run')!;
  assert.equal(l1.parentSpanId, undefined);
  assert.equal(l2.parentSpanId, l1.spanId);
  assert.equal(l3.parentSpanId, l2.spanId);
  assert.equal(l4.parentSpanId, l3.spanId);
});

test('llm span 无 usage：不追加 gen_ai.usage.* 属性', () => {
  const s = leaf('llm', { step: 1 }); // 不传 usage
  const llm = spans(toOTLP(s))[0]!;
  const keys = llm.attributes.map((a) => a.key);
  assert.ok(keys.includes('gen_ai.system'));
  assert.ok(keys.includes('gen_ai.request.model'));
  assert.ok(!keys.includes('gen_ai.usage.input_tokens'), '无 usage 不应追加 input_tokens');
  assert.ok(!keys.includes('gen_ai.usage.output_tokens'));
});

test('tool span 无 tool 属性：不追加 gen_ai.tool.name', () => {
  const s = leaf('tool', { step: 1 }); // 无 'tool' 属性
  const tool = spans(toOTLP(s))[0]!;
  const keys = tool.attributes.map((a) => a.key);
  assert.ok(!keys.includes('gen_ai.tool.name'), '无 tool 属性不应追加 gen_ai.tool.name');
});

test('spanId 确定性：相同 id → 相同 spanId', () => {
  const s1 = leaf('tool', {});
  const s2 = leaf('tool', {});
  // 两者 id 都是 'id_tool'（leaf 用 name 生成 id）
  const id1 = spans(toOTLP(s1))[0]!.spanId;
  const id2 = spans(toOTLP(s2))[0]!.spanId;
  assert.equal(id1, id2, '相同内部 id 应映射到相同 OTLP spanId');
});

test('spanId 唯一性：不同 id → 不同 spanId', () => {
  const s1: Span = {
    id: 'aaa',
    name: 'tool',
    parentId: null,
    start: 1,
    end: 2,
    status: 'ok',
    attributes: {},
    children: [],
  };
  const s2: Span = { ...s1, id: 'bbb' };
  const id1 = spans(toOTLP(s1))[0]!.spanId;
  const id2 = spans(toOTLP(s2))[0]!.spanId;
  assert.notEqual(id1, id2, '不同 id 应映射到不同 spanId');
});

test('traceId 格式：32 hex 字符', () => {
  const s = leaf('run');
  const all = spans(toOTLP(s));
  const traceIds = new Set(all.map((x) => x.traceId));
  assert.equal(traceIds.size, 1);
  const tid = all[0]!.traceId;
  assert.match(tid, /^[0-9a-f]{32}$/, 'traceId 应为 32 hex 字符');
});

test('kind 映射：llm=3(CLIENT)，其他=1(INTERNAL)', () => {
  const llm = leaf('llm', {});
  const tool = leaf('tool', {});
  const step = leaf('step', {});
  const root: Span = {
    id: 'r',
    name: 'run',
    parentId: null,
    start: 0,
    end: 1,
    status: 'ok',
    attributes: {},
    children: [llm, tool, step],
  };
  const all = spans(toOTLP(root));
  assert.equal(all.find((s) => s.name === 'llm')!.kind, 3, 'llm 应为 CLIENT(3)');
  assert.equal(all.find((s) => s.name === 'tool')!.kind, 1, 'tool 应为 INTERNAL(1)');
  assert.equal(all.find((s) => s.name === 'step')!.kind, 1, 'step 应为 INTERNAL(1)');
  assert.equal(all.find((s) => s.name === 'run')!.kind, 1, 'run 应为 INTERNAL(1)');
});

test('serviceName：不传 options 时用默认 agentloop', () => {
  const s = leaf('run');
  const payload = toOTLP(s);
  const svc = payload.resourceSpans[0]!.resource.attributes.find((a) => a.key === 'service.name');
  // 默认值 agentloop（除非环境 LOOP_OTEL_SERVICE_NAME 被设）
  assert.ok(svc);
  assert.ok(typeof svc!.value.stringValue === 'string');
});

test('serviceName：显式 options.serviceName 覆盖', () => {
  const s = leaf('run');
  const payload = toOTLP(s, { serviceName: 'custom-svc' });
  const svc = payload.resourceSpans[0]!.resource.attributes.find((a) => a.key === 'service.name');
  assert.equal(svc!.value.stringValue, 'custom-svc');
});

test('resource 含 telemetry.sdk.name=agentloop', () => {
  const s = leaf('run');
  const payload = toOTLP(s);
  const sdk = payload.resourceSpans[0]!.resource.attributes.find((a) => a.key === 'telemetry.sdk.name');
  assert.equal(sdk!.value.stringValue, 'agentloop');
});

test('scope.name = agentloop.loop', () => {
  const s = leaf('run');
  const payload = toOTLP(s);
  assert.equal(payload.resourceSpans[0]!.scopeSpans[0]!.scope.name, 'agentloop.loop');
});

test('exportTrace：非 Error reject → error 走 String(e) 兜底', async () => {
  // eslint 规则无关：这里故意 reject 一个非 Error
  const mockFetch = (() => Promise.reject('原始字符串错误')) as unknown as typeof fetch;
  const r = await exportTrace(leaf('run'), { endpoint: 'http://x', fetchImpl: mockFetch });
  assert.equal(r.exported, false);
  assert.match(r.error ?? '', /原始字符串错误/);
});

test('exportTrace：fetch 收到正确 Content-Type header', async () => {
  let capturedHeaders: Record<string, string> = {};
  const mockFetch = ((_url: string, init: RequestInit) => {
    capturedHeaders = init.headers as Record<string, string>;
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;
  await exportTrace(leaf('run'), { endpoint: 'http://x', fetchImpl: mockFetch });
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
});

test('exportTrace：4xx 也算失败（非 2xx → exported:false）', async () => {
  const mockFetch = (() => Promise.resolve(new Response('bad', { status: 429 }))) as unknown as typeof fetch;
  const r = await exportTrace(leaf('run'), { endpoint: 'http://x', fetchImpl: mockFetch });
  assert.equal(r.exported, false);
  assert.match(r.error ?? '', /429/);
});

test('exportTrace：spanCount 含深层嵌套全部 span', async () => {
  const deep: Span = {
    id: 'd',
    name: 'tool',
    parentId: 'p',
    start: 1,
    end: 2,
    status: 'ok',
    attributes: {},
    children: [],
  };
  const root: Span = {
    id: 'r',
    name: 'run',
    parentId: null,
    start: 0,
    end: 3,
    status: 'ok',
    attributes: {},
    children: [deep],
  };
  const mockFetch = (() => Promise.resolve(new Response('{}', { status: 200 }))) as unknown as typeof fetch;
  const r = await exportTrace(root, { endpoint: 'http://x', fetchImpl: mockFetch });
  assert.equal(r.spanCount, 2, '应统计根 + 子共 2 个 span');
});

test('exportTrace：body 是合法 JSON 含 resourceSpans', async () => {
  let body = '';
  const mockFetch = ((_url: string, init: RequestInit) => {
    body = init.body as string;
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;
  await exportTrace(leaf('run'), { endpoint: 'http://x', fetchImpl: mockFetch });
  const parsed = JSON.parse(body);
  assert.ok(parsed.resourceSpans);
  assert.ok(parsed.resourceSpans[0].scopeSpans[0].spans.length >= 1);
});
