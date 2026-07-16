/**
 * checkpoint.ts prune + trace-store.ts prune + tmp 过滤 bug 修复的测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CheckpointStore, makeCheckpoint } from '../src/checkpoint.ts';
import { TraceStore, makeTraceRecord, newTraceId } from '../src/trace-store.ts';
import type { TokenUsage } from '../src/types.ts';

const U: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

async function tmpDir(): Promise<[string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'prune-'));
  return [dir, () => rm(dir, { recursive: true, force: true })];
}

// —————————— CheckpointStore prune ——————————

test('prune：删除已完成的 checkpoint（默认）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    // 已完成
    await store.save(
      makeCheckpoint({ runId: 'done1', step: 5, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U, stopReason: 'final', answer: 'ok' }),
    );
    // 未完成
    await store.save(
      makeCheckpoint({ runId: 'wip1', step: 3, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
    );
    const { deleted } = await store.prune({});
    assert.equal(deleted, 1, '删了 1 个完成的');
    assert.equal(await store.load('done1'), null, '已完成被删');
    assert.ok(await store.load('wip1'), '未完成保留');
  } finally {
    await cleanup();
  }
});

test('prune：deleteCompleted=false 保留已完成', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(
      makeCheckpoint({ runId: 'done1', step: 5, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U, stopReason: 'final', answer: 'ok' }),
    );
    const { deleted } = await store.prune({ deleteCompleted: false });
    assert.equal(deleted, 0);
    assert.ok(await store.load('done1'), '保留');
  } finally {
    await cleanup();
  }
});

test('prune：按数量淘汰旧 run', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    // 创建 3 个未完成的 run，savedAt 递增（用不同 step 区分）
    for (let i = 1; i <= 3; i++) {
      await store.save(
        makeCheckpoint({ runId: `run${i}`, step: i, maxSteps: 10, messages: [{ role: 'system', content: 's' }], totalUsage: U }),
      );
      // 确保 savedAt 不同
      await new Promise((r) => setTimeout(r, 10));
    }
    // 只保留最近 1 个
    const { deleted } = await store.prune({ maxRuns: 1 });
    assert.ok(deleted >= 2, `应删除至少 2 个，实际 ${deleted}`);
    // 最近的 run3 应保留
    const runs = await store.listRunIds();
    assert.ok(runs.length <= 1, `最多保留 1 个，实际 ${runs.length}`);
  } finally {
    await cleanup();
  }
});

test('prune：清理 .json.tmp 残留', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    // 手动创建 tmp 残留
    await writeFile(join(dir, 'orphan.json.tmp'), 'incomplete', 'utf8');
    const { deleted } = await store.prune({});
    assert.ok(deleted >= 1, '清理了 tmp 残留');
  } finally {
    await cleanup();
  }
});

test('listRunIds：列出所有 run，按 savedAt 降序', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new CheckpointStore(dir);
    await store.save(makeCheckpoint({ runId: 'a', step: 1, maxSteps: 5, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    await new Promise((r) => setTimeout(r, 10));
    await store.save(makeCheckpoint({ runId: 'b', step: 2, maxSteps: 5, messages: [{ role: 'system', content: 's' }], totalUsage: U }));
    const runs = await store.listRunIds();
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.runId, 'b', '最新的在前');
  } finally {
    await cleanup();
  }
});

// —————————— TraceStore prune + tmp 过滤 bug ——————————

test('TraceStore：list 不再误吞 .json.tmp 残留（bug 修复）', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new TraceStore(dir);
    // 手动创建 tmp 残留（模拟 save 中途崩溃）
    await writeFile(join(dir, 'trace1.json.tmp'), 'incomplete', 'utf8');
    // 创建正常 trace
    const record = makeTraceRecord(newTraceId(), {
      answer: 'ok',
      steps: 1,
      stopReason: 'final',
      trace: { id: 'root', name: 'run', parentId: null, start: 0, end: 1, status: 'ok', attributes: {}, children: [] },
      totalUsage: U,
    }, 'question');
    assert.ok(record);
    await store.save(record!);

    const metas = await store.list();
    // 只应有 1 条正常记录（不含 tmp 残留）
    assert.equal(metas.length, 1, 'tmp 残留不应出现在列表中');
  } finally {
    await cleanup();
  }
});

test('TraceStore prune：按数量淘汰', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new TraceStore(dir);
    for (let i = 0; i < 5; i++) {
      const record = makeTraceRecord(`trace${i}`, {
        answer: `ans${i}`,
        steps: 1,
        stopReason: 'final',
        trace: { id: 'r', name: 'run', parentId: null, start: 0, end: 1, status: 'ok', attributes: {}, children: [] },
        totalUsage: U,
      }, 'q');
      assert.ok(record);
      await store.save(record!);
      await new Promise((r) => setTimeout(r, 10));
    }
    const { deleted } = await store.prune({ maxCount: 2 });
    assert.ok(deleted >= 3, `应删至少 3 个，实际 ${deleted}`);
    const metas = await store.list();
    assert.ok(metas.length <= 2, `最多保留 2 个，实际 ${metas.length}`);
  } finally {
    await cleanup();
  }
});

test('TraceStore prune：清理 .json.tmp 残留', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new TraceStore(dir);
    await writeFile(join(dir, 'orphan.json.tmp'), 'incomplete', 'utf8');
    const { deleted } = await store.prune({});
    assert.ok(deleted >= 1, '清理了 tmp 残留');
  } finally {
    await cleanup();
  }
});
