/**
 * SSE 流式解析器：把 OpenAI 兼容的流式 chunk 增量聚合成最终的 Message + usage。
 *
 * SSE 格式约定（GLM-4 / OpenAI 通用）：
 *   data: {"choices":[{"delta":{"content":"你"},...}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{...}]}}, ...]}
 *   data: {"choices":[],"usage":{"prompt_tokens":..,"completion_tokens":..,"total_tokens":..}}
 *   data: [DONE]
 *
 * 关键点：
 * - content 是增量 delta，需逐段拼接到 buffer。
 * - tool_calls 的 arguments 也是增量字符串，需按 index 拼接；首次出现带 name/id。
 * - usage 通常在最后一个 chunk（设置 stream_options.include_usage）。
 * - [DONE] 表示流结束。
 *
 * 设计为「累加器」：喂入每个 data 行，最后 take() 得到完整结果。
 */

import type { Message, ToolCall, TokenUsage } from './types.ts';

/** 流式聚合器：逐 chunk 喂入，最后产出 Message 与 usage */
export class StreamAggregator {
  private content = '';
  private readonly toolCalls: Map<number, ToolCall> = new Map();
  private usage: TokenUsage | null = null;
  private role: string | null = null;

  /** 喂入一个 SSE data 行的 JSON 解析对象（已去掉 `data: ` 前缀、非 [DONE]） */
  feed(chunk: StreamChunk): void {
    if (chunk.role) this.role = chunk.role;
    if (chunk.content) this.content += chunk.content;
    if (chunk.toolCalls) {
      for (const delta of chunk.toolCalls) {
        const idx = delta.index ?? 0;
        const existing = this.toolCalls.get(idx);
        if (!existing) {
          // 首次出现：带 id 与 name
          this.toolCalls.set(idx, {
            id: delta.id ?? `call_${idx}`,
            name: delta.function?.name ?? '',
            arguments: delta.function?.arguments ? safeParseArgs(delta.function.arguments) : {},
          });
        } else {
          // 增量：拼接 arguments 字符串
          if (delta.function?.arguments) {
            existing.arguments = mergeArgs(existing.arguments, delta.function.arguments);
          }
        }
      }
    }
    if (chunk.usage) {
      this.usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      };
    }
  }

  /** 取出聚合后的最终助手消息（content 或 toolCalls 至少有一个） */
  take(): { message: Message; usage: TokenUsage | null } {
    const calls = [...this.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c);
    const message: Message = {
      role: 'assistant',
      content: this.content || null,
      ...(calls.length ? { toolCalls: calls } : {}),
    };
    return { message, usage: this.usage };
  }
}

/** SSE chunk 的相关字段（OpenAI delta 子集） */
export interface StreamChunk {
  role?: string;
  content?: string;
  toolCalls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** 把一条原始 SSE 行（`data: {...}`）解析为 StreamChunk 或 DONE 信号 */
export function parseSSELine(
  line: string,
): { done: boolean; chunk: StreamChunk | null } {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return { done: false, chunk: null };
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return { done: true, chunk: null };
  try {
    const json = JSON.parse(payload) as {
      choices?: { delta?: Record<string, unknown> }[];
      usage?: StreamChunk['usage'];
    };
    // delta 在 choices[0].delta；usage 可能在顶层（某些实现）或 delta 内
    const delta = (json.choices?.[0]?.delta ?? {}) as Record<string, unknown> & {
      role?: string;
      content?: string;
      toolCalls?: StreamChunk['toolCalls'];
      usage?: StreamChunk['usage'];
    };
    const chunk: StreamChunk = {
      role: delta.role,
      content: delta.content,
      // 兼容 snake_case：OpenAI/GLM SSE delta 用 `tool_calls`，本项目内部统一 camelCase。
      // 优先取 camelCase（已规整数据），否则回退 snake_case（原始 API 数据）。
      toolCalls: delta.toolCalls ?? normalizeToolCalls(delta.tool_calls),
      usage: json.usage ?? delta.usage,
    };
    return { done: false, chunk };
  } catch {
    // 偶发的非法 JSON 行（GLM 已知偶发问题），跳过而非崩溃
    return { done: false, chunk: null };
  }
}

/**
 * 把原始 snake_case `tool_calls` delta 数组规整为 StreamChunk.toolCalls。
 * OpenAI 流式增量字段：index / id / function{name,arguments}（snake_case 形态本就如此，
 * 仅外层 key 是 tool_calls；内层 function 的 name/arguments 已是无下划线的单层 key）。
 */
function normalizeToolCalls(
  raw: unknown,
): StreamChunk['toolCalls'] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const t = item as Record<string, unknown>;
    const fn = (t.function ?? {}) as { name?: string; arguments?: string };
    return {
      index: typeof t.index === 'number' ? t.index : undefined,
      id: typeof t.id === 'string' ? t.id : undefined,
      function: { name: fn.name, arguments: fn.arguments },
    };
  });
}

/** 安全解析增量 arguments 字符串；流式下 arguments 是分片到达的，解析失败返回原始串 */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return { __raw: raw };
  }
}

/** 把新到的 arguments 片段并入已有 args（处理「字符串已完整则覆盖、否则拼接」） */
function mergeArgs(
  existing: Record<string, unknown>,
  fragment: string,
): Record<string, unknown> {
  // 如果 existing 里存了 __raw（之前解析失败），就继续累积字符串再尝试
  if (existing.__raw !== undefined) {
    const combined = String(existing.__raw) + fragment;
    try {
      return JSON.parse(combined) as Record<string, unknown>;
    } catch {
      return { __raw: combined };
    }
  }
  // 已是合法对象：把 fragment 尝试解析后浅合并
  try {
    const parsed = JSON.parse(fragment) as Record<string, unknown>;
    return { ...existing, ...parsed };
  } catch {
    // fragment 不完整：保留 existing，忽略（最终 take 时若有残缺，工具入参校验会兜底）
    return existing;
  }
}
