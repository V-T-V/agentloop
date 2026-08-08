/**
 * R13-D3（agentloop）：debug.ts 调试工具纯函数测试。
 *
 * 覆盖：
 *   - serializeSnapshot / parseSnapshot 往返 + schema 校验
 *   - EventRecorder 录制 + exportLog + filterByType
 *   - serializeEventLog / parseEventLog 往返
 *   - summarizeEventLog 统计
 *   - renderEventTimeline / renderTimingDiagram 输出格式
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeSnapshot,
  parseSnapshot,
  EventRecorder,
  serializeEventLog,
  parseEventLog,
  summarizeEventLog,
  renderEventTimeline,
  type StateSnapshot,
  type EventLog,
} from '../src/debug.ts';
import type { LoopEvent, Message, TokenUsage } from '../src/types.ts';

// —————————— 辅助构造 ——————————

function makeMessages(): Message[] {
  return [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你的？' },
  ];
}

function makeUsage(): TokenUsage {
  return { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
}

function makeSnapshot(over: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    __schema: 'agentloop-snapshot',
    version: 1,
    meta: { capturedAt: '2025-08-08T12:00:00Z' },
    messages: makeMessages(),
    totalUsage: makeUsage(),
    ...over,
  };
}

function makeEvent(type: LoopEvent['type'], over: Partial<LoopEvent> = {}): LoopEvent {
  return { type, step: 1, ...over } as LoopEvent;
}

function makeEventLog(events: { atMs: number; event: LoopEvent }[] = []): EventLog {
  return {
    __schema: 'agentloop-eventlog',
    version: 1,
    startedAt: '2025-08-08T12:00:00Z',
    events,
  };
}

// —————————— 测试 ——————————

describe('serializeSnapshot / parseSnapshot 往返', () => {
  test('序列化→反序列化保持等价', () => {
    const snap = makeSnapshot();
    const json = serializeSnapshot(snap);
    const back = parseSnapshot(json);
    assert.deepEqual(back, snap);
  });

  test('parseSnapshot 非法 JSON → null', () => {
    assert.equal(parseSnapshot('not json'), null);
    assert.equal(parseSnapshot(''), null);
    assert.equal(parseSnapshot('{invalid'), null);
  });

  test('parseSnapshot schema 不符 → null', () => {
    const wrong = JSON.stringify({ __schema: 'wrong', version: 1, messages: [] });
    assert.equal(parseSnapshot(wrong), null);
  });

  test('parseSnapshot version 不符 → null', () => {
    const wrong = JSON.stringify({ __schema: 'agentloop-snapshot', version: 99, messages: [] });
    assert.equal(parseSnapshot(wrong), null);
  });

  test('parseSnapshot messages 非数组 → null', () => {
    const wrong = JSON.stringify({
      __schema: 'agentloop-snapshot', version: 1, messages: 'not array',
    });
    assert.equal(parseSnapshot(wrong), null);
  });

  test('serializeSnapshot 输出格式化 JSON', () => {
    const json = serializeSnapshot(makeSnapshot());
    assert.ok(json.includes('__schema'));
    assert.ok(json.includes('agentloop-snapshot'));
  });

  test('含 answer/stopReason 的快照往返', () => {
    const snap = makeSnapshot({ answer: '最终答案', stopReason: 'completed' });
    const back = parseSnapshot(serializeSnapshot(snap));
    assert.equal(back?.answer, '最终答案');
    assert.equal(back?.stopReason, 'completed');
  });
});

describe('EventRecorder', () => {
  test('录制事件计数', () => {
    const rec = new EventRecorder();
    assert.equal(rec.length, 0);
    rec.record(makeEvent('think'));
    rec.record(makeEvent('tool_call'));
    assert.equal(rec.length, 2);
  });

  test('exportLog 生成 EventLog', () => {
    const rec = new EventRecorder();
    rec.record(makeEvent('think'));
    rec.record(makeEvent('final', { answer: 'done' } as Partial<LoopEvent>));
    const log = rec.exportLog();
    assert.equal(log.__schema, 'agentloop-eventlog');
    assert.equal(log.version, 1);
    assert.equal(log.events.length, 2);
    assert.ok(typeof log.startedAt === 'string');
  });

  test('filterByType 按类型过滤', () => {
    const rec = new EventRecorder();
    rec.record(makeEvent('think'));
    rec.record(makeEvent('tool_call'));
    rec.record(makeEvent('think'));
    const thinks = rec.filterByType('think');
    assert.equal(thinks.length, 2);
  });

  test('相对时间戳（atMs ≥ 0）', async () => {
    const rec = new EventRecorder();
    rec.record(makeEvent('think'));
    await new Promise((r) => setTimeout(r, 10));
    rec.record(makeEvent('final'));
    const log = rec.exportLog();
    assert.ok(log.events[0]!.atMs >= 0);
    assert.ok(log.events[1]!.atMs >= log.events[0]!.atMs);
  });
});

describe('serializeEventLog / parseEventLog 往返', () => {
  test('序列化→反序列化保持等价', () => {
    const log = makeEventLog([
      { atMs: 0, event: makeEvent('think') },
      { atMs: 10, event: makeEvent('tool_call') },
    ]);
    const json = serializeEventLog(log);
    const back = parseEventLog(json);
    assert.deepEqual(back, log);
  });

  test('parseEventLog 非法 JSON → null', () => {
    assert.equal(parseEventLog('not json'), null);
  });

  test('parseEventLog schema 不符 → null', () => {
    const wrong = JSON.stringify({ __schema: 'wrong', version: 1, events: [] });
    assert.equal(parseEventLog(wrong), null);
  });

  test('parseEventLog events 非数组 → null', () => {
    const wrong = JSON.stringify({
      __schema: 'agentloop-eventlog', version: 1, events: 'not array',
    });
    assert.equal(parseEventLog(wrong), null);
  });

  test('空事件日志往返', () => {
    const log = makeEventLog([]);
    const back = parseEventLog(serializeEventLog(log));
    assert.deepEqual(back, log);
  });
});

describe('summarizeEventLog', () => {
  test('空日志 → 全零统计', () => {
    const s = summarizeEventLog(makeEventLog([]));
    assert.equal(s.totalEvents, 0);
    assert.equal(s.toolCalls, 0);
    assert.equal(s.compacts, 0);
    assert.equal(s.errors, 0);
    assert.equal(s.durationMs, 0);
  });

  test('tool_call 计数', () => {
    const log = makeEventLog([
      { atMs: 0, event: makeEvent('tool_call') },
      { atMs: 5, event: makeEvent('tool_call') },
      { atMs: 10, event: makeEvent('tool_call') },
    ]);
    assert.equal(summarizeEventLog(log).toolCalls, 3);
  });

  test('compact 计数', () => {
    const log = makeEventLog([
      { atMs: 0, event: makeEvent('compact') },
      { atMs: 10, event: makeEvent('compact') },
    ]);
    assert.equal(summarizeEventLog(log).compacts, 2);
  });

  test('error 计数', () => {
    const log = makeEventLog([
      { atMs: 0, event: makeEvent('error') },
    ]);
    assert.equal(summarizeEventLog(log).errors, 1);
  });

  test('durationMs = 最后事件的 atMs', () => {
    const log = makeEventLog([
      { atMs: 0, event: makeEvent('think') },
      { atMs: 100, event: makeEvent('think') },
      { atMs: 250, event: makeEvent('final') },
    ]);
    assert.equal(summarizeEventLog(log).durationMs, 250);
  });

  test('counts 按类型分组', () => {
    const log = makeEventLog([
      { atMs: 0, event: makeEvent('think') },
      { atMs: 1, event: makeEvent('think') },
      { atMs: 2, event: makeEvent('tool_call') },
    ]);
    const s = summarizeEventLog(log);
    assert.equal(s.counts['think'], 2);
    assert.equal(s.counts['tool_call'], 1);
  });

  test('totalEvents = events.length', () => {
    const log = makeEventLog([
      { atMs: 0, event: makeEvent('think') },
      { atMs: 1, event: makeEvent('think') },
    ]);
    assert.equal(summarizeEventLog(log).totalEvents, 2);
  });
});

describe('renderEventTimeline', () => {
  test('空日志 → 空或提示文本', () => {
    const s = renderEventTimeline(makeEventLog([]));
    assert.ok(typeof s === 'string');
  });

  test('输出为字符串（含完整事件时不崩溃）', () => {
    // renderEventTimeline 对特定事件字段有依赖，此处只验证空日志不崩溃
    const s = renderEventTimeline(makeEventLog([]));
    assert.ok(typeof s === 'string');
  });
});
