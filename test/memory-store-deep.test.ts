/**
 * memory-store.ts 深层路径测试（R10-D4）。
 *
 * 补 memory-store.test.ts 未触达的分支：
 *   1. addTyped：写入带 type/confidence，metadata 合并 type+confidence
 *   2. searchRelevant：按 minConfidence 过滤（低置信度不返回）
 *   3. updateConfidence：增/减 delta，clamp 到 [0,1]，不存在 id 无副作用
 *   4. getLessons：仅返回 type=lesson
 *   5. 持久化往返保真：vector/type/confidence/metadata 加载后完整
 *   6. 加载损坏文件：records 非数组 → 重置为空（不抛错）
 *   7. 加载错误 __schema → 静默忽略（当作空）
 *   8. 加载坏 JSON → 静默忽略
 *   9. 停用词过滤：the/is/的 等不计入向量
 *  10. 空查询/无词查询：search 不崩，返回空
 *  11. 持久化文件含 __schema 与 version 字段
 *  12. add 返回的 record 含唯一 id + ISO createdAt
 *  13. delete：无匹配返回 0，多条匹配全部删
 *  14. 余弦相似度：完全相同文本 score=1，无交集 score=0
 *  15. 英文大小写归一化（TOKENize == tokenize）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/memory-store.ts';

async function tmpStore(): Promise<[MemoryStore, string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'memd-'));
  const store = new MemoryStore(dir);
  // 通过私有 path 访问；测试用反射读取
  const path = (store as unknown as { path: string }).path;
  return [store, path, () => rm(dir, { recursive: true, force: true })];
}

test('addTyped：写入 type/confidence，metadata 合并', () => {
  const store = new MemoryStore('/tmp/no');
  const r = store.addTyped('永远用 const 而非 let', 'lesson', 0.8, { task: 't1' });
  assert.equal(r.type, 'lesson');
  assert.equal(r.confidence, 0.8);
  assert.equal(r.metadata?.task, 't1');
  assert.equal(r.metadata?.type, 'lesson');
  assert.equal(r.metadata?.confidence, 0.8);
});

test('addTyped：四种 type 都可写入', () => {
  const store = new MemoryStore('/tmp/no');
  for (const t of ['fact', 'skill', 'lesson', 'error'] as const) {
    store.addTyped(`x-${t}`, t, 0.5);
  }
  assert.equal(store.size, 4);
});

test('searchRelevant：按 minConfidence 过滤低置信度', () => {
  const store = new MemoryStore('/tmp/no');
  store.addTyped('高置信度的事实 quantum', 'fact', 0.9);
  store.addTyped('低置信度的猜测 quantum', 'fact', 0.2);
  // minConfidence=0.5 → 只返回高置信度那条
  const results = store.searchRelevant('quantum', 3, 0.5);
  assert.equal(results.length, 1);
  assert.ok(results[0]!.record.confidence! >= 0.5);
});

test('searchRelevant：默认 minConfidence=0.5，无置信度字段按 1 处理', () => {
  const store = new MemoryStore('/tmp/no');
  // add（非 typed）不设 confidence → searchRelevant 按 1 处理 → 通过 0.5 阈值
  store.add('plain record quantum');
  const results = store.searchRelevant('quantum', 3, 0.5);
  assert.ok(results.length >= 1, '无 confidence 字段视为 1，应通过默认阈值');
});

test('updateConfidence：增/减 delta 并 clamp 到 [0,1]', () => {
  const store = new MemoryStore('/tmp/no');
  const r = store.addTyped('base', 'fact', 0.5);
  store.updateConfidence(r.id, 0.3);
  assert.equal(r.confidence, 0.8);
  store.updateConfidence(r.id, 0.5); // 0.8+0.5=1.3 → clamp 1
  assert.equal(r.confidence, 1);
  store.updateConfidence(r.id, -1.5); // 1-1.5=-0.5 → clamp 0
  assert.equal(r.confidence, 0);
});

test('updateConfidence：不存在 id 无副作用（不抛错）', () => {
  const store = new MemoryStore('/tmp/no');
  store.add('a');
  store.updateConfidence('mem_nonexistent', 0.5); // 不应抛错
  assert.equal(store.size, 1);
});

test('getLessons：仅返回 type=lesson', () => {
  const store = new MemoryStore('/tmp/no');
  store.addTyped('lesson 1', 'lesson', 0.9);
  store.addTyped('a fact', 'fact', 0.9);
  store.addTyped('lesson 2', 'lesson', 0.9);
  const lessons = store.getLessons();
  assert.equal(lessons.length, 2);
  assert.ok(lessons.every((l) => l.type === 'lesson'));
});

test('持久化往返保真：vector/type/confidence/metadata 加载后完整', async () => {
  const [store, _path, cleanup] = await tmpStore();
  try {
    store.addTyped('量子计算纠错', 'lesson', 0.85, { task: 't1' });
    store.add('普通记录 quantum physics');
    await store.persist();
    // 新实例加载
    const store2 = new MemoryStore((store as unknown as { dir: string }).dir);
    await store2.load();
    assert.equal(store2.size, 2);
    const lessons = store2.getLessons();
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0]!.type, 'lesson');
    assert.equal(lessons[0]!.confidence, 0.85);
    assert.equal(lessons[0]!.metadata?.task, 't1');
    // vector 是 Map（加载时从 Object 还原）
    assert.ok(lessons[0]!.vector instanceof Map);
    // 搜索仍可用
    const results = store2.search('量子');
    assert.ok(results.length > 0);
  } finally {
    await cleanup();
  }
});

test('加载损坏文件：records 非数组 → 重置为空（不抛错）', async () => {
  const [store, path, cleanup] = await tmpStore();
  try {
    // 写一个 records 不是数组的文件
    await writeFile(
      path,
      JSON.stringify({ __schema: 'agentloop-memory-store', version: 1, records: 'not-an-array' }),
      'utf8',
    );
    await store.load();
    assert.equal(store.size, 0, 'records 非数组应重置为空');
  } finally {
    await cleanup();
  }
});

test('加载错误 __schema → 静默忽略（当作空）', async () => {
  const [store, path, cleanup] = await tmpStore();
  try {
    await writeFile(
      path,
      JSON.stringify({ __schema: 'something-else', version: 1, records: [{ id: 'x', text: 'y', vector: {} }] }),
      'utf8',
    );
    await store.load();
    assert.equal(store.size, 0, '错误 schema 应忽略');
  } finally {
    await cleanup();
  }
});

test('加载坏 JSON → 静默忽略（不抛错）', async () => {
  const [store, path, cleanup] = await tmpStore();
  try {
    await writeFile(path, '{ this is not valid json }}}', 'utf8');
    await store.load();
    assert.equal(store.size, 0, '坏 JSON 应静默忽略');
  } finally {
    await cleanup();
  }
});

test('停用词过滤：the/is/的 等不计入向量', () => {
  const store = new MemoryStore('/tmp/no');
  // 含大量停用词 vs 不含，应有相似的检索（停用词不影响匹配）
  store.add('the quantum computing is the future');
  store.add('quantum computing future');
  const r1 = store.search('quantum computing');
  assert.ok(r1.length >= 1, '应能匹配');
});

test('空查询 / 无有效词查询：search 不崩，返回空', () => {
  const store = new MemoryStore('/tmp/no');
  store.add('some real content here');
  assert.equal(store.search('').length, 0, '空查询返回空');
  assert.equal(store.search('   ').length, 0, '纯空白返回空');
  // 只有停用词
  assert.equal(store.search('the of is').length, 0, '纯停用词返回空');
});

test('持久化文件含 __schema 与 version 字段', async () => {
  const [store, path, cleanup] = await tmpStore();
  try {
    store.add('schema probe');
    await store.persist();
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.__schema, 'agentloop-memory-store');
    assert.equal(parsed.version, 1);
    assert.ok(Array.isArray(parsed.records));
    assert.equal(parsed.records.length, 1);
  } finally {
    await cleanup();
  }
});

test('add 返回 record 含唯一 id + ISO createdAt', () => {
  const store = new MemoryStore('/tmp/no');
  const r1 = store.add('first');
  const r2 = store.add('second');
  assert.match(r1.id, /^mem_/);
  assert.notEqual(r1.id, r2.id, 'id 唯一');
  // createdAt 是有效 ISO
  const d = new Date(r1.createdAt);
  assert.ok(!Number.isNaN(d.getTime()), 'createdAt 是有效日期');
  assert.match(r1.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'ISO 格式');
});

test('delete：无匹配返回 0', () => {
  const store = new MemoryStore('/tmp/no');
  store.add('keep', { tag: 'a' });
  const n = store.delete((r) => r.metadata?.tag === 'nonexistent');
  assert.equal(n, 0);
  assert.equal(store.size, 1);
});

test('delete：多条匹配全部删', () => {
  const store = new MemoryStore('/tmp/no');
  store.add('x', { tag: 'rm' });
  store.add('y', { tag: 'rm' });
  store.add('z', { tag: 'keep' });
  const n = store.delete((r) => r.metadata?.tag === 'rm');
  assert.equal(n, 2);
  assert.equal(store.size, 1);
});

test('余弦相似度：完全相同文本 score 最高（接近 1）', () => {
  const store = new MemoryStore('/tmp/no');
  store.add('quantum computing error correction');
  const results = store.search('quantum computing error correction');
  assert.ok(results.length > 0);
  assert.ok(results[0]!.score > 0.99, `相同文本相似度应接近 1，实际 ${results[0]!.score}`);
});

test('余弦相似度：无交集返回 score=0（被 filter 掉）', () => {
  const store = new MemoryStore('/tmp/no');
  store.add('apple banana cherry');
  const results = store.search('quantum physics relativity');
  assert.equal(results.length, 0, '无交集应返回空');
});

test('英文大小写归一化（大写查询能匹配小写存储）', () => {
  const store = new MemoryStore('/tmp/no');
  store.add('The QUAntum Computer is fast');
  const results = store.search('QUANTUM COMPUTER');
  assert.ok(results.length > 0, '大小写归一化后应匹配');
});
