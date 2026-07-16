/**
 * 会话记忆 memory.ts 的测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Memory } from '../src/memory.ts';

test('构造时压入 system 消息', () => {
  const m = new Memory('你好');
  assert.equal(m.length, 1);
  assert.equal(m.snapshot()[0]!.role, 'system');
  assert.equal(m.snapshot()[0]!.content, '你好');
});

test('add 追加消息', () => {
  const m = new Memory('sys');
  m.add({ role: 'user', content: '问题' });
  m.add({ role: 'assistant', content: '回答' });
  assert.equal(m.length, 3);
  assert.equal(m.snapshot()[1]!.role, 'user');
  assert.equal(m.snapshot()[2]!.content, '回答');
});

test('addToolResult 追加带 toolCallId 的 tool 消息', () => {
  const m = new Memory('sys');
  m.addToolResult('call_1', 'datetime', { ok: true, output: 'now' });
  const snap = m.snapshot();
  assert.equal(snap[1]!.role, 'tool');
  assert.equal(snap[1]!.toolCallId, 'call_1');
  assert.equal(snap[1]!.name, 'datetime');
  assert.equal(snap[1]!.content, 'now');
});

test('clear 清空并保留（或替换）system', () => {
  const m = new Memory('旧');
  m.add({ role: 'user', content: 'x' });
  assert.equal(m.length, 2);
  m.clear('新');
  assert.equal(m.length, 1);
  assert.equal(m.snapshot()[0]!.content, '新');
  // 不传参则清空为空字符串
  m.clear();
  assert.equal(m.snapshot()[0]!.content, '');
});

test('snapshot 返回副本，修改不影响内部', () => {
  const m = new Memory('sys');
  const snap = m.snapshot();
  snap.push({ role: 'user', content: '注入' });
  assert.equal(m.length, 1); // 内部未受影响
});

test('滑动窗口：始终保留 system + 最近 N-1 条', () => {
  const m = new Memory('sys', { windowSize: 3 });
  m.add({ role: 'user', content: 'a' });
  m.add({ role: 'assistant', content: 'b' });
  m.add({ role: 'user', content: 'c' });
  m.add({ role: 'assistant', content: 'd' });
  const snap = m.snapshot();
  // windowSize=3 → system + 最近 2 条（c, d）
  assert.equal(snap.length, 3);
  assert.equal(snap[0]!.role, 'system');
  assert.equal(snap[1]!.content, 'c');
  assert.equal(snap[2]!.content, 'd');
});

test('滑动窗口：消息数未超窗口时返回全部', () => {
  const m = new Memory('sys', { windowSize: 10 });
  m.add({ role: 'user', content: 'a' });
  assert.equal(m.snapshot().length, 2);
});

test('windowSize<=0 表示不裁剪', () => {
  const m = new Memory('sys', { windowSize: 0 });
  for (let i = 0; i < 50; i++) m.add({ role: 'user', content: String(i) });
  assert.equal(m.snapshot().length, 51);
});

test('滑动窗口：不留下孤立的 tool 结果（小窗口配对保护）', () => {
  // 构造 [sys, user, asst(c1), tool(c1), user, asst(c2), tool(c2)] 共 7 条
  const m = new Memory('sys', { windowSize: 2 });
  m.add({ role: 'user', content: '问题1' });
  m.add({ role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'datetime', arguments: {} }] });
  m.addToolResult('c1', 'datetime', { ok: true, output: 'now' });
  m.add({ role: 'user', content: '问题2' });
  m.add({ role: 'assistant', content: null, toolCalls: [{ id: 'c2', name: 'calc', arguments: {} }] });
  m.addToolResult('c2', 'calc', { ok: true, output: '42' });

  const snap = m.snapshot();
  // 收集快照中所有 tool_calls 的 id
  const callIds = new Set<string>();
  for (const s of snap) if (s.toolCalls) for (const c of s.toolCalls) callIds.add(c.id);
  // 关键断言：每条 tool 结果都能在快照内找到其所属的 assistant tool_calls
  for (const s of snap) {
    if (s.role === 'tool' && s.toolCallId) {
      assert.ok(callIds.has(s.toolCallId), `孤立 tool 结果：${s.toolCallId} 的 assistant 已被裁掉`);
    }
  }
  // windowSize=2 应裁到只剩 [sys, asst(c2), tool(c2)]
  assert.equal(snap.length, 3);
  assert.equal(snap[0]!.role, 'system');
  assert.equal(snap[1]!.toolCalls?.[0]?.id, 'c2');
  assert.equal(snap[2]!.toolCallId, 'c2');
});

test('滑动窗口：中等窗口同样保证配对（无孤立 tool）', () => {
  const m = new Memory('sys', { windowSize: 4 });
  m.add({ role: 'user', content: '问题1' });
  m.add({ role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'datetime', arguments: {} }] });
  m.addToolResult('c1', 'datetime', { ok: true, output: 'now' });
  m.add({ role: 'user', content: '问题2' });
  m.add({ role: 'assistant', content: null, toolCalls: [{ id: 'c2', name: 'calc', arguments: {} }] });
  m.addToolResult('c2', 'calc', { ok: true, output: '42' });

  const snap = m.snapshot();
  const callIds = new Set<string>();
  for (const s of snap) if (s.toolCalls) for (const c of s.toolCalls) callIds.add(c.id);
  for (const s of snap) {
    if (s.role === 'tool' && s.toolCallId) {
      assert.ok(callIds.has(s.toolCallId), `孤立 tool 结果：${s.toolCallId}`);
    }
  }
  // windowSize=4：start 落在 user(问题2)，无需回溯，[sys, user, asst(c2), tool(c2)] 共 4 条
  assert.equal(snap.length, 4);
  assert.equal(snap[3]!.toolCallId, 'c2');
});

test('滑动窗口：裁剪点恰好落在 tool 时回溯到所属 assistant', () => {
  // [sys, user, asst(c1), tool(c1), asst(c2), tool(c2)] 共 6 条
  const m = new Memory('sys', { windowSize: 4 });
  m.add({ role: 'user', content: '问题' });
  m.add({ role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'datetime', arguments: {} }] });
  m.addToolResult('c1', 'datetime', { ok: true, output: 'now' });
  m.add({ role: 'assistant', content: null, toolCalls: [{ id: 'c2', name: 'calc', arguments: {} }] });
  m.addToolResult('c2', 'calc', { ok: true, output: '42' });

  const snap = m.snapshot();
  const callIds = new Set<string>();
  for (const s of snap) if (s.toolCalls) for (const c of s.toolCalls) callIds.add(c.id);
  for (const s of snap) {
    if (s.role === 'tool' && s.toolCallId) {
      assert.ok(callIds.has(s.toolCallId), `孤立 tool 结果：${s.toolCallId}`);
    }
  }
  // start 本应落在 tool(c1) → 回溯到 asst(c1) 一并保留
  // 若无配对保护会得到 [sys, tool(c1), asst(c2), tool(c2)]（孤立 tool_c1）
  assert.equal(snap.length, 5);
  assert.equal(snap[1]!.toolCalls?.[0]?.id, 'c1');
  assert.equal(snap[2]!.toolCallId, 'c1');
});
