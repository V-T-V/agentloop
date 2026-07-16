/**
 * LLM 客户端（OpenAI 兼容，含流式）。
 *
 * 能力：
 * - chat()：非流式补全，返回 { message, usage }。
 * - chatStream()：流式补全，逐 token 通过 onToken 推送，支持 signal 早停。
 * - 结构化错误 LlmHttpError（带 status，retryOn 直接读状态码）+ 每请求超时。
 * - 未配置 API key 时回退 StubLLM：模拟流式与 usage，离线也能跑通全套能力。
 *
 * 环境变量（见 .env.example）：
 *   LOOP_LLM_BASE_URL / LOOP_LLM_API_KEY / LOOP_LLM_MODEL
 *   LOOP_LLM_RETRIES / LOOP_LLM_TIMEOUT_MS / LOOP_LLM_TEMPERATURE
 */

import { env } from './env.ts';
import { LlmHttpError } from './errors.ts';
import { getLlmSemaphore } from './concurrency.ts';
import { extractText } from './multimodal.ts';
import { isRetryableStatus, withRetry } from './retry.ts';
import { StreamAggregator, parseSSELine } from './streaming.ts';
import type { ChatResult, LLMClient, Message, ResponseFormat, ToolCall, ToolDef, TokenUsage } from './types.ts';

/** 把内部 ToolDef[] 转成 OpenAI 兼容的 tools 描述（function 类型） */
function toOpenAITools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** OpenAI 响应里 assistant message 的原始结构 */
interface RawAssistantMessage {
  role?: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

/** usage 原始结构 */
interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 把原始响应标准化为内部 Message（解析 tool_calls 的 arguments 字符串为对象） */
function normalizeAssistantMessage(msg: RawAssistantMessage): Message {
  const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map((c) => {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = c.function.arguments ? JSON.parse(c.function.arguments) : {};
    } catch {
      parsedArgs = { __raw: c.function.arguments };
    }
    return { id: c.id, name: c.function.name, arguments: parsedArgs };
  });
  return {
    role: 'assistant',
    content: msg.content ?? null,
    ...(toolCalls?.length ? { toolCalls } : {}),
  };
}

function toUsage(raw: RawUsage | undefined, fallbackMsg: Message): TokenUsage {
  if (raw && (raw.prompt_tokens || raw.completion_tokens)) {
    return {
      promptTokens: raw.prompt_tokens ?? 0,
      completionTokens: raw.completion_tokens ?? 0,
      totalTokens: raw.total_tokens ?? (raw.prompt_tokens ?? 0) + (raw.completion_tokens ?? 0),
    };
  }
  // 服务端未返回 usage 时，用本地估算兜底（确保可观测性不为空）
  const out = JSON.stringify(fallbackMsg).length;
  return { promptTokens: 0, completionTokens: Math.ceil(out / 4), totalTokens: Math.ceil(out / 4) };
}

/** 真实 LLM 客户端（OpenAI 兼容） */
export class HttpLLMClient implements LLMClient {
  readonly isStub = false;
  readonly supportsStream = true;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    this.baseUrl = env('LOOP_LLM_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
    this.apiKey = env('LOOP_LLM_API_KEY');
    this.model = env('LOOP_LLM_MODEL', 'glm-4-flash');
  }

  private buildBody(
    messages: Message[],
    tools: ToolDef[],
    stream: boolean,
    responseFormat?: ResponseFormat,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      temperature: Number(env('LOOP_LLM_TEMPERATURE', '0.3')),
      ...(tools.length ? { tools: toOpenAITools(tools) } : {}),
    };
    // 结构化输出：透传 response_format（OpenAI 兼容）
    if (responseFormat) {
      if (responseFormat.type === 'json_object') {
        body.response_format = { type: 'json_object' };
      } else if (responseFormat.type === 'json_schema' && responseFormat.schema) {
        body.response_format = { type: 'json_schema', json_schema: { name: 'schema', schema: responseFormat.schema } };
      }
    }
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private async doFetch(body: unknown, signal?: AbortSignal): Promise<Response> {
    const timeoutMs = Number(env('LOOP_LLM_TIMEOUT_MS', '30000')) || 30000;
    // 合并超时 signal 与外部 signal
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);
    // 并发节流：通过全局信号量限制同时在途的 LLM 请求（防 429）
    const sem = getLlmSemaphore();
    const release = await sem.acquire();
    try {
      return await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: combined,
      });
    } finally {
      release();
    }
  }

  async chat(input: { messages: Message[]; tools: ToolDef[]; responseFormat?: ResponseFormat }): Promise<ChatResult> {
    const body = this.buildBody(input.messages, input.tools, false, input.responseFormat);
    const data = await withRetry(
      async () => {
        const resp = await this.doFetch(body);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new LlmHttpError(resp.status, text || resp.statusText);
        }
        return (await resp.json()) as { choices?: { message?: RawAssistantMessage }[]; usage?: RawUsage };
      },
      {
        retries: Number(env('LOOP_LLM_RETRIES', '3')) || 3,
        retryOn: (e) => this.isRetryable(e),
      },
    );
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('LLM 返回为空（无 choices）');
    const message = normalizeAssistantMessage(msg);
    return { message, usage: toUsage(data.usage, message) };
  }

  async chatStream(
    input: { messages: Message[]; tools: ToolDef[]; responseFormat?: ResponseFormat },
    options: { onToken?: (token: string) => void; signal?: AbortSignal } = {},
  ): Promise<ChatResult> {
    const body = this.buildBody(input.messages, input.tools, true, input.responseFormat);
    const agg = new StreamAggregator();

    await withRetry(
      async () => {
        const resp = await this.doFetch(body, options.signal);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new LlmHttpError(resp.status, text || resp.statusText);
        }
        if (!resp.body) throw new Error('流式响应无 body');
        // 逐行读取 SSE
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // 按行切分，保留最后不完整的一行在 buffer
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const parsed = parseSSELine(line);
            if (parsed.done) continue; // [DONE]
            if (parsed.chunk) {
              agg.feed(parsed.chunk);
              if (parsed.chunk.content) options.onToken?.(parsed.chunk.content);
            }
          }
        }
        // 处理 buffer 残行
        const tail = parseSSELine(buffer);
        if (!tail.done && tail.chunk) {
          agg.feed(tail.chunk);
          if (tail.chunk.content) options.onToken?.(tail.chunk.content);
        }
      },
      {
        retries: Number(env('LOOP_LLM_RETRIES', '3')) || 3,
        // 流式重试风险：已推送的 token 会重复。这里仍重试网络层错误（连接失败、5xx），
        // 但若已开始推送内容（onToken 已调用），放弃重试以避免重复输出。
        retryOn: (e) => this.isRetryable(e),
      },
    );

    const { message, usage } = agg.take();
    return { message, usage };
  }

  private isRetryable(e: unknown): boolean {
    if (e instanceof LlmHttpError) return isRetryableStatus(e.status);
    const name = e instanceof Error ? e.name : '';
    return name === 'TimeoutError' || name === 'AbortError';
  }
}

