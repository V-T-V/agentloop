/**
 * debug.ts 调试工具的测试（R8）。
 *
 * 覆盖：状态快照导出/反序列化、事件录制/回放/汇总/时间线、时序甘特图、调试包。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  exportSnapshot,
  serializeSnapshot,
  parseSnapshot,
  EventRecorder,
  serializeEventLog,
  parseEventLog,
  summarizeEventLog,
  renderEventTimeline,
  renderTimingDiagram,
  buildDebugBundle,
  type EventLog,
} from '../src/debug.ts';
import { Tracer } from '../src/trace.ts';
import type { LoopEvent, Message, TokenUsage } from '../src/types.ts';

const U: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function toolCallEvent(step: number, name: string): LoopEvent {
  return { type: 'tool_call', step, call: { id: `c${step}`, name, arguments: {} } };
}

// —————————— 状态快照导出 ——————————

test('exportSnapshot：生成完整 StateSnapshot 结构', () => {
  const messages: Message[] = [{ role: 'system', content: 'sys' }];
  const snap = exportSnapshot({
    messages,
    totalUsage: U,
    stopReason: 'final',
    answer: 'done',
    reason: 'test',
  });
  assert.equal(snap.__schema, 'agentloop-snapshot');
  assert.equal(snap.version, 1);
  assert.equal(snap.meta.reason, 'test');
  assert.equal(snap.stopReason, 'final');
  assert.equal(snap.answer, 'done');
  assert.deepEqual(snap.totalUsage, U);
});

test('exportSnapshot：messages 深拷贝（修改原数组不影响快照）', () => {
  const messages: Message[] = [{ role: 'system', content: 'sys' }];
  const snap = exportSnapshot({ messages, totalUsage: U });
  messages.push({ role: 'user', content: 'extra' });
  assert.equal(snap.messages.length, 1, '快照不受原数组后续修改影响');
});

test('exportSnapshot：含预算快照', () => {
  const snap = exportSnapshot({
    messages: [],
    totalUsage: U,
    budget: { spent: 500, limit: 1000, estimatedCost: 0.01, exhausted: false, warningIssued: false },
  });
  assert.ok(snap.budget);
  assert.equal(snap.budget!.spent, 500);
});

test('exportSnapshot：meta.capturedAt 为合法 ISO', () => {
  const snap = exportSnapshot({ messages: [], totalUsage: U });
  const t = new Date(snap.meta.capturedAt).getTime();
  assert.ok(Number.isFinite(t));
});

// —————————— 快照序列化往返 ——————————

test('serializeSnapshot/parseSnapshot：往返保持一致', () => {
  const snap = exportSnapshot({
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    totalUsage: U,
    answer: '答案',
    stopReason: 'final',
  });
  const json = serializeSnapshot(snap);
  const restored = parseSnapshot(json);
  assert.ok(restored);
  assert.deepEqual(restored!.messages, snap.messages);
  assert.equal(restored!.answer, '答案');
});

test('parseSnapshot：非 agentloop-snapshot schema 返回 null', () => {
  const json = JSON.stringify({ __schema: 'other', version: 1, messages: [] });
  assert.equal(parseSnapshot(json), null);
});

test('parseSnapshot：版本不匹配返回 null', () => {
  const json = JSON.stringify({ __schema: 'agentloop-snapshot', version: 99, messages: [] });
  assert.equal(parseSnapshot(json), null);
});

test('parseSnapshot：非法 JSON 返回 null', () => {
  assert.equal(parseSnapshot('{broken'), null);
});

test('parseSnapshot：messages 非数组返回 null', () => {
  const json = JSON.stringify({ __schema: 'agentloop-snapshot', version: 1, messages: 'notarray' });
  assert.equal(parseSnapshot(json), null);
});

// —————————— EventRecorder ——————————

test('EventRecorder：record 收集事件', () => {
  const rec = new EventRecorder();
  rec.record({ type: 'final', answer: 'x' });
  rec.record({ type: 'max_steps', steps: 8 });
  assert.equal(rec.length, 2);
});

test('EventRecorder：filterByType 按类型过滤', () => {
  const rec = new EventRecorder();
  rec.record(toolCallEvent(1, 'calc'));
  rec.record(toolCallEvent(2, 'datetime'));
  rec.record({ type: 'final', answer: 'done' });
  const calls = rec.filterByType('tool_call');
  assert.equal(calls.length, 2);
});

test('EventRecorder：exportLog 生成可序列化日志', () => {
  const rec = new EventRecorder();
  rec.record({ type: 'final', answer: 'ok' });
  const log = rec.exportLog();
  assert.equal(log.__schema, 'agentloop-eventlog');
  assert.equal(log.version, 1);
  assert.equal(log.events.length, 1);
  assert.ok(log.events[0]!.atMs >= 0);
});

test('EventRecorder：可作为 runLoop onEvent 回调（函数引用）', () => {
  const rec = new EventRecorder();
  const callback: (e: LoopEvent) => void = rec.record;
  callback({ type: 'final', answer: 'x' });
  assert.equal(rec.length, 1);
});

// —————————— EventLog 序列化往返 ——————————

test('serializeEventLog/parseEventLog：往返保持一致', () => {
  const rec = new EventRecorder();
  rec.record(toolCallEvent(1, 'calc'));
  rec.record({ type: 'final', answer: 'done' });
  const log = rec.exportLog();
  const json = serializeEventLog(log);
  const restored = parseEventLog(json);
  assert.ok(restored);
  assert.equal(restored!.events.length, 2);
});

test('parseEventLog：非 agentloop-eventlog schema 返回 null', () => {
  assert.equal(parseEventLog(JSON.stringify({ __schema: 'other', version: 1, events: [] })), null);
});

test('parseEventLog：非法 JSON 返回 null', () => {
  assert.equal(parseEventLog('{broken'), null);
});

// —————————— summarizeEventLog ——————————

test('summarizeEventLog：统计各类事件计数', () => {
  const log: EventLog = {
    __schema: 'agentloop-eventlog',
    version: 1,
    startedAt: new Date().toISOString(),
    events: [
      { atMs: 0, event: toolCallEvent(1, 'a') },
      { atMs: 10, event: toolCallEvent(2, 'b') },
      { atMs: 20, event: { type: 'compact', step: 2, beforeTokens: 1000, afterTokens: 500, beforeMessages: 20, afterMessages: 8 } },
      { atMs: 30, event: { type: 'final', answer: '答案' } },
    ],
  };
  const summary = summarizeEventLog(log);
  assert.equal(summary.totalEvents, 4);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.compacts, 1);
  assert.equal(summary.finalAnswer, '答案');
  assert.equal(summary.durationMs, 30);
  assert.equal(summary.counts['tool_call'], 2);
});

test('summarizeEventLog：错误事件计数', () => {
  const log: EventLog = {
    __schema: 'agentloop-eventlog',
    version: 1,
    startedAt: new Date().toISOString(),
    events: [
      { atMs: 0, event: { type: 'error', message: '失败1' } },
      { atMs: 5, event: { type: 'error', message: '失败2' } },
    ],
  };
  const summary = summarizeEventLog(log);
  assert.equal(summary.errors, 2);
  assert.equal(summary.finalAnswer, undefined);
});

test('summarizeEventLog：空日志', () => {
  const log: EventLog = {
    __schema: 'agentloop-eventlog',
    version: 1,
    startedAt: new Date().toISOString(),
    events: [],
  };
  const summary = summarizeEventLog(log);
  assert.equal(summary.totalEvents, 0);
  assert.equal(summary.durationMs, 0);
});

// —————————— renderEventTimeline ——————————

test('renderEventTimeline：输出含时间线标题与各事件', () => {
  const log: EventLog = {
    __schema: 'agentloop-eventlog',
    version: 1,
    startedAt: new Date().toISOString(),
    events: [
      { atMs: 0, event: toolCallEvent(1, 'calc') },
      { atMs: 100, event: { type: 'final', answer: '完成' } },
    ],
  };
  const text = renderEventTimeline(log);
  assert.match(text, /时间线/);
  assert.match(text, /calc/);
  assert.match(text, /最终/);
});

test('renderEventTimeline：含 budget_exceeded/budget 事件描述', () => {
  const log: EventLog = {
    __schema: 'agentloop-eventlog',
    version: 1,
    startedAt: new Date().toISOString(),
    events: [{ atMs: 0, event: { type: 'budget_exceeded', spent: 1000, limit: 1000, answer: '超限' } }],
  };
  const text = renderEventTimeline(log);
  assert.match(text, /预算/);
  assert.match(text, /1000/);
});

// —————————— renderTimingDiagram ——————————

test('renderTimingDiagram：null trace 返回占位', () => {
  assert.equal(renderTimingDiagram(null), '(无 trace)');
});

test('renderTimingDiagram：输出含甘特条与 span 树', () => {
  const tracer = new Tracer();
  const root = tracer.startSpan('run');
  const step = tracer.startSpan('step', { step: 1 });
  const llm = tracer.startSpan('llm', { step: 1 });
  tracer.setUsage(llm, U);
  tracer.endSpan(llm);
  tracer.endSpan(step);
  tracer.endSpan(root);
  const tree = tracer.getRoot();
  assert.ok(tree);
  const text = renderTimingDiagram(tree);
  assert.match(text, /时序图/);
  assert.match(text, /█/);
  assert.match(text, /run/);
  assert.match(text, /step/);
  assert.match(text, /llm/);
  assert.match(text, /15tok/, '含 usage 标注');
});

test('renderTimingDiagram：error span 标记 ✗', () => {
  const tracer = new Tracer();
  const root = tracer.startSpan('run');
  const bad = tracer.startSpan('tool', { tool: 'x' });
  tracer.setError(bad);
  tracer.endSpan(bad);
  tracer.endSpan(root);
  const text = renderTimingDiagram(tracer.getRoot());
  assert.match(text, /✗/);
});

// —————————— buildDebugBundle ——————————

test('buildDebugBundle：生成快照+时序图+事件日志', () => {
  const tracer = new Tracer();
  const root = tracer.startSpan('run');
  tracer.endSpan(root);
  const bundle = buildDebugBundle({
    messages: [{ role: 'system', content: 'sys' }],
    totalUsage: U,
    trace: tracer.getRoot(),
    answer: '完成',
    stopReason: 'final',
    events: {
      __schema: 'agentloop-eventlog',
      version: 1,
      startedAt: new Date().toISOString(),
      events: [{ atMs: 0, event: { type: 'final', answer: '完成' } }],
    },
  });
  assert.ok(bundle.snapshot);
  assert.equal(bundle.snapshot.answer, '完成');
  assert.ok(bundle.timingDiagram.length > 0);
  assert.ok(bundle.eventLog);
});

test('buildDebugBundle：无事件日志时 eventLog 为 undefined', () => {
  const tracer = new Tracer();
  const root = tracer.startSpan('run');
  tracer.endSpan(root);
  const bundle = buildDebugBundle({
    messages: [],
    totalUsage: U,
    trace: tracer.getRoot(),
    answer: '',
    stopReason: 'final',
  });
  assert.equal(bundle.eventLog, undefined);
});

// —————————— 端到端：录制 runLoop 事件并回放 ——————————

test('端到端：EventRecorder 录制 runLoop 全过程并汇总', async () => {
  const { runLoop } = await import('../src/loop.ts');
  const rec = new EventRecorder();
  const result = await runLoop({
    llm: {
      isStub: true,
      supportsStream: false,
      async chat() {
        return { message: { role: 'assistant', content: '最终答案' }, usage: U };
      },
      async chatStream() {
        return { message: { role: 'assistant', content: '最终答案' }, usage: U };
      },
    },
    tools: [],
    system: 'sys',
    user: 'q',
    stream: false,
    onEvent: rec.record,
  });
  const log = rec.exportLog();
  const summary = summarizeEventLog(log);
  assert.ok(summary.totalEvents > 0);
  assert.equal(summary.finalAnswer, '最终答案');
  assert.equal(result.answer, '最终答案');
});
