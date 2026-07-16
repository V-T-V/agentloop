/**
 * MCP 客户端的测试。
 *
 * 用一个内联的 mock MCP server（echo 脚本）测试完整握手 + tools/list + tools/call 流程。
 * Mock server 实现为一段 Node 脚本，读 stdin 行、写 stdout 行。
 *
 * 这避免了依赖真实 MCP server 包（如 @modelcontextprotocol/server-filesystem），
 * 同时覆盖完整的 JSON-RPC 协议路径。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpStdioClient } from '../src/mcp/client.ts';
import { loadMcpTools } from '../src/mcp/adapter.ts';

/**
 * Mock MCP server 脚本：实现最小协议。
 * 响应 initialize / tools/list / tools/call。
 * 用 node 直接执行。
 */
const MOCK_SERVER_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const tools = [
  { name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: '加法', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a','b'] } },
];
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    respond(msg.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0' } });
  } else if (msg.method === 'notifications/initialized') {
    // 通知，不响应
  } else if (msg.method === 'tools/list') {
    respond(msg.id, { tools });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name === 'echo') respond(msg.id, { content: [{ type: 'text', text: args.text }] });
    else if (name === 'add') respond(msg.id, { content: [{ type: 'text', text: String(args.a + args.b) }] });
    else respond(msg.id, { content: [{ type: 'text', text: 'unknown' }], isError: true });
  }
});
`;

async function writeMockServer(): Promise<[string, () => Promise<void>]> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-'));
  const scriptPath = join(dir, 'mock-server.js');
  await writeFile(scriptPath, MOCK_SERVER_SCRIPT, 'utf8');
  return [scriptPath, () => rm(dir, { recursive: true, force: true })];
}

test('MCP：initialize 握手成功', async () => {
  const [script, cleanup] = await writeMockServer();
  try {
    const client = new McpStdioClient({ command: 'node', args: [script] });
    const result = await client.connect();
    assert.equal(result.serverInfo.name, 'mock');
    assert.equal(result.protocolVersion, '2025-11-25');
    assert.ok(client.isConnected);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('MCP：tools/list 返回工具', async () => {
  const [script, cleanup] = await writeMockServer();
  try {
    const client = new McpStdioClient({ command: 'node', args: [script] });
    await client.connect();
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 2);
    assert.ok(tools.some((t) => t.name === 'echo'));
    assert.ok(tools.some((t) => t.name === 'add'));
    await client.close();
  } finally {
    await cleanup();
  }
});

test('MCP：tools/call echo 返回正确结果', async () => {
  const [script, cleanup] = await writeMockServer();
  try {
    const client = new McpStdioClient({ command: 'node', args: [script] });
    await client.connect();
    const result = await client.callTool({ name: 'echo', arguments: { text: '你好世界' } });
    assert.equal(result.content[0]!.text, '你好世界');
    assert.ok(!result.isError);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('MCP：tools/call add 返回计算结果', async () => {
  const [script, cleanup] = await writeMockServer();
  try {
    const client = new McpStdioClient({ command: 'node', args: [script] });
    await client.connect();
    const result = await client.callTool({ name: 'add', arguments: { a: 3, b: 4 } });
    assert.equal(result.content[0]!.text, '7');
    await client.close();
  } finally {
    await cleanup();
  }
});

test('MCP：tools/call 未知工具返回 isError', async () => {
  const [script, cleanup] = await writeMockServer();
  try {
    const client = new McpStdioClient({ command: 'node', args: [script] });
    await client.connect();
    const result = await client.callTool({ name: 'nonexistent', arguments: {} });
    assert.ok(result.isError);
    await client.close();
  } finally {
    await cleanup();
  }
});

test('MCP adapter：loadMcpTools 映射为 ToolDef', async () => {
  const [script, cleanup] = await writeMockServer();
  try {
    const { tools, close } = await loadMcpTools({ command: 'node', args: [script], requiresApproval: false });
    assert.ok(tools.length >= 2);
    const echoTool = tools.find((t) => t.name === 'echo');
    assert.ok(echoTool, 'echo 工具存在');
    assert.equal(echoTool!.requiresApproval, false);
    // 执行 echo 工具
    const result = await echoTool!.execute({ text: 'test123' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'test123');
    await close();
  } finally {
    await cleanup();
  }
});

test('MCP adapter：前缀工具名避免冲突', async () => {
  const [script, cleanup] = await writeMockServer();
  try {
    const { tools, close } = await loadMcpTools({
      command: 'node',
      args: [script],
      toolPrefix: 'mock',
      requiresApproval: false,
    });
    assert.ok(tools.some((t) => t.name === 'mock_echo'), '加了前缀');
    await close();
  } finally {
    await cleanup();
  }
});

test('MCP adapter：默认 requiresApproval=true', async () => {
  const [script, cleanup] = await writeMockServer();
  try {
    const { tools, close } = await loadMcpTools({ command: 'node', args: [script] });
    assert.equal(tools[0]!.requiresApproval, true, '外部工具默认需审批');
    await close();
  } finally {
    await cleanup();
  }
});

test('MCP：close 后 isConnected=false', async () => {
  const [script, cleanup] = await writeMockServer();
  try {
    const client = new McpStdioClient({ command: 'node', args: [script] });
    await client.connect();
    assert.ok(client.isConnected);
    await client.close();
    assert.ok(!client.isConnected);
  } finally {
    await cleanup();
  }
});
