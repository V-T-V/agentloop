/**
 * checkpoint.ts 深层测试（R4）。
 *
 * 覆盖基础测试未触及的序列化/反序列化/恢复点/跨进程边界：
 * 1. 序列化往返：含 tool_calls / 多模态 / 预算快照的完整结构保持。
 * 2. 多代滚动：连续 save 三代，验证 .prev 滚动 + 最新可用。
 * 3. 恢复点：hasResumable 对 final/max_steps/error/undefined 的判定。
 * 4. 跨进程：JSON 结构键完整（__schema/version/savedAt），可被新实例加载。
 * 5. listRunIds：去重 + savedAt 降序 + completed 标记。
 * 6. prune：按 maxAge/maxRuns/deleteCompleted 的淘汰计数。
 * 7. delete：清理 .json/.prev/.tmp 全部残留。
 * 8. makeCheckpoint：字段完整性 + savedAt 为合法 ISO。
 * 9. isRecoverable / isCompleted 边界。
 * 10. newRunId 唯一性与格式。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CheckpointStore,
  makeCheckpoint,
  newRunId,
  isCompleted,
  isRecoverable,
  type Checkpoint,
} from '../src/checkpoint.ts';
import type { Message, TokenUsage } from '../src/types.ts';

const U: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

async function tmpDir(): Promise<[string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-deep-'));
  return [dir, () => rm(dir, { recursive: true, force: true })];
}

// —————————— 1. 序列化往返 ——————————

test('序列化往返：含 tool_calls 的消息完整保持', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'calc', arguments: { a: 1, b: '中文' } }],
      },
      { role: 'tool', content: '结果', toolCallId: 'c1', name: 'calc' },
    ];
    await store.save(makeCheckpoint({ runId: 'r1', step: 1, maxSteps: 10, messages, totalUsage: U }));
    const loaded = await store.load('r1');
    assert.ok(loaded);
    assert.deepEqual(loaded!.messages, messages);
    assert.equal(loaded!.messages[1]!.toolCalls![0]!.arguments.b, '中文');
  } finally {
    await cleanup();
  }
});

test('序列化往返：含多模态 content 的消息完整保持', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'high' } },
        ],
      },
    ];
    await store.save(makeCheckpoint({ runId: 'r2', step: 1, maxSteps: 10, messages, totalUsage: U }));
    const loaded = await store.load('r2');
    assert.ok(loaded);
    assert.deepEqual(loaded!.messages, messages);
    const part = loaded!.messages[1]!.content![1] as { type: string };
    assert.equal(part.type, 'image_url');
  } finally {
    await cleanup();
  }
});

test('序列化往返：预算快照字段完整保持', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({
        runId: 'r3',
        step: 5,
        maxSteps: 10,
        messages: [{ role: 'system', content: 's' }],
        totalUsage: U,
        budgetSnapshot: { spent: 750, warningIssued: true },
      }),
    );
    const loaded = await store.load('r3');
    assert.ok(loaded);
    assert.deepEqual(loaded!.budgetSnapshot, { spent: 750, warningIssued: true });
  } finally {
    await cleanup();
  }
});

test('序列化往返：stopReason 与 answer 完整保持', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({
        runId: 'r4',
        step: 8,
        maxSteps: 10,
        messages: [{ role: 'system', content: 's' }],
        totalUsage: U,
        stopReason: 'budget_exceeded',
        answer: '预算耗尽，终止',
      }),
    );
    const loaded = await store.load('r4');
    assert.ok(loaded);
    assert.equal(loaded!.stopReason, 'budget_exceeded');
    assert.equal(loaded!.answer, '预算耗尽，终止');
  } finally {
    await cleanup();
  }
});

// —————————— 2. 多代滚动 ——————————

test('多代滚动：连续 save 三代，磁盘上有最新+prev', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    for (const step of [1, 2, 3]) {
      await store.save(
        makeCheckpoint({
          runId: 'gen',
          step,
          maxSteps: 10,
          messages: [{ role: 'system', content: 's' }],
          totalUsage: U,
        }),
      );
    }
    // 最新应是 step=3
    const loaded = await store.load('gen');
    assert.ok(loaded);
    assert.equal(loaded!.step, 3);
    // .prev 文件存在
    const files = await readdir(dir);
    assert.ok(files.includes('gen.json'), '最新文件存在');
    assert.ok(files.includes('gen.json.prev'), 'prev 文件存在');
  } finally {
    await cleanup();
  }
});

test('多代滚动：损坏最新后 prev 是上一代（step=2）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    for (const step of [1, 2, 3]) {
      await store.save(
        makeCheckpoint({ runId: 'gen2', step, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
      );
    }
    // 损坏最新
    await writeFile(join(dir, 'gen2.json'), 'CORRUPT', 'utf8');
    const loaded = await store.load('gen2');
    assert.ok(loaded);
    assert.equal(loaded!.step, 2, '回退到 prev（上一代 step=2）');
  } finally {
    await cleanup();
  }
});

// —————————— 3. 恢复点 hasResumable ——————————

test('hasResumable：stopReason=undefined → true（未完成可续跑）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({ runId: 'r', step: 3, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
    );
    assert.equal(await store.hasResumable('r'), true);
  } finally {
    await cleanup();
  }
});

test('hasResumable：stopReason=error → true（错误可重试）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({
        runId: 'r',
        step: 3,
        maxSteps: 10,
        messages: [{ role: 'system', content: 's' }],
        totalUsage: U,
        stopReason: 'error',
      }),
    );
    assert.equal(await store.hasResumable('r'), true);
  } finally {
    await cleanup();
  }
});

test('hasResumable：stopReason=final → false（已完成）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({
        runId: 'r',
        step: 3,
        maxSteps: 10,
        messages: [{ role: 'system', content: 's' }],
        totalUsage: U,
        stopReason: 'final',
        answer: 'done',
      }),
    );
    assert.equal(await store.hasResumable('r'), false);
  } finally {
    await cleanup();
  }
});

test('hasResumable：stopReason=max_steps → false', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({
        runId: 'r',
        step: 10,
        maxSteps: 10,
        messages: [{ role: 'system', content: 's' }],
        totalUsage: U,
        stopReason: 'max_steps',
      }),
    );
    assert.equal(await store.hasResumable('r'), false);
  } finally {
    await cleanup();
  }
});

test('hasResumable：stopReason=budget_exceeded → false（实现仅 undefined/error 可续跑）', async () => {
  // 实现：hasResumable 仅当 stopReason === undefined || === 'error' 才为 true。
  // budget_exceeded 虽语义上可调预算续跑，但当前 hasResumable 视为不可续跑（终态）。
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({
        runId: 'r',
        step: 3,
        maxSteps: 10,
        messages: [{ role: 'system', content: 's' }],
        totalUsage: U,
        stopReason: 'budget_exceeded',
      }),
    );
    assert.equal(await store.hasResumable('r'), false);
  } finally {
    await cleanup();
  }
});

test('hasResumable：不存在的 runId → false', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    assert.equal(await store.hasResumable('nope'), false);
  } finally {
    await cleanup();
  }
});

// —————————— 4. 跨进程 JSON 结构 ——————————

test('跨进程：落盘 JSON 含 __schema/version/data 包装键', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({ runId: 'r', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
    );
    const raw = await readFile(join(dir, 'r.json'), 'utf8');
    const record = JSON.parse(raw) as { __schema: string; version: number; data: Checkpoint };
    assert.equal(record.__schema, 'agentloop-checkpoint');
    assert.equal(record.version, 1);
    assert.ok(record.data);
    assert.equal(record.data.runId, 'r');
  } finally {
    await cleanup();
  }
});

test('跨进程：新 CheckpointStore 实例能加载旧实例写入的文件', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store1 = new CheckpointStore(dir);
    await store1.save(
      makeCheckpoint({ runId: 'r', step: 7, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
    );
    // 全新实例（模拟新进程）
    const store2 = new CheckpointStore(dir);
    const loaded = await store2.load('r');
    assert.ok(loaded);
    assert.equal(loaded!.step, 7);
  } finally {
    await cleanup();
  }
});

test('跨进程：savedAt 是合法 ISO 时间字符串', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({ runId: 'r', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
    );
    const loaded = await store.load('r');
    assert.ok(loaded);
    const t = new Date(loaded!.savedAt).getTime();
    assert.ok(Number.isFinite(t), 'savedAt 是合法日期');
    // 与当前时间差应在几秒内
    assert.ok(Math.abs(Date.now() - t) < 5000);
  } finally {
    await cleanup();
  }
});

// —————————— 5. listRunIds ——————————

test('listRunIds：多个 run 按 savedAt 降序排列', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(makeCheckpoint({ runId: 'a', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    await new Promise((r) => setTimeout(r, 50));
    await store.save(makeCheckpoint({ runId: 'b', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    await new Promise((r) => setTimeout(r, 50));
    await store.save(makeCheckpoint({ runId: 'c', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    const list = await store.listRunIds();
    assert.equal(list.length, 3);
    // c 最晚，应排第一
    assert.equal(list[0]!.runId, 'c');
    assert.equal(list[2]!.runId, 'a');
  } finally {
    await cleanup();
  }
});

test('listRunIds：completed 标记正确（final/max_steps=true）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(makeCheckpoint({ runId: 'done', step: 5, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U, stopReason: 'final', answer: 'x' }));
    await store.save(makeCheckpoint({ runId: 'running', step: 3, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    const list = await store.listRunIds();
    const done = list.find((r) => r.runId === 'done');
    const running = list.find((r) => r.runId === 'running');
    assert.equal(done!.completed, true);
    assert.equal(running!.completed, false);
  } finally {
    await cleanup();
  }
});

test('listRunIds：空目录返回空数组', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    const list = await store.listRunIds();
    assert.deepEqual(list, []);
  } finally {
    await cleanup();
  }
});

test('listRunIds：忽略 .prev 和 .tmp 文件', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(makeCheckpoint({ runId: 'r', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    await store.save(makeCheckpoint({ runId: 'r', step: 2, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    const list = await store.listRunIds();
    // 只应有一个 runId 'r'（不因 .prev 重复）
    assert.equal(list.length, 1);
    assert.equal(list[0]!.runId, 'r');
  } finally {
    await cleanup();
  }
});

// —————————— 6. prune ——————————

test('prune：deleteCompleted=true 删除已完成的 run', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(makeCheckpoint({ runId: 'done', step: 5, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U, stopReason: 'final', answer: 'x' }));
    await store.save(makeCheckpoint({ runId: 'running', step: 3, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    const { deleted } = await store.prune({ deleteCompleted: true });
    assert.equal(deleted, 1);
    // running 仍在
    assert.ok(await store.load('running'));
    // done 已删
    assert.equal(await store.load('done'), null);
  } finally {
    await cleanup();
  }
});

test('prune：deleteCompleted=false 保留已完成', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(makeCheckpoint({ runId: 'done', step: 5, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U, stopReason: 'final', answer: 'x' }));
    const { deleted } = await store.prune({ deleteCompleted: false });
    assert.equal(deleted, 0);
    assert.ok(await store.load('done'));
  } finally {
    await cleanup();
  }
});

test('prune：maxRuns 保留最近 N 个 run', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    for (const id of ['a', 'b', 'c', 'd']) {
      await store.save(makeCheckpoint({ runId: id, step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
      await new Promise((r) => setTimeout(r, 30));
    }
    const { deleted } = await store.prune({ maxRuns: 2, deleteCompleted: false });
    assert.ok(deleted >= 2, '应淘汰最早的 2 个');
    const list = await store.listRunIds();
    assert.ok(list.length <= 2, '最多保留 2 个');
  } finally {
    await cleanup();
  }
});

test('prune：清理 .json.tmp 残留文件', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    // 手动制造一个 .tmp 残留
    await writeFile(join(dir, 'junk.json.tmp'), 'partial', 'utf8');
    const { deleted } = await store.prune({});
    assert.ok(deleted >= 1, '至少删掉 1 个 tmp 残留');
    const files = await readdir(dir);
    assert.ok(!files.includes('junk.json.tmp'), 'tmp 残留被清理');
  } finally {
    await cleanup();
  }
});

// —————————— 7. delete 清理全部 ——————————

test('delete：清理 .json/.prev/.tmp 全部文件', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(makeCheckpoint({ runId: 'r', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    await store.save(makeCheckpoint({ runId: 'r', step: 2, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    await store.delete('r');
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.startsWith('r.')), 'r 的全部文件被清理');
  } finally {
    await cleanup();
  }
});

test('delete：删除不存在的 runId 不报错', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.delete('nonexistent');
    // 不抛错即通过
    assert.ok(true);
  } finally {
    await cleanup();
  }
});

// —————————— 8. makeCheckpoint 字段完整性 ——————————

test('makeCheckpoint：所有传入字段都出现在结果中', () => {
  const ckpt = makeCheckpoint({
    runId: 'r',
    step: 4,
    maxSteps: 10,
    messages: [{ role: 'system', content: 's' }],
    totalUsage: U,
    stopReason: 'final',
    answer: 'done',
    budgetSnapshot: { spent: 100, warningIssued: false },
  });
  assert.equal(ckpt.__schema, 'agentloop-checkpoint');
  assert.equal(ckpt.version, 1);
  assert.equal(ckpt.runId, 'r');
  assert.equal(ckpt.step, 4);
  assert.equal(ckpt.maxSteps, 10);
  assert.equal(ckpt.messages.length, 1);
  assert.deepEqual(ckpt.totalUsage, U);
  assert.equal(ckpt.stopReason, 'final');
  assert.equal(ckpt.answer, 'done');
  assert.deepEqual(ckpt.budgetSnapshot, { spent: 100, warningIssued: false });
});

test('makeCheckpoint：可选字段省略时为 undefined', () => {
  const ckpt = makeCheckpoint({
    runId: 'r',
    step: 1,
    maxSteps: 10,
    messages: [{ role: 'system', content: 's' }],
    totalUsage: U,
  });
  assert.equal(ckpt.stopReason, undefined);
  assert.equal(ckpt.answer, undefined);
  assert.equal(ckpt.budgetSnapshot, undefined);
});

// —————————— 9. isRecoverable / isCompleted 边界 ——————————

test('isRecoverable：首条为 system → true', () => {
  const ckpt = makeCheckpoint({ runId: 'r', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U });
  assert.equal(isRecoverable(ckpt), true);
});

test('isRecoverable：首条非 system → false', () => {
  const ckpt = { __schema: 'agentloop-checkpoint', version: 1, runId: 'r', step: 1, maxSteps: 10, messages: [{ role: 'user', content: 'x' }], totalUsage: U, savedAt: new Date().toISOString() } as Checkpoint;
  assert.equal(isRecoverable(ckpt as Checkpoint), false);
});

test('isRecoverable：空 messages → false', () => {
  const ckpt = { __schema: 'agentloop-checkpoint', version: 1, runId: 'r', step: 1, maxSteps: 10, messages: [], totalUsage: U, savedAt: new Date().toISOString() } as Checkpoint;
  assert.equal(isRecoverable(ckpt as Checkpoint), false);
});

test('isCompleted：final → true', () => {
  const ckpt = makeCheckpoint({ runId: 'r', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U, stopReason: 'final' });
  assert.equal(isCompleted(ckpt), true);
});

test('isCompleted：max_steps → true', () => {
  const ckpt = makeCheckpoint({ runId: 'r', step: 10, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U, stopReason: 'max_steps' });
  assert.equal(isCompleted(ckpt), true);
});

test('isCompleted：error/budget_exceeded/undefined → false', () => {
  for (const sr of ['error', 'budget_exceeded', undefined] as const) {
    const ckpt = makeCheckpoint({ runId: 'r', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U, stopReason: sr });
    assert.equal(isCompleted(ckpt), false);
  }
});

// —————————— 10. newRunId ——————————

test('newRunId：格式为 run_<base36>_<4字符>', () => {
  const id = newRunId();
  assert.match(id, /^run_[0-9a-z]+_[0-9a-z]{4}$/);
});

test('newRunId：连续调用产生不同 id', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) ids.add(newRunId());
  assert.equal(ids.size, 100, '100 次调用应产生 100 个不同 id');
});

// —————————— 额外：目录自动创建 ——————————

test('CheckpointStore：保存时自动创建不存在的目录', async () => {
  const [base, cleanup] = await tmpDir();
  try {
    const nested = join(base, 'a', 'b', 'c');
    const store = new CheckpointStore(nested);
    await store.save(makeCheckpoint({ runId: 'r', step: 1, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    // 目录存在
    const s = await stat(nested);
    assert.ok(s.isDirectory());
    const loaded = await store.load('r');
    assert.ok(loaded);
  } finally {
    await cleanup();
  }
});

test('CheckpointStore：listRunIds 在目录不存在时返回空数组', async () => {
  const store = new CheckpointStore(join(tmpdir(), 'definitely-not-exist-' + Date.now()));
  const list = await store.listRunIds();
  assert.deepEqual(list, []);
});
