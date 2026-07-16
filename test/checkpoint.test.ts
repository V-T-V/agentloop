/**
 * checkpoint.ts + runLoop durable 执行的测试。
 *
 * 覆盖研究归档 research/long-running-agents.md 定义的核心场景：
 * 1. CheckpointStore 单元：保存/加载/损坏回退/多代保留/删除。
 * 2. runLoop + durable 集成：每步落盘、崩溃后 resume 续跑、最终答案一致。
 * 3. 幂等性：崩溃 step 不会重复执行已完成的副作用。
 * 4. 已完成检查点：同 runId 二次调用直接返回结果，不重复执行。
 * 5. 向后兼容：不传 durable 时行为完全不变。
 *
 * 所有文件操作用 os.tmpdir 下的临时目录，测试后清理。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CheckpointStore, makeCheckpoint, newRunId, isCompleted, isRecoverable } from '../src/checkpoint.ts';
import { runLoop } from '../src/loop.ts';
import { calculatorTool } from '../src/tools/calculator.ts';
import type { AnyToolDef, ChatResult, LLMClient, Message, TokenUsage } from '../src/types.ts';

const U: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

/** 按预设脚本依次返回消息的假 LLM（脚本耗尽则抛错，模拟"没有更多步骤"） */
function scriptedLLM(scripts: Message[]): LLMClient & { calls: number } {
  let i = 0;
  return {
    isStub: true,
    supportsStream: true,
    calls: 0,
    async chat(): Promise<ChatResult> {
      this.calls++;
      const msg = scripts[i++];
      if (!msg) throw new Error('脚本已耗尽');
      return { message: msg, usage: U };
    },
    async chatStream(): Promise<ChatResult> {
      this.calls++;
      const msg = scripts[i++];
      if (!msg) throw new Error('脚本已耗尽');
      return { message: msg, usage: U };
    },
  } as LLMClient & { calls: number };
}

function toolCallMsg(name: string, args: Record<string, unknown>, id = 'call_1'): Message {
  return { role: 'assistant', content: null, toolCalls: [{ id, name, arguments: args }] };
}

/** 创建临时检查点目录，返回 [dir, cleanup] */
async function tmpStoreDir(): Promise<[string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'agentloop-ckpt-'));
  return [dir, () => rm(dir, { recursive: true, force: true })];
}

const tools: AnyToolDef[] = [calculatorTool as AnyToolDef];

// —————————— CheckpointStore 单元测试 ——————————

test('CheckpointStore：保存后能加载回来', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    const ckpt = makeCheckpoint({
      runId: 'r1',
      step: 3,
      maxSteps: 10,
      messages: [{ role: 'system', content: 'sys' }],
      totalUsage: U,
    });
    await store.save(ckpt);
    const loaded = await store.load('r1');
    assert.ok(loaded);
    assert.equal(loaded!.step, 3);
    assert.equal(loaded!.runId, 'r1');
    assert.equal(loaded!.messages[0]!.content, 'sys');
  } finally {
    await cleanup();
  }
});

test('CheckpointStore：不存在的 runId 返回 null', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    const loaded = await store.load('nonexistent');
    assert.equal(loaded, null);
  } finally {
    await cleanup();
  }
});

test('CheckpointStore：多代保留——最新损坏时回退 prev', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    // 存两代：step1 → step2（save 会把 step1 滚到 .prev）
    await store.save(
      makeCheckpoint({ runId: 'r2', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
    );
    await store.save(
      makeCheckpoint({ runId: 'r2', step: 2, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
    );
    // 损坏最新文件（写入非法 JSON）
    await writeFile(join(dir, 'r2.json'), '{ 这不是合法 JSON', 'utf8');
    // 加载应回退到 prev（step=1）
    const loaded = await store.load('r2');
    assert.ok(loaded, '应回退到 prev 代');
    assert.equal(loaded!.step, 1, '回退到前一代 step=1');
  } finally {
    await cleanup();
  }
});

test('CheckpointStore：最新+prev 都损坏时返回 null', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({ runId: 'r3', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
    );
    // 损坏两代
    await writeFile(join(dir, 'r3.json'), '坏', 'utf8');
    await writeFile(join(dir, 'r3.json.prev'), '坏', 'utf8');
    const loaded = await store.load('r3');
    assert.equal(loaded, null);
  } finally {
    await cleanup();
  }
});

test('CheckpointStore：delete 清理全部文件', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({ runId: 'r4', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
    );
    await store.delete('r4');
    const loaded = await store.load('r4');
    assert.equal(loaded, null);
  } finally {
    await cleanup();
  }
});

