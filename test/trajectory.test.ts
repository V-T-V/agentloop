/**
 * trajectory.ts 轨迹渲染的测试。
 *
 * 构造含内容捕获的 span 树，验证：事件提取、可读渲染、用户问题/最终答案提取。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractTrajectory, renderTrajectory, extractUserQuestion, extractFinalAnswer } from '../src/trajectory.ts';
import type { Span } from '../src/trace.ts';

/** 造一棵含内容捕获的完整轨迹树（run→step→{llm,tool}→收敛） */
function sampleTree(): Span {
  const llm1: Span = {
    id: 's3',
    name: 'llm',
    parentId: 's2',
    start: 5,
    end: 10,
    status: 'ok',
    attributes: {
      step: 1,
      'input.messages': [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '现在几点？' },
      ],
      'output.content': null,
      'output.toolCalls': [{ id: 'c1', name: 'datetime', arguments: {} }],
    },
    children: [],
  };
  const tool: Span = {
    id: 's4',
    name: 'tool',
    parentId: 's2',
    start: 10,
    end: 11,
    status: 'ok',
    attributes: {
      step: 1,
      tool: 'datetime',
      'input.arguments': {},
      'output.result': 'ISO: 2026-06-27T10:00:00.000Z',
      'output.ok': true,
    },
    children: [],
  };
  const llm2: Span = {
    id: 's6',
    name: 'llm',
    parentId: 's5',
    start: 12,
    end: 15,
    status: 'ok',
    attributes: {
      step: 2,
      'output.content': '现在是 10 点。',
      'output.toolCalls': [],
    },
    children: [],
  };
  const step1: Span = { id: 's2', name: 'step', parentId: 's1', start: 4, end: 11, status: 'ok', attributes: { step: 1 }, children: [llm1, tool] };
  const step2: Span = { id: 's5', name: 'step', parentId: 's1', start: 12, end: 15, status: 'ok', attributes: { step: 2 }, children: [llm2] };
  return {
    id: 's1',
    name: 'run',
    parentId: null,
    start: 0,
    end: 16,
    status: 'ok',
    attributes: { answer: '现在是 10 点。', stopReason: 'final' },
    children: [step1, step2],
  };
}

test('extractTrajectory：按时间顺序提取 llm/tool 事件', () => {
  const events = extractTrajectory(sampleTree());
  // step1: llm(调工具) + tool；step2: llm(最终答案)
  assert.equal(events.length, 3);
  assert.equal(events[0]!.kind, 'llm');
  assert.equal(events[1]!.kind, 'tool');
  assert.equal(events[2]!.kind, 'llm');
});

test('extractTrajectory：null 输入返回空', () => {
  assert.deepEqual(extractTrajectory(null), []);
});

test('extractTrajectory：携带捕获的内容属性', () => {
  const events = extractTrajectory(sampleTree());
  const toolEv = events.find((e) => e.kind === 'tool')!;
  assert.deepEqual(toolEv.attributes['input.arguments'], {});
  assert.match(String(toolEv.attributes['output.result']), /2026/);
});

test('renderTrajectory：生成可读文本', () => {
  const text = renderTrajectory(sampleTree());
  assert.match(text, /step 1/);
  assert.match(text, /datetime/);
  assert.match(text, /现在是 10 点/);
  assert.match(text, /🧠|🔧/);
});

test('renderTrajectory：null 返回占位', () => {
  assert.equal(renderTrajectory(null), '(无轨迹)');
});

test('renderTrajectory：sub-agent 嵌套用缩进体现', () => {
  // tool(delegate) 下挂一个子 run→step→llm
  const childLLM: Span = {
    id: 'c2',
    name: 'llm',
    parentId: 'c1',
    start: 0,
    end: 1,
    status: 'ok',
    attributes: { step: 1, 'output.content': '子任务结果', 'output.toolCalls': [] },
    children: [],
  };
  const delegateTool: Span = {
    id: 't1',
    name: 'tool',
    parentId: 'p1',
    start: 0,
    end: 2,
    status: 'ok',
    attributes: { step: 1, tool: 'delegate', 'input.arguments': { task: '子任务' }, 'output.result': '子任务结果' },
    children: [
      {
        id: 'cr',
        name: 'run',
        parentId: 't1',
        start: 0,
        end: 1,
        status: 'ok',
        attributes: {},
        children: [
          { id: 'c1', name: 'step', parentId: 'cr', start: 0, end: 1, status: 'ok', attributes: { step: 1 }, children: [childLLM] },
        ],
      },
    ],
  };
  const text = renderTrajectory({
    id: 'root',
    name: 'run',
    parentId: null,
    start: 0,
    end: 2,
    status: 'ok',
    attributes: {},
    children: [{ id: 'p1', name: 'step', parentId: 'root', start: 0, end: 2, status: 'ok', attributes: { step: 1 }, children: [delegateTool] }],
  });
  // 子 agent 的 llm 事件应出现在更深的缩进
  assert.match(text, /子任务结果/);
  // 验证缩进：子 agent 事件（delegate 在 depth 0，其子 llm 在 depth 1）应有 2 空格前缀
  assert.ok(new RegExp('^' + ' '.repeat(2) + '🧠', 'm').test(text), '应有深度缩进的子 agent 事件');
});

test('extractUserQuestion：取首条 user 消息', () => {
  assert.equal(extractUserQuestion(sampleTree()), '现在几点？');
});

test('extractFinalAnswer：取 run span 的 answer', () => {
  assert.equal(extractFinalAnswer(sampleTree()), '现在是 10 点。');
  assert.equal(extractFinalAnswer(null), '');
});
