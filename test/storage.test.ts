/**
 * 持久化存储的测试。
 *
 * 用临时目录验证：保存→加载往返无损、列表、删除、损坏文件容错、空目录。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Memory } from '../src/memory.ts';
import { FileSessionStore, newSessionId, makeSession } from '../src/storage-file.ts';
import type { SerializedSession } from '../src/storage.ts';

/** 每个测试用独立临时目录，互不干扰 */
async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'agentloop-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sampleSession(id: string): SerializedSession {
  const mem = new Memory('你是助手');
  mem.add({ role: 'user', content: '现在几点？' });
  mem.add({ role: 'assistant', content: '调用工具后得知是 10 点。' });
  return makeSession(id, '你是助手', mem, '测试标题');
}

test('保存→加载：往返无损', async () => {
  await withTmpDir(async (dir) => {
    const store = new FileSessionStore(dir);
    const session = sampleSession('s1');
    await store.save('s1', session);
    const loaded = await store.load('s1');
    assert.ok(loaded);
    assert.equal(loaded!.title, '测试标题');
    assert.equal(loaded!.system, '你是助手');
    assert.equal(loaded!.messages.length, 3);
    assert.equal(loaded!.messages[1]!.role, 'user');
    assert.equal(loaded!.messages[1]!.content, '现在几点？');
  });
});

test('加载不存在的会话 → null', async () => {
  await withTmpDir(async (dir) => {
    const store = new FileSessionStore(dir);
    assert.equal(await store.load('ghost'), null);
  });
});

test('列表：按更新时间倒序', async () => {
  await withTmpDir(async (dir) => {
    const store = new FileSessionStore(dir);
    await store.save('a', { ...sampleSession('a'), updatedAt: '2026-01-01T00:00:00.000Z' });
    await store.save('b', { ...sampleSession('b'), updatedAt: '2026-06-01T00:00:00.000Z' });
    const list = await store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, 'b'); // 更新的在前
    assert.equal(list[1]!.id, 'a');
  });
});

test('列表：空目录返回空数组', async () => {
  await withTmpDir(async (dir) => {
    const store = new FileSessionStore(dir);
    assert.deepEqual(await store.list(), []);
  });
});

test('列表：损坏的 JSON 文件被跳过', async () => {
  await withTmpDir(async (dir) => {
    const store = new FileSessionStore(dir);
    await store.save('good', sampleSession('good'));
    // 写一个损坏文件
    await writeFile(join(dir, 'broken.json'), '{不是合法json', 'utf8');
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, 'good');
  });
});

test('删除：移除会话文件', async () => {
  await withTmpDir(async (dir) => {
    const store = new FileSessionStore(dir);
    await store.save('s1', sampleSession('s1'));
    await store.delete('s1');
    assert.equal(await store.load('s1'), null);
  });
});

test('删除不存在的会话不抛错', async () => {
  await withTmpDir(async (dir) => {
    const store = new FileSessionStore(dir);
    await store.delete('ghost'); // 不应抛
  });
});

test('Memory serialize / fromMessages 往返无损', () => {
  const original = new Memory('sys');
  original.add({ role: 'user', content: 'hi' });
  original.add({ role: 'assistant', content: 'hello' });
  const msgs = original.serializeMessages();
  const restored = Memory.fromMessages(msgs);
  assert.equal(restored.length, 3);
  assert.equal(restored.systemPrompt, 'sys');
  assert.equal(restored.serializeMessages()[1]!.content, 'hi');
});

test('systemPrompt getter：返回首条 system 内容', () => {
  const m = new Memory('我的提示');
  assert.equal(m.systemPrompt, '我的提示');
});

test('newSessionId：唯一且可排序', () => {
  const a = newSessionId();
  const b = newSessionId();
  assert.notEqual(a, b);
  assert.ok(a.length > 0);
});

test('makeSession：默认标题取首条用户消息（截断到 30 字符）', () => {
  const mem = new Memory('sys');
  mem.add({ role: 'user', content: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多余的字' });
  const s = makeSession('id1', 'sys', mem);
  assert.equal(s.title.length, 30); // 截断到 30 字符
  assert.ok(s.title.startsWith('一二三'));
});
