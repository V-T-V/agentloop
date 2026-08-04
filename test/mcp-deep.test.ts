/**
 * mcp/client.ts 深层路径测试 —— 错误/超时/边角行为。
 *
 * mcp.test.ts 只覆盖 happy-path（mock server 永远响应）。本文件补：
 *   - connect 超时（server 不响应 initialize）
 *   - 二次 connect 抛「已连接」
 *   - 未连接调用方法抛「未连接」
 *   - tools/call 服务端返回 JSON-RPC error → reject(error.message)
 *   - listResources / listPrompts 请求与响应
 *   - 子进程异常退出 → pending 请求被 reject
 *   - 服务端发坏 JSON 行被忽略（不崩客户端）
 *   - 服务端发通知（无 id）被忽略
 *   - callTool 带图片/resource content 经 adapter renderToolContent 拼接
 *   - loadMcpServers 单 server 失败不阻塞其他
 *
 * 用内联 mock server 脚本覆盖各场景，临时目录隔离。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpStdioClient } from '../src/mcp/client.ts';
import { loadMcpTools, loadMcpServers } from '../src/mcp/adapter.ts';

/** 写一个 mock server 脚本，返回 [path, cleanup] */
async function writeMockServer(script: string): Promise<[string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'mcpd-'));
  const scriptPath = join(dir, 'mock-server.js');
  await writeFile(scriptPath, script, 'utf8');
  return [scriptPath, () => rm(dir, { recursive: true, force: true })];
}

/** 响应初始化的标准 mock server 源码（带可选扩展） */
function baseServer(extra = ''): string {
  return `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
function respondError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n'); }
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    respond(msg.id, { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'mock', version: '1.0' } });
  } else if (msg.method === 'notifications/initialized') {
    // 通知
  } ${extra}
});
`;
}