test('isCompleted / isRecoverable 辅助函数', () => {
  const base = makeCheckpoint({ runId: 'r', step: 1, maxSteps: 5, messages: [{ role: 'system', content: 's' }], totalUsage: U });
  assert.ok(isRecoverable(base));
  assert.ok(!isCompleted(base), '无 stopReason 未完成');

  const finished = { ...base, stopReason: 'final' as const, answer: 'done' };
  assert.ok(isCompleted(finished));

  const errored = { ...base, stopReason: 'error' as const };
  assert.ok(!isCompleted(errored), 'error 视为可续跑');

  const badMessages = { ...base, messages: [] };
  assert.ok(!isRecoverable(badMessages), '空消息不可恢复');
});

test('newRunId：格式唯一', () => {
  const a = newRunId();
  const b = newRunId();
  assert.ok(a.startsWith('run_'));
  assert.notEqual(a, b);
});

// —————————— runLoop + durable 集成测试 ——————————

test('durable：每步落盘，checkpoint 内容正确', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    const llm = scriptedLLM([
      toolCallMsg('calculator', { expression: '1+1' }, 'c1'),
      { role: 'assistant', content: '结果是 2' },
    ]);
    const savedSteps: number[] = [];
    const { answer, stopReason } = await runLoop({
      llm,
      tools,
      system: 'sys',
      user: '算 1+1',
      stream: false,
      durable: { runId: 'durable-1', store, onCheckpoint: (info) => savedSteps.push(info.step) },
    });
    assert.equal(stopReason, 'final');
    assert.equal(answer, '结果是 2');
    // 第1步（工具调用完成）+ 第2步（收敛）都应落盘
    assert.ok(savedSteps.includes(1), 'step 1 落盘');
    assert.ok(savedSteps.includes(2), 'step 2 落盘');

    // 最终检查点应记录完成状态
    const final = await store.load('durable-1');
    assert.ok(final);
    assert.equal(final!.stopReason, 'final');
    assert.equal(final!.answer, '结果是 2');
  } finally {
    await cleanup();
  }
});

test('durable：已完成检查点二次调用直接返回，不重复执行', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    // 第一次运行：正常完成
    const llm1 = scriptedLLM([
      toolCallMsg('calculator', { expression: '2+2' }, 'c1'),
      { role: 'assistant', content: '4' },
    ]);
    await runLoop({
      llm: llm1,
      tools,
      system: 'sys',
      user: '算 2+2',
      stream: false,
      durable: { runId: 'durable-2', store },
    });
    assert.equal(llm1.calls, 2, '第一次跑了 2 次 LLM');

    // 第二次运行：同 runId，应直接返回结果，不调 LLM
    const llm2 = scriptedLLM([{ role: 'assistant', content: '不该执行' }]);
    const result = await runLoop({
      llm: llm2,
      tools,
      system: 'sys',
      user: '算 2+2',
      stream: false,
      durable: { runId: 'durable-2', store },
    });
    assert.equal(llm2.calls, 0, '已完成检查点不应调 LLM');
    assert.equal(result.answer, '4');
    assert.equal(result.stopReason, 'final');
  } finally {
    await cleanup();
  }
});

test('durable：崩溃恢复——从中间 checkpoint 续跑到收敛', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    const runId = 'crash-recover';

    // === 第一次运行：模拟在第 2 步后崩溃 ===
    // 脚本：step1 工具调用 → step2 工具调用 → step3 收敛
    // 但我们只给前两步脚本，让第3步因"脚本耗尽"而中断（模拟崩溃）
    const llm1 = scriptedLLM([
      toolCallMsg('calculator', { expression: '10+10' }, 'c1'),
      toolCallMsg('calculator', { expression: '20*2' }, 'c2'),
      // 故意不给第3条——模拟崩溃前 LLM 还没返回
    ]);
    try {
      await runLoop({
        llm: llm1,
        tools,
        system: 'sys',
        user: '多步计算',
        stream: false,
        durable: { runId, store },
      });
      assert.fail('应因脚本耗尽而抛错（模拟崩溃）');
    } catch (e) {
      // 预期：脚本耗尽 = 模拟崩溃
      assert.ok(e instanceof Error);
    }
    // 此时 step1、step2 已落盘（最新是 step2）
    const ckpt = await store.load(runId);
    assert.ok(ckpt, '崩溃前应已落盘');
    assert.equal(ckpt!.step, 2, '最新 checkpoint 在 step 2');

    // === 第二次运行：同 runId，应从 step 3 续跑 ===
    const llm2 = scriptedLLM([{ role: 'assistant', content: '最终答案 40' }]);
    const result = await runLoop({
      llm: llm2,
      tools,
      system: 'sys',
      user: '多步计算',
      stream: false,
      durable: { runId, store },
    });
    assert.equal(result.stopReason, 'final');
    assert.equal(result.answer, '最终答案 40');
    assert.equal(llm2.calls, 1, '只补跑了 1 步（从 step 3 继续）');
    assert.equal(result.steps, 3);
  } finally {
    await cleanup();
  }
});

