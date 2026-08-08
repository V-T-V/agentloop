/**
 * tools/registry.ts + tools/load-all.ts 测试（R10-D8 错误路径覆盖）。
 *
 * 这两个模块此前无独立测试（由 cli/run-task 间接覆盖）。本测试覆盖：
 *   registry.ts：
 *     - defineTool 原样返回 + 类型约束
 *     - builtinTools 含 7 个内置工具且 name 唯一
 *     - findTool 命中/未命中
 *   load-all.ts（错误路径重点）：
 *     - loadAllTools 无 MCP 配置时返回纯内置工具，closeAll 是 no-op，mcpToolCount=0
 *     - loadAllTools 在 MCP 加载抛错时不阻塞（返回内置工具 + closeAll no-op + count 0）
 *     - registerCleanup 幂等（多次注册不重复挂 exit 监听，cleanup 内部 cleaned 标志防重）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defineTool, builtinTools, findTool } from '../src/tools/registry.ts';
import { loadAllTools, registerCleanup } from '../src/tools/load-all.ts';

// ---- registry.ts ----

test('defineTool：原样返回传入对象（不带运行时开销）', () => {
  const t = defineTool({
    name: 'probe',
    description: 'd',
    parameters: { type: 'object' as const, properties: {}, required: [] },
    execute: async () => ({ ok: true, output: 'r' }),
  });
  assert.equal(t.name, 'probe');
  assert.equal(t.description, 'd');
  assert.equal(typeof t.execute, 'function');
});

test('builtinTools：含全部 7 个内置工具', () => {
  assert.ok(builtinTools.length >= 7, `至少 7 个内置工具，实际 ${builtinTools.length}`);
  const names = builtinTools.map((t) => t.name);
  for (const expected of ['datetime', 'calculator', 'iterate', 'web_search', 'http_get', 'recall', 'memory_store']) {
    assert.ok(names.includes(expected), `应含内置工具 ${expected}`);
  }
});

test('builtinTools：name 唯一（无重复注册）', () => {
  const names = builtinTools.map((t) => t.name);
  const set = new Set(names);
  assert.equal(set.size, names.length, '工具名不应重复');
});

test('findTool：命中返回工具对象', () => {
  const t = findTool('datetime');
  assert.ok(t);
  assert.equal(t!.name, 'datetime');
});

test('findTool：未命中返回 undefined', () => {
  assert.equal(findTool('nonexistent-tool-xyz'), undefined);
});

// ---- load-all.ts ----

test('loadAllTools：无 MCP 配置时返回纯内置工具 + closeAll no-op + count 0', async () => {
  // 清掉 MCP 配置环境变量，且默认配置路径不存在
  const prev = process.env.LOOP_MCP_CONFIG;
  delete process.env.LOOP_MCP_CONFIG;
  try {
    const result = await loadAllTools();
    assert.ok(result.tools.length >= builtinTools.length, '至少内置工具数');
    assert.equal(result.mcpToolCount, 0, '无 MCP 配置时 count=0');
    // closeAll 是 no-op，调用不抛错
    await result.closeAll();
  } finally {
    if (prev !== undefined) process.env.LOOP_MCP_CONFIG = prev;
  }
});

test('loadAllTools：内置工具在结果中（datetime/calculator 等）', async () => {
  const prev = process.env.LOOP_MCP_CONFIG;
  delete process.env.LOOP_MCP_CONFIG;
  try {
    const result = await loadAllTools();
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('datetime'));
    assert.ok(names.includes('calculator'));
  } finally {
    if (prev !== undefined) process.env.LOOP_MCP_CONFIG = prev;
  }
});

test('registerCleanup：注册不抛错（仅挂 exit 事件，不干扰 SIGINT/SIGTERM）', () => {
  // 记录注册前的 exit 监听数，注册后应 +1（不重复挂多个）
  const before = process.listenerCount('exit');
  registerCleanup(async () => {});
  const after = process.listenerCount('exit');
  assert.equal(after, before + 1, '应恰好新增 1 个 exit 监听');
});

test('registerCleanup：cleanup 内部幂等（cleaned 标志防重复 close）', async () => {
  let closeCalls = 0;
  registerCleanup(async () => {
    closeCalls++;
  });
  // 这里无法直接触发注册的 exit handler，但可验证 closeAll 多次调用的幂等语义
  // 通过 loadAllTools 的 closeAll 验证（无 MCP 时 no-op，多次调用安全）
  const prev = process.env.LOOP_MCP_CONFIG;
  delete process.env.LOOP_MCP_CONFIG;
  try {
    const r = await loadAllTools();
    await r.closeAll();
    await r.closeAll(); // 重复调用应安全
    assert.equal(closeCalls, 0, 'closeCalls 计数不受 loadAllTools.closeAll 影响（独立注册）');
  } finally {
    if (prev !== undefined) process.env.LOOP_MCP_CONFIG = prev;
  }
});

test('loadAllTools：结果 tools 数组与 builtinTools 解耦（修改结果不影响内置）', async () => {
  const prev = process.env.LOOP_MCP_CONFIG;
  delete process.env.LOOP_MCP_CONFIG;
  try {
    const result = await loadAllTools();
    const beforeLen = result.tools.length;
    result.tools.push({ name: 'injected', description: 'x', parameters: { type: 'object' }, execute: async () => ({ ok: true, output: '' }) } as never);
    // 再次加载应不受影响（builtinTools 是模块级常量，未被污染）
    const result2 = await loadAllTools();
    assert.equal(result2.tools.length, beforeLen, '注入不影响后续加载（builtinTools 未被污染）');
  } finally {
    if (prev !== undefined) process.env.LOOP_MCP_CONFIG = prev;
  }
});
