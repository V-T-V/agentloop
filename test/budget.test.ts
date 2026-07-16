/**
 * budget.ts 成本/Token 预算控制的测试。
 *
 * 覆盖：累加、超限检测、预警回调、快照恢复、与 runLoop 集成（优雅终止）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BudgetGuard, renderBudget, type BudgetConfig } from '../src/budget.ts';
import { CheckpointStore } from '../src/checkpoint.ts';
import { runLoop } from '../src/loop.ts';
import type { ChatResult, LLMClient, Message, TokenUsage } from '../src/types.ts';

function mkUsage(total: number): TokenUsage {
  return { promptTokens: Math.floor(total * 0.7), completionTokens: Math.ceil(total * 0.3), totalTokens: total };
}

/** 按脚本返回消息的假 LLM */
function scriptedLLM(scripts: Message[]): LLMClient {
  let i = 0;
  return {
    isStub: true,
    supportsStream: false,
    async chat(): Promise<ChatResult> {
      const msg = scripts[i++];
      if (!msg) throw new Error('脚本耗尽');
      return { message: msg, usage: mkUsage(500) };
    },
    async chatStream(): Promise<ChatResult> {
      const msg = scripts[i++];
      if (!msg) throw new Error('脚本耗尽');
      return { message: msg, usage: mkUsage(500) };
    },
  };
}

function toolCallMsg(name: string, id = 'c1'): Message {
  return { role: 'assistant', content: null, toolCalls: [{ id, name, arguments: {} }] };
}

async function tmpDir(): Promise<[string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'budget-'));
  return [dir, () => rm(dir, { recursive: true, force: true })];
}

// —————————— BudgetGuard 单元测试 ——————————

test('BudgetGuard：累加正确', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  assert.equal(g.current, 0);
  g.add(mkUsage(100));
  assert.equal(g.current, 100);
  g.add(mkUsage(200));
  assert.equal(g.current, 300);
});

test('BudgetGuard：未超限时 exhausted()=false', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(800));
  assert.ok(!g.exhausted(), '800 < 1000 未耗尽');
});

test('BudgetGuard：超限时 exhausted()=true', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(1000));
  assert.ok(g.exhausted(), '1000 = 1000 已耗尽');
});

test('BudgetGuard：超额累加也耗尽', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(600));
  g.add(mkUsage(600));
  assert.ok(g.exhausted(), '1200 > 1000 已耗尽');
  assert.equal(g.current, 1200);
});

test('BudgetGuard：超限回调 onBudgetExceeded 触发', () => {
  let triggered = false;
  const g = new BudgetGuard({
    maxTotalTokens: 100,
    onBudgetExceeded: () => {
      triggered = true;
    },
  });
  g.add(mkUsage(100));
  assert.ok(triggered, '超限应触发回调');
});

test('BudgetGuard：预警回调在 80% 时触发（仅一次）', () => {
  let warnings = 0;
  const g = new BudgetGuard({
    maxTotalTokens: 1000,
    warningThreshold: 0.8,
    onBudgetWarning: () => {
      warnings++;
    },
  });
  g.add(mkUsage(500)); // 50%，不预警
  assert.equal(warnings, 0);
  g.add(mkUsage(350)); // 85%，预警
  assert.equal(warnings, 1);
  g.add(mkUsage(50)); // 90%，不再预警（仅一次）
  assert.equal(warnings, 1);
});

test('BudgetGuard：成本估算', () => {
  const g = new BudgetGuard({ maxTotalTokens: 10000, costPerKToken: 0.01 });
  g.add(mkUsage(5000));
  assert.equal(g.estimatedCost(), 0.05, '5000 tokens × $0.01/K = $0.05');
});

test('BudgetGuard：未配置 costPerKToken 时成本为 0', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(500));
  assert.equal(g.estimatedCost(), 0);
});

test('BudgetGuard：快照导出与恢复', () => {
  const g1 = new BudgetGuard({ maxTotalTokens: 1000 });
  g1.add(mkUsage(600));
  const snap = g1.snapshot();
  assert.equal(snap.spent, 600);
  assert.equal(snap.limit, 1000);

  // 用快照恢复
  const g2 = new BudgetGuard({ maxTotalTokens: 1000 }, snap);
  assert.equal(g2.current, 600, '快照恢复后累计值正确');
  g2.add(mkUsage(100));
  assert.equal(g2.current, 700, '恢复后继续累加');
});

test('BudgetGuard：remaining() 不小于 0', () => {
  const g = new BudgetGuard({ maxTotalTokens: 100 });
  g.add(mkUsage(150));
  assert.equal(g.remaining(), 0, '超额时 remaining 为 0');
});

test('BudgetGuard：null usage 不影响累加', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(null);
  assert.equal(g.current, 0);
});

test('renderBudget：未配置时返回空串', () => {
  assert.equal(renderBudget(null), '');
});

test('renderBudget：含百分比与成本', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000, costPerKToken: 0.01 });
  g.add(mkUsage(500));
  const text = renderBudget(g);
  assert.match(text, /500\/1000/);
  assert.match(text, /50\.0%/);
  assert.match(text, /\$/);
});

// —————————— runLoop + budget 集成测试 ——————————

test('集成：预算超限时优雅终止 stopReason=budget_exceeded', async () => {
  const llm = scriptedLLM([
    toolCallMsg('datetime', 'c1'),
    toolCallMsg('datetime', 'c2'),
    toolCallMsg('datetime', 'c3'),
    { role: 'assistant', content: '不会到这里' },
  ]);
  const budget: BudgetConfig = { maxTotalTokens: 1200 }; // 每次 500，第3次后 1500 > 1200
  const result = await runLoop({
    llm,
    tools: [
      { name: 'datetime', description: 'time', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true, output: '2026' }) },
    ],
    system: 'sys',
    user: 'test',
    stream: false,
    budget,
  });
  assert.equal(result.stopReason, 'budget_exceeded');
  assert.match(result.answer, /预算耗尽/);
  assert.ok(result.steps >= 2, '至少跑了 2 步才超限');
});

test('集成：未配置 budget 时行为不变', async () => {
  const llm = scriptedLLM([{ role: 'assistant', content: '直接回答' }]);
  const result = await runLoop({ llm, tools: [], system: 'sys', user: 'x', stream: false });
  assert.equal(result.stopReason, 'final');
  assert.equal(result.answer, '直接回答');
});

test('集成：budget + durable 协同——超限落盘 checkpoint', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    const llm = scriptedLLM([
      toolCallMsg('datetime', 'c1'),
      toolCallMsg('datetime', 'c2'),
      toolCallMsg('datetime', 'c3'),
    ]);
    const result = await runLoop({
      llm,
      tools: [
        { name: 'datetime', description: 'time', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true, output: 't' }) },
      ],
      system: 'sys',
      user: 'x',
      stream: false,
      budget: { maxTotalTokens: 1200 },
      durable: { runId: 'budget-ckpt', store },
    });
    assert.equal(result.stopReason, 'budget_exceeded');
    // checkpoint 应已落盘，且 stopReason 记录为 budget_exceeded（可续跑）
    const ckpt = await store.load('budget-ckpt');
    assert.ok(ckpt, '超限应落盘 checkpoint');
    assert.equal(ckpt!.stopReason, 'budget_exceeded');
  } finally {
    await cleanup();
  }
});
