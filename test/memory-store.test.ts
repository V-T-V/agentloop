/**
 * memory-store.ts 持久化向量记忆的测试。
 *
 * 覆盖：添加/搜索/持久化/加载/中文匹配/余弦相似度。
 * 全部用临时目录，测试后清理。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/memory-store.ts';

async function tmpStore(): Promise<[MemoryStore, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'mem-'));
  return [new MemoryStore(dir), () => rm(dir, { recursive: true, force: true })];
}

test('MemoryStore：添加后 size 增加', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  assert.equal(store.size, 0);
  store.add('测试内容');
  assert.equal(store.size, 1);
  store.add('另一条');
  assert.equal(store.size, 2);
});

test('MemoryStore：精确匹配搜索', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  store.add('量子计算是一种利用量子力学原理的计算技术');
  store.add('机器学习是人工智能的一个分支');
  const results = store.search('量子计算');
  assert.ok(results.length > 0);
  assert.equal(results[0]!.record.text.includes('量子'), true);
});

test('MemoryStore：无匹配返回空', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  store.add('苹果是一种水果');
  const results = store.search('quantum physics xyz');
  assert.equal(results.length, 0);
});

test('MemoryStore：返回 top-k', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  store.add('Python 编程语言');
  store.add('JavaScript 编程语言');
  store.add('Java 编程语言');
  store.add('Rust 编程语言');
  store.add('Go 编程语言');
  const results = store.search('编程');
  assert.ok(results.length <= 3, '默认 k=3');
  // 全部 score > 0
  assert.ok(results.every((r) => r.score > 0));
});

test('MemoryStore：k 参数控制返回数量', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  for (let i = 0; i < 5; i++) store.add(`编程语言 #${i}`);
  const results = store.search('编程', 2);
  assert.ok(results.length <= 2);
});

test('MemoryStore：中文 2-gram 匹配', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  store.add('人工智能正在改变世界');
  store.add('深度学习是机器学习的子领域');
  const results = store.search('机器学习');
  // 应优先匹配含「机器学习」的
  assert.ok(results.length > 0);
  assert.ok(results[0]!.record.text.includes('机器学习'));
});

test('MemoryStore：英文单词匹配', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  store.add('LangGraph is a graph-based agent framework');
  store.add('React is a UI library');
  const results = store.search('agent framework');
  assert.ok(results.length > 0);
  assert.ok(results[0]!.record.text.includes('LangGraph'));
});

test('MemoryStore：分数排序（高相关在前）', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  store.add('quantum computing error correction');
  store.add('quantum physics basics');
  store.add('classical computing history');
  const results = store.search('quantum computing');
  assert.ok(results.length >= 2);
  // 第一条应比第三条更相关
  assert.ok(results[0]!.score >= results[results.length - 1]!.score);
});

test('MemoryStore：持久化 + 加载往返', async () => {
  const [store, cleanup] = await tmpStore();
  try {
    store.add('持久化测试内容一');
    store.add('持久化测试内容二');
    assert.equal(store.size, 2);
    await store.persist();

    // 新实例加载
    const store2 = new MemoryStore(store['dir']);
    await store2.load();
    assert.equal(store2.size, 2, '加载后记录数一致');
    const results = store2.search('持久化');
    assert.ok(results.length > 0, '加载后仍可搜索');
  } finally {
    await cleanup();
  }
});

test('MemoryStore：加载不存在的文件不报错', async () => {
  const [store, cleanup] = await tmpStore();
  try {
    await store.load();
    assert.equal(store.size, 0);
  } finally {
    await cleanup();
  }
});

test('MemoryStore：metadata 关联', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  store.add('重要事实', { tag: 'research', task: 'task-1' });
  const results = store.search('重要');
  assert.ok(results[0]!.record.metadata?.tag === 'research');
});

test('MemoryStore：clear 清空', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  store.add('a');
  store.add('b');
  store.clear();
  assert.equal(store.size, 0);
});

test('MemoryStore：delete 按条件删除', () => {
  const store = new MemoryStore('/tmp/test-nonexist');
  store.add('保留这条', { tag: 'keep' });
  store.add('删除这条', { tag: 'remove' });
  const deleted = store.delete((r) => r.metadata?.tag === 'remove');
  assert.equal(deleted, 1);
  assert.equal(store.size, 1);
});