test('client：connect 超时（server 不响应 initialize）', async () => {
  // 这个 server 读 stdin 但永不响应 initialize
  const script = `
  const readline = require('readline');
  readline.createInterface({ input: process.stdin }).on('line', () => { /* 忽略 */ });
  `;
  const [path, cleanup] = await writeMockServer(script);
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await assert.rejects(client.connect(300), /超时|timeout/i);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('client：二次 connect 抛「已连接」', async () => {
  const [path, cleanup] = await writeMockServer(baseServer());
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    await assert.rejects(client.connect(), /已连接/);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('client：未连接调用 listTools 抛错', async () => {
  const client = new McpStdioClient({ command: 'node', args: ['x'] });
  await assert.rejects(client.listTools(), /未连接/);
});

test('client：未连接调用 callTool 抛错', async () => {
  const client = new McpStdioClient({ command: 'node', args: ['x'] });
  await assert.rejects(client.callTool({ name: 'foo' }), /未连接/);
});

test('client：tools/call 返回 JSON-RPC error → reject 含 message', async () => {
  const extra = `else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: [{ name: 'boom', inputSchema: { type: 'object' } }] });
  } else if (msg.method === 'tools/call') {
    respondError(msg.id, -32602, '参数错误：缺字段');
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    await assert.rejects(client.callTool({ name: 'boom' }), /参数错误：缺字段/);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('client：tools/call 请求超时（server 响应 tools/list 但不响应 call）', async () => {
  const extra = `else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: [{ name: 'hang', inputSchema: { type: 'object' } }] });
  } else if (msg.method === 'tools/call') {
    // 故意不响应
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    await assert.rejects(client.callTool({ name: 'hang' }), /超时/);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('client：listResources 返回资源列表', async () => {
  const extra = `else if (msg.method === 'resources/list') {
    respond(msg.id, { resources: [{ uri: 'file:///a.txt', name: 'A' }, { uri: 'file:///b.txt' }] });
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    const { resources } = await client.listResources();
    assert.equal(resources.length, 2);
    assert.equal(resources[0]!.uri, 'file:///a.txt');
    await client.close();
  } finally {
    await cleanup();
  }
});

test('client：listPrompts 返回提示模板列表', async () => {
  const extra = `else if (msg.method === 'prompts/list') {
    respond(msg.id, { prompts: [{ name: 'summarize', description: '总结' }] });
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    const { prompts } = await client.listPrompts();
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]!.name, 'summarize');
    await client.close();
  } finally {
    await cleanup();
  }
});

test('client：服务端发坏 JSON 行被忽略（不崩）', async () => {
  const extra = `else if (msg.method === 'tools/list') {
    // 先发坏行，再发正常响应
    process.stdout.write('this is not json\\n');
    respond(msg.id, { tools: [{ name: 'ok', inputSchema: { type: 'object' } }] });
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    const { tools } = await client.listTools();
    assert.equal(tools[0]!.name, 'ok');
    await client.close();
  } finally {
    await cleanup();
  }
});

test('client：服务端发通知（无 id）被忽略，不影响后续响应', async () => {
  const extra = `else if (msg.method === 'tools/list') {
    // 先发一个通知（无 id）
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\\n');
    respond(msg.id, { tools: [] });
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    const { tools } = await client.listTools();
    assert.equal(tools.length, 0);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('client：子进程立即退出 → pending 请求被 reject', async () => {
  // server 读到第一条消息后立即 process.exit
  const script = `
  process.stdin.on('data', () => {
    process.exit(1);
  });
  `;
  const [path, cleanup] = await writeMockServer(script);
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await assert.rejects(client.connect(2000), /退出|exit/i);
    // connect 期间进程已退出
    assert.ok(!client.isConnected);
  } finally {
    await cleanup();
  }
});

test('client：currentId 随请求递增', async () => {
  const extra = `else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: [] });
  } else if (msg.method === 'resources/list') {
    respond(msg.id, { resources: [] });
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    const before = client.currentId;
    await client.connect();
    // initialize 用了 id=1
    assert.equal(client.currentId, before + 1);
    await client.listTools(); // id=2
    assert.equal(client.currentId, before + 2);
    await client.listResources(); // id=3
    assert.equal(client.currentId, before + 3);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('client：server getter 返回 serverInfo', async () => {
  const [path, cleanup] = await writeMockServer(baseServer());
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    assert.equal(client.server, null); // 连接前
    const info = await client.connect();
    assert.equal(client.server, info);
    const serverInfo = client.server as { serverInfo: { name: string } } | null;
    assert.equal(serverInfo!.serverInfo.name, 'mock');
    await client.close();
    // close 后 server 仍保留（仅 initialized=false）
    assert.ok(client.server);
  } finally {
    await cleanup();
  }
});

test('adapter：图片/resource content 拼接为可读文本', async () => {
  const extra = `else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: [{ name: 'multi', inputSchema: { type: 'object' } }] });
  } else if (msg.method === 'tools/call') {
    respond(msg.id, { content: [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'base64...' },
      { type: 'resource', text: 'file:///x' },
    ] });
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const { tools, close } = await loadMcpTools({ command: 'node', args: [path], requiresApproval: false });
    const multi = tools.find((t) => t.name === 'multi')!;
    const result = await multi.execute({});
    assert.equal(result.ok, true);
    assert.ok(result.output!.includes('hello'));
    assert.ok(result.output!.includes('[图片 image/png]'));
    assert.ok(result.output!.includes('[资源 file:///x]'));
    await close();
  } finally {
    await cleanup();
  }
});