test('durable：幂等性——崩溃 step 的工具副作用不重复', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    const runId = 'idempotent';

    // 计数工具：每次执行 +1（模拟有副作用的工具）
    let execCount = 0;
    const countingTool: AnyToolDef = {
      name: 'counter',
      description: '计数工具',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        execCount++;
        return { ok: true, output: `第${execCount}次执行` };
      },
    };

    // 第一次：step1 调 counter，step2 模拟崩溃（脚本耗尽）
    const llm1 = scriptedLLM([
      toolCallMsg('counter', {}, 'c1'),
      // 崩溃
    ]);
    try {
      await runLoop({
        llm: llm1,
        tools: [countingTool],
        system: 'sys',
        user: '计数',
        stream: false,
        durable: { runId, store },
      });
      assert.fail('应崩溃');
    } catch {
      // 预期崩溃
    }
    assert.equal(execCount, 1, '崩溃前工具执行了 1 次');

    // 第二次：resume。step1 已完成（已落盘），不应重跑 counter
    const llm2 = scriptedLLM([{ role: 'assistant', content: '完成' }]);
    await runLoop({
      llm: llm2,
      tools: [countingTool],
      system: 'sys',
      user: '计数',
      stream: false,
      durable: { runId, store },
    });
    assert.equal(execCount, 1, '恢复后工具仍只执行 1 次（step1 未重跑，幂等）');
  } finally {
    await cleanup();
  }
});

test('durable：向后兼容——不传 durable 时行为不变', async () => {
  const llm = scriptedLLM([{ role: 'assistant', content: '直接回答' }]);
  const { answer, stopReason, steps } = await runLoop({
    llm,
    tools,
    system: 'sys',
    user: '你好',
    stream: false,
    // 不传 durable —— 应与原版完全一致
  });
  assert.equal(stopReason, 'final');
  assert.equal(steps, 1);
  assert.equal(answer, '直接回答');
  assert.equal(llm.calls, 1);
});

test('durable：resume=false 忽略已有检查点全新开始', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    const runId = 'no-resume';

    // 第一次：跑到 step2 后崩溃
    const llm1 = scriptedLLM([
      toolCallMsg('calculator', { expression: '1+1' }, 'c1'),
      // 崩溃
    ]);
    try {
      await runLoop({ llm: llm1, tools, system: 'sys', user: 'x', stream: false, durable: { runId, store } });
    } catch {
      /* 崩溃 */
    }
    const ckpt = await store.load(runId);
    assert.ok(ckpt && ckpt.step === 1);

    // 第二次：resume=false，应忽略 checkpoint 全新开始
    const llm2 = scriptedLLM([{ role: 'assistant', content: '全新答案' }]);
    const result = await runLoop({
      llm: llm2,
      tools,
      system: 'sys',
      user: 'x',
      stream: false,
      durable: { runId, store, resume: false },
    });
    assert.equal(result.answer, '全新答案');
    assert.equal(result.steps, 1, '全新开始，只跑了 1 步');
  } finally {
    await cleanup();
  }
});

test('durable：累计 usage 跨恢复正确累加', async () => {
  const [dir, cleanup] = await tmpStoreDir();
  try {
    const store = new CheckpointStore(dir);
    const runId = 'usage-acc';

    // 第一次：1 步工具调用后崩溃
    const llm1 = scriptedLLM([toolCallMsg('calculator', { expression: '1+1' }, 'c1')]);
    try {
      await runLoop({ llm: llm1, tools, system: 'sys', user: 'x', stream: false, durable: { runId, store } });
    } catch {
      /* 崩溃 */
    }
    // 1 次 LLM 调用 = promptTokens 10
    const ckpt1 = await store.load(runId);
    assert.equal(ckpt1!.totalUsage.promptTokens, 10);

    // 第二次：resume 再跑 1 步收敛
    const llm2 = scriptedLLM([{ role: 'assistant', content: 'done' }]);
    const result = await runLoop({
      llm: llm2,
      tools,
      system: 'sys',
      user: 'x',
      stream: false,
      durable: { runId, store },
    });
    // 10 (step1) + 10 (step2) = 20
    assert.equal(result.totalUsage.promptTokens, 20, 'usage 跨恢复累加');
  } finally {
    await cleanup();
  }
});
