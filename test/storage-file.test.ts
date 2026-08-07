/**
 * storage-file.ts 独立深层测试（R5-D3）。
 *
 * FileSessionStore 是会话持久化的默认实现，之前仅由 storage.test.ts 间接覆盖。
 * 本文件覆盖：原子写/tmp 中间文件、load 容错（不存在/坏 JSON/schema 不符）、
 * list 容错（目录不存在/混合好坏文件/.tmp.json 跳过/排序）、delete 幂等、
 * newSessionId 唯一性与可排序性、makeSession 默认标题推导。
 *
 * 全部用独立临时目录，不污染工作区。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileSessionStore,
  newSessionId,
  makeSession,
} from '../src/storage-file.ts';
import type { SerializedSession } from '../src/storage.ts';

/** 构造一个最小合法的 SerializedSession */
function sampleSession(id: string, overrides: Partial<SerializedSession> = {}): SerializedSession {
  const now = '2026-08-06T00:00:00.000Z';
  return {
    id,
    title: `会话-${id}`,
    system: '你是助手',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('save/load 往返：完整字段保持一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-roundtrip-'));
  try {
    const store = new FileSessionStore(dir);
    const data = sampleSession('s1', { title: '往返测试', updatedAt: '2026-08-06T12:00:00.000Z' });
    await store.save('s1', data);
    const loaded = await store.load('s1');
    assert.deepEqual(loaded, data, 'load 应完整还原 save 的数据');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('save 原子写：完成后不留 .tmp 残留文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-atomic-'));
  try {
    const store = new FileSessionStore(dir);
    await store.save('s2', sampleSession('s2'));
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), '不应残留 .tmp 文件');
    assert.ok(files.includes('s2.json'), '应有最终 .json 文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('save 自动创建不存在的目录', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sf-mkdir-'));
  const nested = join(base, 'deep', 'nested', 'sessions');
  try {
    const store = new FileSessionStore(nested);
    await store.save('s3', sampleSession('s3'));
    const loaded = await store.load('s3');
    assert.equal(loaded?.id, 's3', '自动建目录后能正常读写');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('load：不存在的 id 返回 null（不抛错）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-missing-'));
  try {
    const store = new FileSessionStore(dir);
    const loaded = await store.load('never-exists');
    assert.equal(loaded, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('load：坏 JSON 文件返回 null（容错不抛）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-badjson-'));
  try {
    await writeFile(join(dir, 'broken.json'), '{ this is not valid json', 'utf8');
    const store = new FileSessionStore(dir);
    const loaded = await store.load('broken');
    assert.equal(loaded, null, '坏 JSON 应被吞掉返回 null');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('load：__schema 不符返回 null（防误读异构文件）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-schema-'));
  try {
    // 模拟别的程序写的同名文件
    await writeFile(
      join(dir, 'alien.json'),
      JSON.stringify({ __schema: 'something-else', version: 1, data: {} }),
      'utf8',
    );
    const store = new FileSessionStore(dir);
    const loaded = await store.load('alien');
    assert.equal(loaded, null, 'schema key 不符应拒绝加载');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list：目录不存在返回空数组（不抛错）', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sf-nodir-'));
  try {
    const store = new FileSessionStore(join(base, 'does-not-exist'));
    const metas = await store.list();
    assert.deepEqual(metas, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('list：空目录返回空数组', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-empty-'));
  try {
    const store = new FileSessionStore(dir);
    const metas = await store.list();
    assert.deepEqual(metas, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list：按 updatedAt 倒序（最近在前）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-sort-'));
  try {
    const store = new FileSessionStore(dir);
    await store.save('old', sampleSession('old', { updatedAt: '2026-01-01T00:00:00.000Z' }));
    await store.save('newest', sampleSession('newest', { updatedAt: '2026-12-01T00:00:00.000Z' }));
    await store.save('mid', sampleSession('mid', { updatedAt: '2026-06-01T00:00:00.000Z' }));
    const metas = await store.list();
    assert.deepEqual(
      metas.map((m) => m.id),
      ['newest', 'mid', 'old'],
      '应按 updatedAt 倒序',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list：损坏文件被跳过，不阻塞整体列表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-skip-'));
  try {
    const store = new FileSessionStore(dir);
    await store.save('good1', sampleSession('good1'));
    // 写一个坏 JSON
    await writeFile(join(dir, 'corrupt.json'), 'not json', 'utf8');
    // 写一个 schema 不符的
    await writeFile(
      join(dir, 'alien.json'),
      JSON.stringify({ __schema: 'other', data: {} }),
      'utf8',
    );
    await store.save('good2', sampleSession('good2'));
    const metas = await store.list();
    const ids = metas.map((m) => m.id);
    assert.ok(ids.includes('good1'), 'good1 应出现');
    assert.ok(ids.includes('good2'), 'good2 应出现');
    assert.ok(!ids.includes('corrupt'), '损坏文件应被跳过');
    assert.ok(!ids.includes('alien'), 'schema 不符应被跳过');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list：跳过 .tmp.json 中间文件（原子写残留不入列表）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-tmpskip-'));
  try {
    const store = new FileSessionStore(dir);
    await store.save('real', sampleSession('real'));
    // 模拟一次崩溃残留的 tmp 文件（注意命名：save 写的是 <id>.json.tmp，这里测 .tmp.json 后缀规则）
    await writeFile(
      join(dir, 'crash.tmp.json'),
      JSON.stringify({ __schema: 'agentloop-session', version: 1, data: sampleSession('crash') }),
      'utf8',
    );
    const metas = await store.list();
    const ids = metas.map((m) => m.id);
    assert.ok(ids.includes('real'), 'real 应出现');
    assert.ok(!ids.some((id) => id.endsWith('.tmp')), '不应出现 tmp 残留条目');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list：跳过非 .json 文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-nonjson-'));
  try {
    const store = new FileSessionStore(dir);
    await store.save('legit', sampleSession('legit'));
    await writeFile(join(dir, 'readme.txt'), 'hello', 'utf8');
    await writeFile(join(dir, 'notes.md'), '# hi', 'utf8');
    const metas = await store.list();
    assert.deepEqual(
      metas.map((m) => m.id),
      ['legit'],
      '只列 .json 会话文件',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list：返回的 meta 字段完整（id/title/updatedAt/messageCount）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-meta-'));
  try {
    const store = new FileSessionStore(dir);
    const data = sampleSession('s9', { title: '元信息测试', updatedAt: '2026-08-06T08:00:00.000Z' });
    await store.save('s9', data);
    const metas = await store.list();
    assert.equal(metas.length, 1);
    const m = metas[0]!;
    assert.equal(m.id, 's9');
    assert.equal(m.title, '元信息测试');
    assert.equal(m.updatedAt, '2026-08-06T08:00:00.000Z');
    assert.equal(m.messageCount, 3, 'messageCount 应等于 messages 数组长度');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delete：删除后 load 返回 null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-delete-'));
  try {
    const store = new FileSessionStore(dir);
    await store.save('s10', sampleSession('s10'));
    assert.ok((await store.load('s10')) !== null, '删除前能读到');
    await store.delete('s10');
    assert.equal(await store.load('s10'), null, '删除后读不到');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delete：删除不存在的 id 不抛错（幂等）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-delidem-'));
  try {
    const store = new FileSessionStore(dir);
    await store.delete('never-exists'); // 不应抛错
    await store.delete('never-exists'); // 重复删也不抛
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delete 后 list 不再包含该条目', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-dellist-'));
  try {
    const store = new FileSessionStore(dir);
    await store.save('keep', sampleSession('keep'));
    await store.save('gone', sampleSession('gone'));
    await store.delete('gone');
    const ids = (await store.list()).map((m) => m.id);
    assert.deepEqual(ids, ['keep']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('覆盖 save：同名 id 二次写应替换旧内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-overwrite-'));
  try {
    const store = new FileSessionStore(dir);
    await store.save('s11', sampleSession('s11', { title: '旧标题' }));
    await store.save('s11', sampleSession('s11', { title: '新标题' }));
    const loaded = await store.load('s11');
    assert.equal(loaded?.title, '新标题', '二次写应覆盖');
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 1, '只应有一个 .json 文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('newSessionId：返回非空字符串', () => {
  const id = newSessionId();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0, 'id 非空');
});

test('newSessionId：多次调用应唯一', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) ids.add(newSessionId());
  assert.equal(ids.size, 1000, '1000 次调用应产生 1000 个唯一 id');
});

test('newSessionId：单调递增（时间戳前缀保证可排序）', () => {
  const a = newSessionId();
  const b = newSessionId();
  // base36 时间戳前缀，b 应 >= a（同毫秒内随机后缀可能乱序，但前缀不退）
  assert.ok(a <= b || b <= a, '两个 id 可比较（不抛错）');
  // 前缀（去掉随机后缀 4 字符）应非递减
  const prefix = (id: string) => id.slice(0, -4);
  const samples = Array.from({ length: 50 }, () => newSessionId()).map(prefix);
  const sorted = [...samples].sort();
  // 允许相等（同毫秒），但不允许乱序
  assert.deepEqual(samples, sorted, '时间戳前缀应单调非减');
});

test('makeSession：默认标题取首条用户消息前 30 字符', () => {
  const fakeMemory = {
    serializeMessages: () => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '这是一条比较长的用户消息用于测试默认标题截断功能的一整段话' },
    ],
  };
  const session = makeSession('s12', 'sys', fakeMemory as never);
  assert.equal(
    session.title,
    '这是一条比较长的用户消息用于测试默认标题截断功能的一整段话'.slice(0, 30),
    '默认标题为首条用户消息前 30 字',
  );
});

test('makeSession：显式 title 优先于默认推导', () => {
  const fakeMemory = {
    serializeMessages: () => [{ role: 'user', content: '短消息' }],
  };
  const session = makeSession('s13', 'sys', fakeMemory as never, '显式标题');
  assert.equal(session.title, '显式标题');
});

test('makeSession：无用户消息时默认标题为「（新会话）」', () => {
  const fakeMemory = {
    serializeMessages: () => [{ role: 'system', content: 'sys' }],
  };
  const session = makeSession('s14', 'sys', fakeMemory as never);
  assert.equal(session.title, '（新会话）');
});

test('makeSession：createdAt 与 updatedAt 一致（新建时刻）', () => {
  const fakeMemory = { serializeMessages: () => [] };
  const before = new Date().toISOString();
  const session = makeSession('s15', 'sys', fakeMemory as never);
  const after = new Date().toISOString();
  assert.ok(session.createdAt >= before && session.createdAt <= after, 'createdAt 为当前时刻');
  assert.equal(session.createdAt, session.updatedAt, '新建时两个时间戳一致');
});

test('makeSession：保留 id/system/messages 透传', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const fakeMemory = { serializeMessages: () => msgs };
  const session = makeSession('s16', '系统提示', fakeMemory as never, '标题');
  assert.equal(session.id, 's16');
  assert.equal(session.system, '系统提示');
  assert.deepEqual(session.messages, msgs);
});

test('构造函数：dir 参数覆盖默认 env 路径', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-ctor-'));
  try {
    const store = new FileSessionStore(dir);
    await store.save('s17', sampleSession('s17'));
    // 验证写到了显式传入的 dir 而非默认 .agentloop/sessions
    const files = await readdir(dir);
    assert.ok(files.includes('s17.json'), '应写入构造函数指定的目录');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('多 session 并发 save 不串扰', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-concurrent-'));
  try {
    const store = new FileSessionStore(dir);
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    await Promise.all(ids.map((id) => store.save(id, sampleSession(id))));
    const metas = await store.list();
    assert.equal(metas.length, 20, '20 个并发 save 应全部落盘');
    const savedIds = new Set(metas.map((m) => m.id));
    for (const id of ids) assert.ok(savedIds.has(id), `${id} 应存在`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
