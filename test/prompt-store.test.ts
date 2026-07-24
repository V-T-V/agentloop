/**
 * P1 MemoryStore 增强 + P2 PromptStore 的测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/memory-store.ts';
import { PromptStore, getPromptStore } from '../src/prompt-store.ts';

async function tmpDir(): Promise<[string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'p1p2-'));
  return [dir, () => rm(dir, { recursive: true, force: true })];
}

// —————————— P1: MemoryStore 增强 ——————————

test('P1 addTyped：带类型和置信度', () => {
  const store = new MemoryStore('/tmp/p1-test');
  const r = store.addTyped('Rust是系统编程语言', 'fact', 0.9);
  assert.equal(r.type, 'fact');
  assert.equal(r.confidence, 0.9);
});

test('P1 searchRelevant：只返回高置信度', () => {
  const store = new MemoryStore('/tmp/p1-test');
  store.addTyped('Python是脚本语言', 'fact', 0.9);
  store.addTyped('可能相关的信息', 'fact', 0.3); // 低置信度
  const results = store.searchRelevant('Python', 3, 0.5);
  assert.ok(results.every((r) => (r.record.confidence ?? 0) >= 0.5));
});

test('P1 searchRelevant：低置信度被过滤', () => {
  const store = new MemoryStore('/tmp/p1-test');
  store.addTyped('低质记忆', 'fact', 0.2);
  const results = store.searchRelevant('记忆', 3, 0.5);
  assert.equal(results.length, 0);
});

test('P1 updateConfidence：提升和下降', () => {
  const store = new MemoryStore('/tmp/p1-test');
  const r = store.addTyped('测试事实', 'fact', 0.5);
  store.updateConfidence(r.id, 0.3);
  assert.ok(Math.abs((r.confidence ?? 0) - 0.8) < 0.001);
  store.updateConfidence(r.id, -0.5);
  assert.ok(Math.abs((r.confidence ?? 0) - 0.3) < 0.001);
});

test('P1 updateConfidence：clamp 到 [0,1]', () => {
  const store = new MemoryStore('/tmp/p1-test');
  const r = store.addTyped('测试', 'fact', 0.5);
  store.updateConfidence(r.id, 1.0); // 超 1
  assert.equal(r.confidence, 1);
  store.updateConfidence(r.id, -2.0); // 低 0
  assert.equal(r.confidence, 0);
});

test('P1 getLessons：只返回 lesson 类型', () => {
  const store = new MemoryStore('/tmp/p1-test');
  store.addTyped('事实1', 'fact', 0.9);
  store.addTyped('经验教训1', 'lesson', 0.8);
  store.addTyped('错误1', 'error', 0.3);
  const lessons = store.getLessons();
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0]!.type, 'lesson');
});

test('P1 持久化：confidence/type 往返', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new MemoryStore(dir);
    store.addTyped('持久化测试', 'fact', 0.85);
    await store.persist();
    const store2 = new MemoryStore(dir);
    await store2.load();
    assert.equal(store2.size, 1);
    const r = store2.search('持久化')[0]!;
    assert.equal(r.record.type, 'fact');
    assert.equal(r.record.confidence, 0.85);
  } finally {
    await cleanup();
  }
});

// —————————— P2: PromptStore ——————————

test('P2 getBest：空存储返回 fallback', () => {
  const store = new PromptStore('/tmp/p2-test');
  assert.equal(store.getBest('worker', 'fallback-prompt'), 'fallback-prompt');
});

test('P2 recordOutcome：首次记录', () => {
  const store = new PromptStore('/tmp/p2-test');
  store.recordOutcome('worker', '新prompt', 75);
  assert.equal(store.getBest('worker', 'fallback'), '新prompt');
});

test('P2 recordOutcome：只保留更高分版本', () => {
  const store = new PromptStore('/tmp/p2-test');
  store.recordOutcome('worker', 'v1 prompt', 70);
  // 低分不记录
  store.recordOutcome('worker', 'v2 worse', 60);
  assert.equal(store.getHistory('worker').length, 1);
  // 高分记录
  store.recordOutcome('worker', 'v3 better', 85);
  assert.equal(store.getHistory('worker').length, 2);
  assert.equal(store.getBest('worker', ''), 'v3 better');
});

test('P2 getBest：返回最高分版本', () => {
  const store = new PromptStore('/tmp/p2-test');
  store.recordOutcome('planner', 'prompt-A', 72);
  store.recordOutcome('planner', 'prompt-B', 88);
  store.recordOutcome('planner', 'prompt-C', 80);
  assert.equal(store.getBest('planner', ''), 'prompt-B');
});

test('P2 top-K 限制', () => {
  const store = new PromptStore('/tmp/p2-test');
  for (let i = 0; i < 10; i++) {
    store.recordOutcome('worker', `prompt-${i}`, 50 + i);
  }
  // 只保留 top-5
  assert.ok(store.getHistory('worker').length <= 5);
});

test('P2 持久化往返', async () => {
  const [dir, cleanup] = await tmpDir();
  try {
    const store = new PromptStore(dir);
    store.recordOutcome('worker', '持久化prompt', 82);
    await store.persist();
    const store2 = new PromptStore(dir);
    await store2.load();
    assert.equal(store2.getBest('worker', ''), '持久化prompt');
  } finally {
    await cleanup();
  }
});

test('P2 getSummary：所有角色统计', () => {
  const store = new PromptStore('/tmp/p2-test');
  store.recordOutcome('worker', 'w', 75);
  store.recordOutcome('planner', 'p', 80);
  const summary = store.getSummary();
  assert.ok(summary.worker.versions >= 1);
  assert.ok(summary.planner.bestScore >= 80);
  assert.equal(summary.finalizer.versions, 0);
});

test('P2 getPromptStore：单例', () => {
  const s1 = getPromptStore();
  const s2 = getPromptStore();
  assert.equal(s1, s2);
});
