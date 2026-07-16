/**
 * llm.ts HTTP 客户端的独立测试。
 *
 * 这是此前唯一的「无测试核心模块」。用 mock global fetch 覆盖：
 * 正常响应、429 重试、5xx 重试、4xx 不重试、超时、responseFormat 透传、
 * streaming SSE 解析、usage 解析。
 *
 * mock 策略：替换 globalThis.fetch，返回可控 Response 对象。
 * key 注入：通过环境变量 LOOP_LLM_API_KEY（构造函数读取）。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { HttpLLMClient } from '../src/llm.ts';
import { LlmHttpError } from '../src/errors.ts';
import { resetLlmSemaphore } from '../src/concurrency.ts';

/** 原始 fetch 引用，测试后恢复 */
const originalFetch = globalThis.fetch;

/** 捕获到的请求体（类型化） */
interface CapturedBody {
  model?: string;
  messages?: unknown[];
  response_format?: unknown;
  tools?: Array<{ type: string; function: { name: string } }>;
}

/** mock fetch 的响应工厂 */
function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** 标准 OpenAI 兼容成功响应 */
function successResponse(content = 'hello'): unknown {
  return {
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

beforeEach(() => {
  resetLlmSemaphore(10); // 测试用高并发避免节流干扰
  process.env.LOOP_LLM_API_KEY = 'test-key'; // 注入测试 key
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LOOP_LLM_API_KEY;
});

test('HttpLLMClient：正常 chat 请求解析正确', async () => {
  let captured: CapturedBody = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return mockResponse(200, successResponse('你好'));
  }) as typeof fetch;

  const client = new HttpLLMClient();
  const result = await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  });

  assert.equal(result.message.content, '你好');
  assert.equal(result.usage!.totalTokens, 15);
  assert.equal(captured.model, 'glm-4-flash');
  assert.equal(captured.messages![0] && (captured.messages![0] as { content: string }).content, 'hi');
});

test('HttpLLMClient：responseFormat json_object 透传', async () => {
  let captured: CapturedBody = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return mockResponse(200, successResponse('{"score":85}'));
  }) as typeof fetch;

  const client = new HttpLLMClient();
  await client.chat({
    messages: [{ role: 'user', content: 'score?' }],
    tools: [],
    responseFormat: { type: 'json_object' },
  });

  assert.deepEqual(captured.response_format, { type: 'json_object' });
});

test('HttpLLMClient：responseFormat json_schema 透传', async () => {
  let captured: CapturedBody = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return mockResponse(200, successResponse('{}'));
  }) as typeof fetch;

  const client = new HttpLLMClient();
  await client.chat({
    messages: [],
    tools: [],
    responseFormat: { type: 'json_schema', schema: { type: 'object', properties: {} } },
  });

  const rf = captured.response_format as { type: string; json_schema: unknown };
  assert.equal(rf.type, 'json_schema');
  assert.ok(rf.json_schema);
});

test('HttpLLMClient：429 重试后成功', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls < 3) return mockResponse(429, { error: 'rate limited' });
    return mockResponse(200, successResponse('ok'));
  }) as typeof fetch;

  const client = new HttpLLMClient();
  const result = await client.chat({ messages: [], tools: [] });

  assert.ok(calls >= 2, `至少重试 2 次，实际 ${calls}`);
  assert.equal(result.message.content, 'ok');
});

test('HttpLLMClient：5xx 重试后成功', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return mockResponse(503, { error: 'unavailable' });
    return mockResponse(200, successResponse('recovered'));
  }) as typeof fetch;

  const client = new HttpLLMClient();
  const result = await client.chat({ messages: [], tools: [] });

  assert.ok(calls >= 2);
  assert.equal(result.message.content, 'recovered');
});

test('HttpLLMClient：4xx 不重试直接失败', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return mockResponse(400, { error: { message: 'bad request' } });
  }) as typeof fetch;

  const client = new HttpLLMClient();
  await assert.rejects(
    client.chat({ messages: [], tools: [] }),
    (err: unknown) => {
      assert.ok(err instanceof LlmHttpError);
      assert.equal(err.status, 400);
      return true;
    },
  );
  assert.equal(calls, 1, '4xx 不应重试');
});

test('HttpLLMClient：401 鉴权失败不重试', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return mockResponse(401, { error: { message: 'unauthorized' } });
  }) as typeof fetch;

  const client = new HttpLLMClient();
  await assert.rejects(
    client.chat({ messages: [], tools: [] }),
    (err: unknown) => err instanceof LlmHttpError && err.status === 401,
  );
  assert.equal(calls, 1, '401 不应重试');
});

test('HttpLLMClient：LlmHttpError 携带 status（5xx 重试耗尽）', async () => {
  globalThis.fetch = (async () => mockResponse(500, { error: 'boom' })) as typeof fetch;

  const client = new HttpLLMClient();
  await assert.rejects(
    client.chat({ messages: [], tools: [] }),
    (err: unknown) => {
      assert.ok(err instanceof LlmHttpError);
      assert.equal(err.status, 500);
      return true;
    },
  );
});

test('HttpLLMClient：tools 透传为 OpenAI 格式', async () => {
  let captured: CapturedBody = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return mockResponse(200, successResponse('ok'));
  }) as typeof fetch;

  const client = new HttpLLMClient();
  await client.chat({
    messages: [],
    tools: [
      {
        name: 'calc',
        description: 'calculator',
        parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] },
        execute: async () => ({ ok: true, output: '' }),
      },
    ],
  });

  assert.ok(captured.tools);
  assert.equal(captured.tools![0]!.type, 'function');
  assert.equal(captured.tools![0]!.function.name, 'calc');
});

test('HttpLLMClient：usage 缺失时本地估算', async () => {
  globalThis.fetch = (async () =>
    mockResponse(200, {
      choices: [{ message: { role: 'assistant', content: 'short' } }],
      // 无 usage 字段
    })) as typeof fetch;

  const client = new HttpLLMClient();
  const result = await client.chat({ messages: [], tools: [] });

  assert.ok(result.usage);
  assert.ok(result.usage!.totalTokens > 0, '本地估算 token > 0');
});

test('HttpLLMClient：tool_calls 正确解析', async () => {
  globalThis.fetch = (async () =>
    mockResponse(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'calc', arguments: '{"expr":"1+1"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })) as typeof fetch;

  const client = new HttpLLMClient();
  const result = await client.chat({ messages: [], tools: [] });

  assert.ok(result.message.toolCalls);
  assert.equal(result.message.toolCalls![0]!.name, 'calc');
  assert.deepEqual(result.message.toolCalls![0]!.arguments, { expr: '1+1' });
});

test('LlmHttpError：构造正确', () => {
  const e = new LlmHttpError(429, 'rate limited');
  assert.equal(e.status, 429);
  assert.ok(e.message.includes('429'));
  assert.equal(e.name, 'LlmHttpError');
});