test('adapter：tool 调用失败（client 抛错）→ 返回 ok:false 含错误描述', async () => {
  const extra = `else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: [{ name: 'failer', inputSchema: { type: 'object' } }] });
  } else if (msg.method === 'tools/call') {
    respondError(msg.id, -32603, '内部错误');
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const { tools, close } = await loadMcpTools({ command: 'node', args: [path], requiresApproval: false });
    const failer = tools.find((t) => t.name === 'failer')!;
    const result = await failer.execute({});
    assert.equal(result.ok, false);
    assert.ok(result.output!.includes('内部错误'));
    assert.ok(result.output!.includes('failer'));
    await close();
  } finally {
    await cleanup();
  }
});

test('loadMcpServers：单个 server 加载失败不阻塞其他', async () => {
  // 一个坏 server（启动后立即退出，initialize 超时）+ 一个好 server
  const [badPath, badCleanup] = await writeMockServer('process.exit(1);');
  const [goodPath, goodCleanup] = await writeMockServer(baseServer(`else if (msg.method === 'tools/list') { respond(msg.id, { tools: [{ name: 'good_tool', inputSchema: { type: 'object' } }] }); }`));
  try {
    const { tools, closeAll } = await loadMcpServers({
      bad: { command: 'node', args: [badPath] },
      good: { command: 'node', args: [goodPath] },
    });
    // bad 失败被吞，good 的工具仍加载（带 good 前缀）
    assert.ok(tools.some((t) => t.name === 'good_good_tool'), 'good server 工具仍加载');
    await closeAll();
  } finally {
    await badCleanup();
    await goodCleanup();
  }
});

test('client：连接的进程退出后 close 不抛错（幂等清理）', async () => {
  const [path, cleanup] = await writeMockServer(baseServer());
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    await client.close();
    // 二次 close 不应抛错
    await client.close();
  } finally {
    await cleanup();
  }
});

// —————————— tools/list 分页（D7 新增 listAllTools）——————————

test('listAllTools：自动跟随 nextCursor 翻页合并所有工具', async () => {
  // 分页 server：3 页，每页 2 个工具，前两页返回 nextCursor
  const extra = `else if (msg.method === 'tools/list') {
    var cursor = msg.params && msg.params.cursor;
    var all = [
      { name: 't0', inputSchema: { type: 'object' } },
      { name: 't1', inputSchema: { type: 'object' } },
      { name: 't2', inputSchema: { type: 'object' } },
      { name: 't3', inputSchema: { type: 'object' } },
      { name: 't4', inputSchema: { type: 'object' } },
      { name: 't5', inputSchema: { type: 'object' } },
    ];
    if (!cursor) {
      respond(msg.id, { tools: all.slice(0, 2), nextCursor: 'page2' });
    } else if (cursor === 'page2') {
      respond(msg.id, { tools: all.slice(2, 4), nextCursor: 'page3' });
    } else if (cursor === 'page3') {
      respond(msg.id, { tools: all.slice(4, 6) }); // 末页无 nextCursor
    }
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    const { tools, nextCursor } = await client.listAllTools();
    assert.equal(tools.length, 6, '三页合并后共 6 个工具');
    assert.equal(tools[0]!.name, 't0');
    assert.equal(tools[5]!.name, 't5');
    assert.equal(nextCursor, undefined, '合并后不再有 nextCursor');
    await client.close();
  } finally {
    await cleanup();
  }
});

test('listAllTools：无分页（无 nextCursor）时返回单页全部工具', async () => {
  const extra = `else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: [
      { name: 'a', inputSchema: { type: 'object' } },
      { name: 'b', inputSchema: { type: 'object' } },
    ] });
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    const { tools } = await client.listAllTools();
    assert.equal(tools.length, 2);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('listAllTools：maxPages 上限防止死循环（server 永远返回 nextCursor）', async () => {
  // 坏 server：永远返回 nextCursor
  const extra = `else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: [{ name: 'x', inputSchema: { type: 'object' } }], nextCursor: 'forever' });
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const client = new McpStdioClient({ command: 'node', args: [path] });
    await client.connect();
    const { tools } = await client.listAllTools(3); // 仅允许翻 3 页
    assert.equal(tools.length, 3, '受 maxPages=3 限制，最多取 3 个 x');
    await client.close();
  } finally {
    await cleanup();
  }
});

test('adapter：loadMcpTools 对分页 server 拉取全部工具', async () => {
  const extra = `else if (msg.method === 'tools/list') {
    var cursor = msg.params && msg.params.cursor;
    if (!cursor) {
      respond(msg.id, { tools: [{ name: 'p1', inputSchema: { type: 'object' } }], nextCursor: 'c2' });
    } else {
      respond(msg.id, { tools: [{ name: 'p2', inputSchema: { type: 'object' } }] });
    }
  }`;
  const [path, cleanup] = await writeMockServer(baseServer(extra));
  try {
    const { tools, close } = await loadMcpTools({ command: 'node', args: [path], requiresApproval: false });
    assert.equal(tools.length, 2, '分页两页的工具都被加载');
    assert.ok(tools.some((t) => t.name === 'p1'));
    assert.ok(tools.some((t) => t.name === 'p2'));
    await close();
  } finally {
    await cleanup();
  }
});