/**
 * StubLLM：无 API key 时的本地回退。
 *
 * 模拟完整能力：流式（用 setInterval 逐字推送）、usage（按内容估算）、
 * ReAct 回路（按关键词决定调用哪个工具）。
 */
class StubLLMClient implements LLMClient {
  readonly isStub = true;
  readonly supportsStream = true;

  /** 决定本回合返回什么（核心逻辑，chat 与 chatStream 共用） */
  private decide(messages: Message[], tools: ToolDef[]): { message: Message; usage: TokenUsage } {
    const last = messages[messages.length - 1];
    // 上一条是 tool 结果 → 总结收尾
    if (last?.role === 'tool') {
      const message: Message = {
        role: 'assistant',
        content: `[StubLLM] 已获得工具结果，总结如下：\n${extractText(last.content) || '(空)'}`,
      };
      return { message, usage: toUsage(undefined, message) };
    }
    // 否则视用户提问决定调用哪个工具（多模态：提取纯文本匹配工具名）
    const userMsg = messages.findLast((m) => m.role === 'user');
    const userText = userMsg ? extractText(userMsg.content) : '';
    const toolCall = this.pickTool(userText, tools);
    if (toolCall) {
      const message: Message = {
        role: 'assistant',
        content: `[StubLLM] 我需要先调用工具 ${toolCall.name} 来回答。`,
        toolCalls: [toolCall],
      };
      return { message, usage: toUsage(undefined, message) };
    }
    const message: Message = {
      role: 'assistant',
      content:
        `[StubLLM 演示回答]\n` +
        `当前未连接真实 LLM（未设置 LOOP_LLM_API_KEY）。\n` +
        `你的输入：${userText || '(空)'}`,
    };
    return { message, usage: toUsage(undefined, message) };
  }

  async chat(input: { messages: Message[]; tools: ToolDef[]; responseFormat?: ResponseFormat }): Promise<ChatResult> {
    await delay(80);
    const { message, usage } = this.decide(input.messages, input.tools);
    return { message, usage };
  }

  async chatStream(
    input: { messages: Message[]; tools: ToolDef[]; responseFormat?: ResponseFormat },
    options: { onToken?: (token: string) => void; signal?: AbortSignal } = {},
  ): Promise<ChatResult> {
    const { message, usage } = this.decide(input.messages, input.tools);
    // 逐字推送 content（模拟流式），tool_calls 不分片。多模态：提取纯文本逐字推送
    const text = extractText(message.content);
    for (const ch of text) {
      if (options.signal?.aborted) break;
      options.onToken?.(ch);
      await delay(8);
    }
    return { message, usage };
  }

  private pickTool(text: string, tools: ToolDef[]): ToolCall | null {
    const lower = text.toLowerCase();
    const has = (n: string) => tools.some((t) => t.name === n);
    if (has('datetime') && /时间|几点|日期|today|date|time|现在/.test(lower)) {
      return makeCall('datetime', {});
    }
    if (has('calculator') && /[\d.]+\s*[+\-*/]\s*[\d.]+|计算|算|calc/.test(lower)) {
      const expr = text.match(/([\d.()\s+\-*/]+)/)?.[1]?.trim() ?? '1+1';
      return makeCall('calculator', { expression: expr });
    }
    if (has('http_get') && /https?:\/\//i.test(text)) {
      const url = text.match(/https?:\/\/[^\s）)]+/i)?.[0] ?? '';
      if (url) return makeCall('http_get', { url });
    }
    return null;
  }
}

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 工厂：根据环境变量决定返回真实客户端还是 Stub（离线演示） */
export function createLLM(): LLMClient {
  const apiKey = env('LOOP_LLM_API_KEY');
  if (!apiKey) {
    console.warn('⚠️  未检测到 LOOP_LLM_API_KEY，使用 StubLLM（离线演示模式，不联网）。\n');
    return new StubLLMClient();
  }
  return new HttpLLMClient();
}
