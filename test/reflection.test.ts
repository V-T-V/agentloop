/**
 * reflection.ts Reflection Loop 的测试。
 *
 * 用 mock LLM 测试：critic 返回结构化批评、revise 返回修订版、
 * reflectionLoop 完整循环、severity 阈值判定、解析容错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { critique, revise, reflectionLoop, shouldRevise, parseCritique, type Critique, DEFAULT_REFLECTION } from '../src/reflection.ts';
import type { ChatResult, LLMClient, Message } from '../src/types.ts';

/** 返回固定 JSON 的假 LLM。H8: chat() 接收 input 参数以验证 responseFormat */
function mockLLM(responses: string[]): LLMClient & { lastResponseFormat?: unknown } {
  let i = 0;
  let lastRf: unknown;
  const obj = {
    isStub: true,
    supportsStream: false,
    async chat(input: { messages: Message[]; tools: unknown[]; responseFormat?: unknown }): Promise<ChatResult> {
      lastRf = input.responseFormat;
      const content = responses[i++] ?? responses[responses.length - 1] ?? '';
      return { message: { role: 'assistant', content }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    },
    async chatStream(): Promise<ChatResult> {
      const content = responses[i++] ?? '';
      return { message: { role: 'assistant', content }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    },
    get lastResponseFormat() { return lastRf; },
  };
  return obj as LLMClient & { lastResponseFormat?: unknown };
}

// —————————— parseCritique ——————————

test('parseCritique：正常 JSON 解析', () => {
  const c = parseCritique('{"issues":["太短"],"severity":"high","suggestedFix":"扩展到200字"}');
  assert.equal(c.severity, 'high');
  assert.equal(c.issues[0], '太短');
  assert.equal(c.suggestedFix, '扩展到200字');
});

test('parseCritique：markdown fence 容错', () => {
  const c = parseCritique('```json\n{"issues":[],"severity":"low","suggestedFix":""}\n```');
  assert.equal(c.severity, 'low');
});

test('parseCritique：非法 JSON 降级为 low', () => {
  const c = parseCritique('这不是 JSON');
  assert.equal(c.severity, 'low');
});

test('parseCritique：提取大括号内容', () => {
  const c = parseCritique('以下是批评：\n{"issues":["问题"],"severity":"medium","suggestedFix":"修复"}\n结束');
  assert.equal(c.severity, 'medium');
  assert.equal(c.issues[0], '问题');
});

// —————————— shouldRevise ——————————

test('shouldRevise：high >= medium 阈值 → true', () => {
  assert.ok(shouldRevise({ issues: [], severity: 'high', suggestedFix: '' }, 'medium'));
});

test('shouldRevise：low < medium 阈值 → false', () => {
  assert.ok(!shouldRevise({ issues: [], severity: 'low', suggestedFix: '' }, 'medium'));
});

test('shouldRevise：medium >= medium 阈值 → true', () => {
  assert.ok(shouldRevise({ issues: [], severity: 'medium', suggestedFix: '' }, 'medium'));
});

test('shouldRevise：默认阈值 medium', () => {
  assert.ok(shouldRevise({ issues: [], severity: 'medium', suggestedFix: '' }));
  assert.ok(!shouldRevise({ issues: [], severity: 'low', suggestedFix: '' }));
});

// —————————— critique ——————————

test('critique：返回结构化批评', async () => {
  const llm = mockLLM(['{"issues":["内容太短"],"severity":"high","suggestedFix":"扩展内容"}']);
  const c = await critique(llm, '很短的回答', '写一篇简介');
  assert.equal(c.severity, 'high');
  assert.ok(c.issues.length > 0);
});

test('critique：LLM 失败降级为 low', async () => {
  const llm: LLMClient = {
    isStub: true,
    supportsStream: false,
    async chat(): Promise<ChatResult> { throw new Error('LLM down'); },
    async chatStream(): Promise<ChatResult> { throw new Error('LLM down'); },
  };
  const c = await critique(llm, '回答', '任务');
  assert.equal(c.severity, 'low');
});

test('H8: critique 传入 responseFormat json_object', async () => {
  const llm = mockLLM(['{"issues":[],"severity":"low","suggestedFix":""}']);
  await critique(llm, '回答', '任务');
  // 验证 responseFormat 被正确传入（mock 通过 input 参数捕获）
  assert.ok((llm as { lastResponseFormat?: unknown }).lastResponseFormat !== undefined, 'responseFormat 应被传入');
  const rf = (llm as { lastResponseFormat?: { type?: string } }).lastResponseFormat;
  assert.equal(rf?.type, 'json_object');
});

// —————————— revise ——————————

test('revise：返回修订内容', async () => {
  const llm = mockLLM(['这是修订后的更长更详细的回答版本。']);
  const c: Critique = { issues: ['太短'], severity: 'high', suggestedFix: '扩展' };
  const revised = await revise(llm, '短回答', c, '写简介');
  assert.ok(revised.includes('修订后'));
});

test('revise：LLM 失败返回原文', async () => {
  const llm: LLMClient = {
    isStub: true,
    supportsStream: false,
    async chat(): Promise<ChatResult> { throw new Error('fail'); },
    async chatStream(): Promise<ChatResult> { throw new Error('fail'); },
  };
  const c: Critique = { issues: [], severity: 'high', suggestedFix: '' };
  const revised = await revise(llm, '原文', c, '任务');
  assert.equal(revised, '原文');
});

// —————————— reflectionLoop ——————————

test('reflectionLoop：未启用时直接返回原文', async () => {
  const llm = mockLLM(['should not be called']);
  const result = await reflectionLoop(llm, '原始回答', '任务', { ...DEFAULT_REFLECTION, enabled: false });
  assert.equal(result.answer, '原始回答');
  assert.equal(result.revised, false);
  assert.equal(result.critiques.length, 0);
});

test('reflectionLoop：critic 说 low → 不修订', async () => {
  const llm = mockLLM(['{"issues":[],"severity":"low","suggestedFix":""}']);
  const result = await reflectionLoop(llm, '原始回答', '任务', { enabled: true, maxRevisions: 2, minSeverityToRevise: 'medium' });
  assert.equal(result.answer, '原始回答');
  assert.equal(result.revised, false);
  assert.equal(result.critiques.length, 1);
});

test('reflectionLoop：critic 说 high → 修订', async () => {
  const llm = mockLLM([
    '{"issues":["太短"],"severity":"high","suggestedFix":"扩展"}', // 第一次 critic
    '修订后的详细回答，内容更长更充分。', // 第一次 revise
    '{"issues":[],"severity":"low","suggestedFix":""}', // 第二次 critic（合格）
  ]);
  const result = await reflectionLoop(llm, '短', '任务', { enabled: true, maxRevisions: 2, minSeverityToRevise: 'medium' });
  assert.equal(result.revised, true);
  assert.ok(result.answer.includes('修订后'));
  assert.equal(result.critiques.length, 2); // 两次 critic
});

test('reflectionLoop：maxRevisions 限制修订次数', async () => {
  // critic 每次都说 high，修订每次都不同——但 maxRevisions=1 只允许 1 次修订
  const llm = mockLLM([
    '{"issues":["问题"],"severity":"high","suggestedFix":"修"}',
    '第一次修订',
    '{"issues":["还是问题"],"severity":"high","suggestedFix":"再修"}',
    '第二次修订',
  ]);
  const result = await reflectionLoop(llm, '原文', '任务', { enabled: true, maxRevisions: 1, minSeverityToRevise: 'medium' });
  assert.equal(result.revised, true);
  // maxRevisions=1 → critic 调用 2 次（修订前 + 修订后各一次），但实际只修订 1 次
  assert.ok(result.critiques.length <= 2);
});

test('reflectionLoop：修订无变化时停止', async () => {
  const llm = mockLLM([
    '{"issues":["问题"],"severity":"high","suggestedFix":"修"}',
    '原文', // revise 返回和原文一样
  ]);
  const result = await reflectionLoop(llm, '原文', '任务', { enabled: true, maxRevisions: 3, minSeverityToRevise: 'medium' });
  assert.equal(result.revised, false); // 修订无变化
  assert.equal(result.answer, '原文');
});

// —————————— 配置 ——————————

test('DEFAULT_REFLECTION：默认禁用', () => {
  assert.equal(DEFAULT_REFLECTION.enabled, false);
  assert.equal(DEFAULT_REFLECTION.maxRevisions, 2);
});
