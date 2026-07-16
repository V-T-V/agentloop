/**
 * OpenTelemetry 导出：把内部 Span 树转成 OTLP/HTTP JSON，发到任意 Collector。
 *
 * 零依赖实现：用原生 fetch 手写 OTLP/HTTP 协议（POST /v1/traces，
 * Content-Type: application/json，body = ExportTraceServiceRequest 的 JSON 形态），
 * 不引入 @opentelemetry/* 依赖树——保持本项目「零运行时依赖」的承诺。
 *
 * GenAI 语义属性（按 OpenTelemetry GenAI semconv）标注：
 *   - llm span：gen_ai.system / gen_ai.request.model / gen_ai.usage.input_tokens / gen_ai.usage.output_tokens
 *   - tool span：gen_ai.tool.name
 * 这些标准属性可被 Datadog / Jaeger / Honeycomb 等识别并正确归类。
 *
 * 依据：OTLP 规范 1.10.0；GenAI semantic conventions。
 */

import { env } from './env.ts';
import type { Span } from './trace.ts';

/** OTLP 属性值（protobuf JSON 映射下的 AnyValue） */
interface OTLPAnyValue {
  stringValue?: string;
  intValue?: string; // OTLP JSON 把 int 表示为字符串
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OTLPAnyValue[] };
}

interface OTLPAttribute {
  key: string;
  value: OTLPAnyValue;
}

interface OTLPSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OTLPAttribute[];
  status: { code: number; message?: string }; // 0=UNSET,1=OK,2=ERROR
  // 子 span 在 OTLP 里是扁平的（靠 parentSpanId 关联），这里在展平时收集
}

/** 把一个 JS 值转成 OTLP AnyValue */
function toAnyValue(v: unknown): OTLPAnyValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toAnyValue) } };
  // 对象/其它序列化为 JSON 字符串
  return { stringValue: v === null ? '' : JSON.stringify(v) };
}

/** 把内部属性 + GenAI 语义属性合并成 OTLP attributes */
function buildAttributes(span: Span, extra: OTLPAttribute[] = []): OTLPAttribute[] {
  const attrs: OTLPAttribute[] = extra;
  for (const [k, v] of Object.entries(span.attributes)) {
    attrs.push({ key: k, value: toAnyValue(v) });
  }
  // GenAI 语义属性：按 span 类型补充
  if (span.name === 'llm') {
    attrs.push({ key: 'gen_ai.system', value: { stringValue: 'agentloop' } });
    attrs.push({ key: 'gen_ai.request.model', value: { stringValue: env('LOOP_LLM_MODEL', 'glm-4-flash') } });
    if (span.usage) {
      attrs.push({ key: 'gen_ai.usage.input_tokens', value: { intValue: String(span.usage.promptTokens) } });
      attrs.push({ key: 'gen_ai.usage.output_tokens', value: { intValue: String(span.usage.completionTokens) } });
    }
  }
  if (span.name === 'tool') {
    const toolName = span.attributes['tool'];
    if (typeof toolName === 'string') {
      attrs.push({ key: 'gen_ai.tool.name', value: { stringValue: toolName } });
    }
  }
  return attrs;
}

/** 简单确定性哈希 → 16 hex 字符的 OTLP spanId */
function hexSpanId(internalId: string): string {
  let h = 0;
  for (let i = 0; i < internalId.length; i++) {
    h = (h * 31 + internalId.charCodeAt(i)) >>> 0;
  }
  // 拼成 16 hex 字符（不足补 0）
  let hex = h.toString(16);
  while (hex.length < 16) hex = hex + '0';
  // 再混合一点内部 id 的尾段增加区分度
  const tail = internalId.slice(-4).padStart(4, '0');
  let h2 = 0;
  for (let i = 0; i < tail.length; i++) h2 = (h2 * 17 + tail.charCodeAt(i)) >>> 0;
  return (hex.slice(0, 8) + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 16);
}

/** 展平 span 树为 OTLP span 数组（OTLP 是扁平的，靠 parentSpanId 关联） */
function flatten(
  span: Span,
  traceId: string,
  parentSpanId: string | undefined,
  out: OTLPSpan[],
): void {
  const spanId = hexSpanId(span.id);
  const startNs = BigInt(Math.round(span.start * 1_000_000)).toString();
  const endNs = span.end !== null ? BigInt(Math.round(span.end * 1_000_000)).toString() : startNs;
  out.push({
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: span.name,
    kind: span.name === 'llm' ? 3 : 1, // llm 当 CLIENT，其余 INTERNAL（近似）
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    attributes: buildAttributes(span),
    status: { code: span.status === 'error' ? 2 : 1 },
  });
  for (const child of span.children) {
    flatten(child, traceId, spanId, out);
  }
}

/** 生成一个 32 hex 字符的 traceId（整个 trace 共享） */
function newTraceId(): string {
  const ts = Date.now().toString(16).padStart(12, '0');
  const rand = Array.from({ length: 20 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
  return (ts + rand).slice(0, 32).padEnd(32, '0');
}

export interface OTLPPayload {
  resourceSpans: Array<{
    resource: { attributes: OTLPAttribute[] };
    scopeSpans: Array<{ scope: { name: string }; spans: OTLPSpan[] }>;
  }>;
}

/**
 * 把内部 Span 树转成 OTLP/HTTP JSON 的 ExportTraceServiceRequest 结构。
 * 纯函数，不发起网络请求——便于测试。
 */
export function toOTLP(rootSpan: Span, options: { serviceName?: string } = {}): OTLPPayload {
  const traceId = newTraceId();
  const spans: OTLPSpan[] = [];
  flatten(rootSpan, traceId, undefined, spans);

  const serviceAttrs: OTLPAttribute[] = [
    { key: 'service.name', value: { stringValue: options.serviceName ?? env('LOOP_OTEL_SERVICE_NAME', 'agentloop') } },
    { key: 'telemetry.sdk.name', value: { stringValue: 'agentloop' } },
  ];

  return {
    resourceSpans: [
      {
        resource: { attributes: serviceAttrs },
        scopeSpans: [{ scope: { name: 'agentloop.loop' }, spans }],
      },
    ],
  };
}

export interface ExportOptions {
  endpoint?: string;
  serviceName?: string;
  /** 注入自定义 fetch（测试用 mock） */
  fetchImpl?: typeof fetch;
}

/**
 * 把 Span 树导出到 OTLP/HTTP 端点。
 * 端点为空时不导出（返回 skipped）。失败只 warn，不抛——best-effort，绝不影响主流程。
 */
export async function exportTrace(rootSpan: Span, options: ExportOptions = {}): Promise<{
  exported: boolean;
  spanCount: number;
  error?: string;
}> {
  const endpoint = options.endpoint ?? env('LOOP_OTEL_ENDPOINT', '');
  if (!endpoint) return { exported: false, spanCount: 0 };

  const payload = toOTLP(rootSpan, { serviceName: options.serviceName });
  const spanCount = payload.resourceSpans.reduce(
    (sum, rs) => sum + rs.scopeSpans.reduce((s, ss) => s + ss.spans.length, 0),
    0,
  );

  const fetchFn = options.fetchImpl ?? fetch;
  try {
    const resp = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.warn(`[otel] 导出失败：HTTP ${resp.status}`);
      return { exported: false, spanCount, error: `HTTP ${resp.status}` };
    }
    return { exported: true, spanCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[otel] 导出异常：${msg}`);
    return { exported: false, spanCount, error: msg };
  }
}
