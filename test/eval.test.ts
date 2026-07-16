/**
 * eval.ts LLM-as-judge 评估器的测试。
 *
 * 用 mock LLM（返回固定 JSON）验证：rubric 解析、分数夹取、总分计算、
 * JSON 容错（代码块/噪声）、null 轨迹兜底、渲染。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTrajectory, renderEval, DEFAULT_RUBRIC } from '../src/eval.ts';
import type { Span } from '../src/trace.ts';
import type { ChatResult, LLMClient, Message } from '../src/types.ts';

function mockLLM(jsonResponse: string): LLMClient {
  return {
    isStub: false,
    supportsStream: false,
    async chat(): Promise<ChatResult> {
      const message: Message = { role: 'assistant', content: jsonResponse };
      return { message, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
    async chatStream(): Promise<ChatResult> {
      const message: Message = { role: 'assistant', content: jsonResponse };
      return { message, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  };
}

function fakeTrace(): Span {
  return {
    id: 's1',
    name: 'run',
    parentId: null,
    start: 0,
    end: 10,
    status: 'ok',
    attributes: {
      answer: '现在是 10 点',
      stopReason: 'final',
      'input.messages': [{ role: 'user', content: '现在几点' }],
    },
    children: [],
  };
}

const goodJson = JSON.stringify({
  scores: {
    tool_selection: 5,
    argument_quality: 5,
    efficiency: 4,
    error_recovery: 5,
    task_completion: 5,
    safety: 5,
  },
  reasoning: '工具选择合理，高效完成任务',
  suggestions: ['可以减少一步冗余调用'],
});

test('评估：解析 LLM 返回的 JSON，计算总分', async () => {
  const r = await evaluateTrajectory(fakeTrace(), { llm: mockLLM(goodJson) });
  // (5+5+4+5+5+5)/(6*5) = 29/30 ≈ 96.67 → 97
  assert.equal(r.overall, 97);
  assert.equal(r.scores['efficiency'], 4);
  assert.match(r.reasoning, /合理/);
  assert.equal(r.suggestions.length, 1);
});

test('评估：分数越界被夹到 1-5', async () => {
  const outOfRange = JSON.stringify({
    scores: { tool_selection: 99, argument_quality: -3, efficiency: 3, error_recovery: 3, task_completion: 3, safety: 3 },
    reasoning: 'x',
    suggestions: [],
  });
  const r = await evaluateTrajectory(fakeTrace(), { llm: mockLLM(outOfRange) });
  assert.equal(r.scores['tool_selection'], 5); // 99 → 5
  assert.equal(r.scores['argument_quality'], 1); // -3 → 1
});

test('评估：缺失维度记中性分 3', async () => {
  const partial = JSON.stringify({
    scores: { tool_selection: 5 }, // 只给了一个维度
    reasoning: '部分',
    suggestions: [],
  });
  const r = await evaluateTrajectory(fakeTrace(), { llm: mockLLM(partial) });
  assert.equal(r.scores['tool_selection'], 5);
  assert.equal(r.scores['efficiency'], 3); // 缺失 → 3
});

test('评估：JSON 包在 markdown 代码块里也能解析', async () => {
  const fenced = '```json\n' + goodJson + '\n```';
  const r = await evaluateTrajectory(fakeTrace(), { llm: mockLLM(fenced) });
  assert.equal(r.scores['tool_selection'], 5);
});

test('评估：JSON 前后有噪声文本也能解析', async () => {
  const noisy = `好的，以下是评估：\n${goodJson}\n希望有帮助。`;
  const r = await evaluateTrajectory(fakeTrace(), { llm: mockLLM(noisy) });
  assert.equal(r.scores['tool_selection'], 5);
});

test('评估：null 轨迹返回兜底结果（不调 LLM）', async () => {
  let called = false;
  const llm: LLMClient = {
    isStub: false,
    supportsStream: false,
    async chat() {
      called = true;
      return { message: { role: 'assistant', content: '{}' }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
    async chatStream() {
      called = true;
      return { message: { role: 'assistant', content: '{}' }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  };
  const r = await evaluateTrajectory(null, { llm });
  assert.equal(called, false); // null 轨迹不调 LLM
  assert.equal(r.overall, 60);
  assert.match(r.reasoning, /无可用轨迹/);
});

test('评估：judge 返回完全非 JSON 时降级而非抛错（best-effort）', async () => {
  // StubLLM 等非 judge 模型会返回自然语言而非 JSON
  const r = await evaluateTrajectory(fakeTrace(), {
    llm: mockLLM('[StubLLM] 我需要先调用工具 calculator 来回答。'),
  });
  assert.equal(r.overall, 60); // 降级中性分
  assert.match(r.reasoning, /无法解析/);
  assert.ok(r.suggestions.length > 0);
});

test('渲染：含各维度分数与建议', () => {
  const r = {
    scores: { tool_selection: 5, argument_quality: 4, efficiency: 3, error_recovery: 3, task_completion: 5, safety: 5 },
    overall: 83,
    reasoning: '整体不错',
    suggestions: ['建议A', '建议B'],
  };
  const text = renderEval(r);
  assert.match(text, /83\/100/);
  assert.match(text, /工具选择.*★★★★★/);
  assert.match(text, /建议A/);
  assert.match(text, /理由：整体不错/);
});

test('DEFAULT_RUBRIC：6 个维度', () => {
  assert.equal(DEFAULT_RUBRIC.length, 6);
  assert.ok(DEFAULT_RUBRIC.some((d) => d.key === 'task_completion'));
});
