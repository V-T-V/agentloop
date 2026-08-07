/**
 * trace-store.ts 深层错误路径测试（R5-D8）。
 *
 * 现有 trace-store.test.ts（8 用例）覆盖 save/load 往返、列表排序、损坏文件跳过、
 * delete、makeTraceRecord null、newTraceId 唯一。本文件专攻未覆盖的错误路径与
 * prune（最复杂、含大量 catch 的淘汰逻辑）：
 *   - load：坏 JSON / __schema 不符 → null
 *   - list：目录不存在 → 空数组 / schema 不符跳过 / .json.tmp 残留跳过 / 非 .json 跳过
 *   - list：answer/userQuestion 缺失字段兜底 / 超长截断到 60/40
 *   - prune：maxAgeMs 按时间淘汰旧记录保留新记录
 *   - prune：maxCount 按数量淘汰只保留最近 N 条
 *   - prune：maxAgeMs 与 maxCount 同时给定
 *   - prune：清理 .json.tmp 残留文件（save 崩溃残留）
 *   - prune：损坏文件在 maxAgeMs 分支被清理
 *   - prune：目录不存在返回 deleted:0 不抛错
 *   - prune：无选项（都为 0/未传）只清 tmp 残留
 *   - delete：不存在的 id 幂等不抛
 *   - save：自动创建嵌套目录
 *   - save：原子写不残留 .json.tmp
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TraceStore, makeTraceRecord } from '../src/trace-store.ts';
import type { Span } from '../src/trace.ts';
import type { TokenUsage } from '../src/types.ts';

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'al-trace-deep-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeSpan(): Span {
  return {
    id: 's1',
    name: 'run',
    parentId: null,
    start: 0,
    end: 10,
    status: 'ok',
    attributes: {},
    children: [],
  };
}

function makeRec(id: string, createdAt: string, answer = '答案') {
  const usage: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
  const rec = makeTraceRecord(
    id,
    { answer, steps: 2, stopReason: 'final', trace: fakeSpan(), totalUsage: usage },
    '用户问题',
  )!;
  rec.createdAt = createdAt;
  return rec;
}

// —————————— load 错误路径 ——————————

test('load：坏 JSON 返回 null（不抛错）', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'bad.json'), '{ 不是合法 json', 'utf8');
    const loaded = await new TraceStore(dir).load('bad');
    assert.equal(loaded, null);
  });
});

test('load：__schema 不符返回 null', async () => {
  await withDir(async (dir) => {
    await writeFile(
      join(dir, 'alien.json'),
      JSON.stringify({ __schema: 'other-system', version: 1, id: 'alien' }),
      'utf8',
    );
    assert.equal(await new TraceStore(dir).load('alien'), null);
  });
});

// —————————— list 错误路径 ——————————

test('list：目录不存在返回空数组（不抛错）', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(join(dir, 'never-created'));
    assert.deepEqual(await store.list(), []);
  });
});

test('list：__schema 不符的文件被跳过', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('good', '2026-08-06T00:00:00.000Z'));
    await writeFile(
      join(dir, 'alien.json'),
      JSON.stringify({ __schema: 'other', id: 'alien', createdAt: '2026-08-06T00:00:00.000Z' }),
      'utf8',
    );
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, 'good');
  });
});

test('list：跳过 .json.tmp 残留文件', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('real', '2026-08-06T00:00:00.000Z'));
    // 模拟 save 崩溃留下的 .json.tmp 残留
    await writeFile(
      join(dir, 'crash.json.tmp'),
      JSON.stringify({ __schema: 'agentloop-trace', version: 1, id: 'crash', createdAt: '2026-08-06T00:00:00.000Z' }),
      'utf8',
    );
    const list = await store.list();
    assert.equal(list.length, 1, '.json.tmp 不应入列表');
    assert.equal(list[0]!.id, 'real');
  });
});

test('list：跳过非 .json 文件', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('real', '2026-08-06T00:00:00.000Z'));
    await writeFile(join(dir, 'readme.md'), '# hi', 'utf8');
    await writeFile(join(dir, 'log.txt'), 'line', 'utf8');
    const list = await store.list();
    assert.deepEqual(
      list.map((m) => m.id),
      ['real'],
    );
  });
});

test('list：answer 缺失兜底为空串', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('t', '2026-08-06T00:00:00.000Z'));
    // 手动改写文件去掉 answer 字段
    const raw = JSON.parse(await readFile(join(dir, 't.json'), 'utf8'));
    delete raw.answer;
    await writeFile(join(dir, 't.json'), JSON.stringify(raw), 'utf8');
    const list = await store.list();
    assert.equal(list[0]!.answer, '', 'answer 缺失应兜底为空串');
  });
});

test('list：answer 超长截断到 60 字符', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    const longAnswer = '答'.repeat(100);
    await store.save(makeRec('t', '2026-08-06T00:00:00.000Z', longAnswer));
    const list = await store.list();
    assert.equal(list[0]!.answer.length, 60, 'answer 截断到 60 字符');
  });
});

test('list：userQuestion 超长截断到 40 字符', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const longQ = '问'.repeat(100);
    const rec = makeTraceRecord(
      't',
      { answer: 'a', steps: 1, stopReason: 'final', trace: fakeSpan(), totalUsage: usage },
      longQ,
    )!;
    rec.createdAt = '2026-08-06T00:00:00.000Z';
    await store.save(rec);
    const list = await store.list();
    assert.equal(list[0]!.userQuestion.length, 40, 'userQuestion 截断到 40 字符');
  });
});

// —————————— prune 错误路径与淘汰 ——————————

test('prune：maxAgeMs 淘汰旧记录保留新记录', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    // 旧记录（1 年前）
    await store.save(makeRec('old', '2025-01-01T00:00:00.000Z'));
    // 新记录（现在）
    await store.save(makeRec('new', new Date().toISOString()));
    const { deleted } = await store.prune({ maxAgeMs: 60_000 }); // 1 分钟前
    assert.equal(deleted, 1, '删了 1 条旧记录');
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, 'new', '保留了新记录');
  });
});

test('prune：maxCount 只保留最近 N 条', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('a', '2026-01-01T00:00:00.000Z'));
    await store.save(makeRec('b', '2026-02-01T00:00:00.000Z'));
    await store.save(makeRec('c', '2026-03-01T00:00:00.000Z'));
    await store.save(makeRec('d', '2026-04-01T00:00:00.000Z'));
    const { deleted } = await store.prune({ maxCount: 2 });
    assert.equal(deleted, 2, '删了 2 条最旧的');
    const list = await store.list();
    assert.deepEqual(
      list.map((m) => m.id),
      ['d', 'c'],
      '保留最近 2 条（降序）',
    );
  });
});

test('prune：maxAgeMs 与 maxCount 同时给定', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('old1', '2025-01-01T00:00:00.000Z'));
    await store.save(makeRec('old2', '2025-02-01T00:00:00.000Z'));
    await store.save(makeRec('new1', new Date().toISOString()));
    await store.save(makeRec('new2', new Date().toISOString()));
    await store.save(makeRec('new3', new Date().toISOString()));
    const { deleted } = await store.prune({ maxAgeMs: 60_000, maxCount: 2 });
    // 时间淘汰先删 old1/old2（2 条），数量淘汰再把 new3 删掉保留 new1/new2
    assert.ok(deleted >= 2, '至少删了 2 条旧记录');
    const list = await store.list();
    assert.ok(list.length <= 2, '最终不超过 maxCount=2');
  });
});

test('prune：清理 .json.tmp 残留文件', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('real', '2026-08-06T00:00:00.000Z'));
    await writeFile(join(dir, 'crash1.json.tmp'), 'partial', 'utf8');
    await writeFile(join(dir, 'crash2.json.tmp'), 'partial', 'utf8');
    const { deleted } = await store.prune({});
    assert.ok(deleted >= 2, '至少删了 2 个 tmp 残留');
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), 'tmp 残留已清');
    assert.ok(files.includes('real.json'), '真实记录保留');
  });
});

test('prune：maxAgeMs 分支清理损坏文件', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await writeFile(join(dir, 'corrupt.json'), '坏 json', 'utf8');
    const { deleted } = await store.prune({ maxAgeMs: 1 });
    assert.ok(deleted >= 1, '损坏文件在 maxAgeMs 分支被清');
    const files = await readdir(dir);
    assert.ok(!files.includes('corrupt.json'), '损坏文件已删');
  });
});

test('prune：目录不存在返回 deleted:0 不抛错', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(join(dir, 'no-such-dir'));
    const result = await store.prune({ maxAgeMs: 1000, maxCount: 5 });
    assert.equal(result.deleted, 0);
  });
});

test('prune：无选项（都未传）只清 tmp 残留', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('keep', '2020-01-01T00:00:00.000Z'));
    await writeFile(join(dir, 'leftover.json.tmp'), 'x', 'utf8');
    const { deleted } = await store.prune({});
    assert.ok(deleted >= 1, '清了 tmp 残留');
    const list = await store.list();
    assert.equal(list.length, 1, '正常记录不受影响（无淘汰条件）');
    assert.equal(list[0]!.id, 'keep');
  });
});

test('prune：maxAgeMs=0 不按时间淘汰', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('old', '2020-01-01T00:00:00.000Z'));
    const { deleted } = await store.prune({ maxAgeMs: 0 });
    assert.equal(deleted, 0, 'maxAgeMs=0 不触发时间淘汰');
    const list = await store.list();
    assert.equal(list.length, 1);
  });
});

test('prune：maxCount=0 不按数量淘汰', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('a', '2026-01-01T00:00:00.000Z'));
    await store.save(makeRec('b', '2026-02-01T00:00:00.000Z'));
    const { deleted } = await store.prune({ maxCount: 0 });
    assert.equal(deleted, 0);
    assert.equal((await store.list()).length, 2);
  });
});

// —————————— delete / save 错误路径 ——————————

test('delete：不存在的 id 幂等不抛错', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.delete('never-exists');
    await store.delete('never-exists'); // 重复删
  });
});

test('save：自动创建嵌套目录', async () => {
  await withDir(async (base) => {
    const nested = join(base, 'deep', 'nested', 'traces');
    const store = new TraceStore(nested);
    await store.save(makeRec('s1', '2026-08-06T00:00:00.000Z'));
    const loaded = await store.load('s1');
    assert.equal(loaded?.id, 's1');
  });
});

test('save：原子写不残留 .json.tmp', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('s1', '2026-08-06T00:00:00.000Z'));
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), '无 tmp 残留');
    assert.ok(files.includes('s1.json'));
  });
});

test('save：同名 id 二次写覆盖旧内容', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('s1', '2026-01-01T00:00:00.000Z', '旧'));
    await store.save(makeRec('s1', '2026-08-06T00:00:00.000Z', '新'));
    const loaded = await store.load('s1');
    assert.equal(loaded?.answer, '新', '二次写覆盖');
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 1, '只一个 json 文件');
  });
});

test('构造函数：dir 参数覆盖默认 env 路径', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('s1', '2026-08-06T00:00:00.000Z'));
    const files = await readdir(dir);
    assert.ok(files.includes('s1.json'), '写入显式 dir');
  });
});

test('list：meta 字段完整（id/createdAt/steps/answer/userQuestion）', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('full', '2026-08-06T00:00:00.000Z', '完整答案'));
    const list = await store.list();
    const m = list[0]!;
    assert.equal(m.id, 'full');
    assert.equal(m.createdAt, '2026-08-06T00:00:00.000Z');
    assert.equal(m.steps, 2);
    assert.equal(m.answer, '完整答案');
    assert.equal(m.userQuestion, '用户问题');
  });
});

test('save 后 delete 再 list 不包含该条目', async () => {
  await withDir(async (dir) => {
    const store = new TraceStore(dir);
    await store.save(makeRec('keep', '2026-08-06T00:00:00.000Z'));
    await store.save(makeRec('gone', '2026-08-06T00:00:00.000Z'));
    await store.delete('gone');
    const ids = (await store.list()).map((m) => m.id);
    assert.deepEqual(ids, ['keep']);
  });
});
