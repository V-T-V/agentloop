/**
 * trace-store.ts 持久化的测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TraceStore, newTraceId, makeTraceRecord } from '../src/trace-store.ts';
import type { Span } from '../src/trace.ts';
import type { TokenUsage } from '../src/types.ts';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'al-trace-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeTrace(): Span {
  return {
    id: 's1',
    name: 'run',
    parentId: null,
    start: 0,
    end: 10,
    status: 'ok',
    attributes: { answer: '42', stopReason: 'final' },
    children: [],
  };
}

function fakeRecord(id: string) {
  const usage: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
  return makeTraceRecord(id, {
    answer: '42',
    steps: 2,
    stopReason: 'final',
    trace: fakeTrace(),
    totalUsage: usage,
  }, '生命的意义是什么？')!;
}

test('保存→加载：往返无损', async () => {
  await withTmpDir(async (dir) => {
    const store = new TraceStore(dir);
    const rec = fakeRecord('t1');
    await store.save(rec);
    const loaded = await store.load('t1');
    assert.ok(loaded);
    assert.equal(loaded!.id, 't1');
    assert.equal(loaded!.answer, '42');
    assert.equal(loaded!.userQuestion, '生命的意义是什么？');
    assert.equal(loaded!.trace.name, 'run');
    assert.equal(loaded!.usage.totalTokens, 15);
  });
});

test('加载不存在 → null', async () => {
  await withTmpDir(async (dir) => {
    assert.equal(await new TraceStore(dir).load('ghost'), null);
  });
});

test('列表：按时间倒序，含答案摘要', async () => {
  await withTmpDir(async (dir) => {
    const store = new TraceStore(dir);
    const a = fakeRecord('a');
    a.createdAt = '2026-01-01T00:00:00.000Z';
    const b = fakeRecord('b');
    b.createdAt = '2026-06-01T00:00:00.000Z';
    await store.save(a);
    await store.save(b);
    const list = await store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, 'b'); // 更新的在前
    assert.equal(list[1]!.id, 'a');
    assert.equal(list[0]!.answer, '42');
  });
});

test('列表：空目录返回空', async () => {
  await withTmpDir(async (dir) => {
    assert.deepEqual(await new TraceStore(dir).list(), []);
  });
});

test('列表：损坏文件跳过', async () => {
  await withTmpDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(fakeRecord('good'));
    await writeFile(join(dir, 'broken.json'), '{坏json', 'utf8');
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, 'good');
  });
});

test('删除', async () => {
  await withTmpDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(fakeRecord('t1'));
    await store.delete('t1');
    assert.equal(await store.load('t1'), null);
  });
});

test('makeTraceRecord：trace 为 null 时返回 null', () => {
  const r = makeTraceRecord('x', { answer: 'a', steps: 1, stopReason: 'final', trace: null, totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }, 'q');
  assert.equal(r, null);
});

test('newTraceId：唯一', () => {
  assert.notEqual(newTraceId(), newTraceId());
});
