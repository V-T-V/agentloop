/**
 * mcp/adapter.ts 独立测试（R5-D4）。
 *
 * loadMcpTools / loadMcpServers 依赖 McpStdioClient（会 spawn 子进程）。
 * 本文件通过替换 McpStdioClient 原型方法（connect/listAllTools/callTool/close）
 * 注入受控行为，专门验证适配层的纯逻辑：
 *   - MCP ToolDefinition → ToolDef 字段映射（name/description/parameters/requiresApproval）
 *   - toolPrefix 加前缀防冲突
 *   - inputSchema 缺失兜底为空 object schema
 *   - description 缺失兜底
 *   - execute 成功：拼接 content（text/image/resource 混合）
 *   - execute 失败（isError=true）：ok:false
 *   - execute 抛错：捕获并返回 ok:false + 错误消息
 *   - requiresApproval 默认 true / 显式 false
 *   - close 透传 client.close
 *   - loadMcpServers 批量合并 + 前缀 + 单 server 失败不阻塞
 *
 * 不 spawn 任何子进程，不依赖网络。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { McpStdioClient } from '../src/mcp/client.ts';
import { loadMcpTools, loadMcpServers } from '../src/mcp/adapter.ts';
import type { ToolDefinition, ToolCallResult, ToolCallResultContent } from '../src/mcp/protocol.ts';

/** 受控的 client 行为：可指定工具列表、callTool 返回值/抛错、connect/close 调用计数 */
interface StubBehavior {
  tools?: ToolDefinition[];
  callToolResult?: ToolCallResult;
  callToolThrows?: unknown;
  connectResult?: unknown;
  connectThrows?: unknown;
}

interface CallLog {
  connect: number;
  close: number;
  callTool: Array<{ name: string; arguments?: Record<string, unknown> }>;
}

/** 安装 stub：返回还原函数与调用日志 */
function stubClient(behavior: StubBehavior = {}): { restore: () => void; calls: CallLog } {
  const calls: CallLog = { connect: 0, close: 0, callTool: [] };
  const proto = McpStdioClient.prototype as unknown as Record<string, unknown>;
  const orig: Record<string, unknown> = {
    connect: proto.connect,
    listAllTools: proto.listAllTools,
    callTool: proto.callTool,
    close: proto.close,
  };
  proto.connect = async function () {
    calls.connect++;
    if (behavior.connectThrows) throw behavior.connectThrows;
    return behavior.connectResult ?? { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'stub', version: '1' } };
  };
  proto.listAllTools = async function () {
    return { tools: behavior.tools ?? [] };
  };
  proto.callTool = async function (params: { name: string; arguments?: Record<string, unknown> }) {
    calls.callTool.push({ name: params.name, arguments: params.arguments });
    if (behavior.callToolThrows) throw behavior.callToolThrows;
    return behavior.callToolResult ?? { content: [{ type: 'text' as const, text: 'ok' }] };
  };
  proto.close = async function () {
    calls.close++;
  };
  return {
    calls,
    restore: () => {
      proto.connect = orig.connect;
      proto.listAllTools = orig.listAllTools;
      proto.callTool = orig.callTool;
      proto.close = orig.close;
    },
  };
}

const baseConfig = { command: 'stub', args: [] };

test('loadMcpTools：name/description/parameters 直接映射', async () => {
  const stub = stubClient({
    tools: [
      {
        name: 'search',
        description: '搜索工具',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    ],
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'search');
    assert.equal(tools[0]!.description, '搜索工具');
    assert.deepEqual(tools[0]!.parameters, {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：默认 requiresApproval=true', async () => {
  const stub = stubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    assert.equal(tools[0]!.requiresApproval, true, 'MCP 外部工具默认需审批');
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：显式 requiresApproval=false 透传', async () => {
  const stub = stubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
  try {
    const { tools } = await loadMcpTools({ ...baseConfig, requiresApproval: false });
    assert.equal(tools[0]!.requiresApproval, false);
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：toolPrefix 加前缀防多 server 冲突', async () => {
  const stub = stubClient({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] });
  try {
    const { tools } = await loadMcpTools({ ...baseConfig, toolPrefix: 'fs' });
    assert.equal(tools[0]!.name, 'fs_read', '前缀用 _ 拼接');
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：无前缀时 name 保持原样', async () => {
  const stub = stubClient({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    assert.equal(tools[0]!.name, 'read');
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：inputSchema 缺失兜底为空 object schema', async () => {
  const stub = stubClient({
    // @ts-expect-error 测试缺失 inputSchema 的容错
    tools: [{ name: 't' }],
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    assert.deepEqual(tools[0]!.parameters, { type: 'object', properties: {} });
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：description 缺失兜底为「MCP 工具：{name}」', async () => {
  const stub = stubClient({ tools: [{ name: 'calc', inputSchema: { type: 'object' } }] });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    assert.equal(tools[0]!.description, 'MCP 工具：calc');
  } finally {
    stub.restore();
  }
});

test('execute：成功返回 ok:true + 拼接 text content', async () => {
  const stub = stubClient({
    tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    callToolResult: { content: [{ type: 'text', text: 'hello world' }] },
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    const result = await tools[0]!.execute({ msg: 'hi' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'hello world');
  } finally {
    stub.restore();
  }
});

test('execute：多 content 用换行拼接', async () => {
  const contents: ToolCallResultContent[] = [
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ];
  const stub = stubClient({
    tools: [{ name: 't', inputSchema: { type: 'object' } }],
    callToolResult: { content: contents },
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    const result = await tools[0]!.execute({});
    assert.equal(result.output, '第一段\n第二段');
  } finally {
    stub.restore();
  }
});

test('execute：image content 渲染为「[图片 mimeType]」', async () => {
  const stub = stubClient({
    tools: [{ name: 't', inputSchema: { type: 'object' } }],
    callToolResult: { content: [{ type: 'image', data: 'base64...', mimeType: 'image/png' }] },
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    const result = await tools[0]!.execute({});
    assert.equal(result.output, '[图片 image/png]');
  } finally {
    stub.restore();
  }
});

test('execute：image content 无 mimeType 渲染为「[图片 ]」', async () => {
  const stub = stubClient({
    tools: [{ name: 't', inputSchema: { type: 'object' } }],
    callToolResult: { content: [{ type: 'image', data: 'x' }] },
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    const result = await tools[0]!.execute({});
    assert.equal(result.output, '[图片 ]');
  } finally {
    stub.restore();
  }
});

test('execute：resource content 渲染为「[资源 text]」', async () => {
  const stub = stubClient({
    tools: [{ name: 't', inputSchema: { type: 'object' } }],
    callToolResult: { content: [{ type: 'resource', text: 'file:///a.txt' }] },
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    const result = await tools[0]!.execute({});
    assert.equal(result.output, '[资源 file:///a.txt]');
  } finally {
    stub.restore();
  }
});

test('execute：混合 text/image/resource 三类拼接', async () => {
  const stub = stubClient({
    tools: [{ name: 't', inputSchema: { type: 'object' } }],
    callToolResult: {
      content: [
        { type: 'text', text: '说明' },
        { type: 'image', mimeType: 'image/jpeg' },
        { type: 'resource', text: 'uri' },
      ],
    },
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    const result = await tools[0]!.execute({});
    assert.equal(result.output, '说明\n[图片 image/jpeg]\n[资源 uri]');
  } finally {
    stub.restore();
  }
});

test('execute：MCP 返回 isError=true 时 ok:false', async () => {
  const stub = stubClient({
    tools: [{ name: 'fail', inputSchema: { type: 'object' } }],
    callToolResult: { content: [{ type: 'text', text: '工具内部错误' }], isError: true },
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    const result = await tools[0]!.execute({});
    assert.equal(result.ok, false, 'isError 时 ok:false');
    assert.equal(result.output, '工具内部错误', 'output 仍透传');
  } finally {
    stub.restore();
  }
});

test('execute：callTool 抛错被捕获，返回 ok:false + 失败消息', async () => {
  const stub = stubClient({
    tools: [{ name: 'boom', inputSchema: { type: 'object' } }],
    callToolThrows: new Error('连接断开'),
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    const result = await tools[0]!.execute({});
    assert.equal(result.ok, false);
    assert.ok(result.output.includes('调用失败'), '应含「调用失败」前缀');
    assert.ok(result.output.includes('连接断开'), '应含原始错误消息');
    assert.ok(result.output.includes('boom'), '应含工具名');
  } finally {
    stub.restore();
  }
});

test('execute：callTool 抛非 Error 对象也能拼接', async () => {
  const stub = stubClient({
    tools: [{ name: 'boom2', inputSchema: { type: 'object' } }],
    callToolThrows: '字符串错误',
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    const result = await tools[0]!.execute({});
    assert.equal(result.ok, false);
    assert.ok(result.output.includes('字符串错误'));
  } finally {
    stub.restore();
  }
});

test('execute：透传 arguments 给 client.callTool', async () => {
  const stub = stubClient({
    tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    callToolResult: { content: [{ type: 'text', text: 'r' }] },
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    await tools[0]!.execute({ q: '关键词', limit: 10 });
    assert.equal(stub.calls.callTool.length, 1);
    assert.equal(stub.calls.callTool[0]!.name, 'search');
    assert.deepEqual(stub.calls.callTool[0]!.arguments, { q: '关键词', limit: 10 });
  } finally {
    stub.restore();
  }
});

test('execute：callTool 用原始 mcpTool.name（不受前缀影响）', async () => {
  const stub = stubClient({
    tools: [{ name: 'read', inputSchema: { type: 'object' } }],
    callToolResult: { content: [{ type: 'text', text: 'r' }] },
  });
  try {
    const { tools } = await loadMcpTools({ ...baseConfig, toolPrefix: 'fs' });
    assert.equal(tools[0]!.name, 'fs_read', '对外名带前缀');
    await tools[0]!.execute({});
    assert.equal(stub.calls.callTool[0]!.name, 'read', '但 callTool 用原始名 read');
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：返回 client 与 close 句柄', async () => {
  const stub = stubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
  try {
    const { client, close } = await loadMcpTools(baseConfig);
    assert.ok(client instanceof McpStdioClient, 'client 是 McpStdioClient 实例');
    assert.equal(typeof close, 'function');
    await close();
    assert.equal(stub.calls.close, 1, 'close 透传到 client.close');
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：connect 失败抛错（不吞）', async () => {
  const stub = stubClient({ connectThrows: new Error('spawn 失败') });
  try {
    await assert.rejects(
      loadMcpTools(baseConfig),
      /spawn 失败/,
      'connect 抛错应上抛',
    );
  } finally {
    stub.restore();
  }
});

test('loadMcpServers：多 server 工具合并并加前缀', async () => {
  const stub = stubClient({
    tools: [{ name: 'read', inputSchema: { type: 'object' } }],
  });
  try {
    const { tools } = await loadMcpServers({
      fs: { ...baseConfig },
      git: { ...baseConfig },
    });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['fs_read', 'git_read'], '每个 server 的工具加各自前缀');
  } finally {
    stub.restore();
  }
});

test('loadMcpServers：单个 server 失败不阻塞其他', async () => {
  // 第一个 server 用正常 stub，第二个让它 connect 抛错
  let connectCalls = 0;
  const proto = McpStdioClient.prototype as unknown as Record<string, unknown>;
  const origConnect = proto.connect;
  const origList = proto.listAllTools;
  const origCall = proto.callTool;
  const origClose = proto.close;
  proto.connect = async function () {
    connectCalls++;
    if (connectCalls === 1) throw new Error('第一个 server 挂了');
    return { protocolVersion: 'x', capabilities: {}, serverInfo: { name: 's', version: '1' } };
  };
  proto.listAllTools = async function () {
    return { tools: [{ name: 'ok', inputSchema: { type: 'object' } }] };
  };
  proto.callTool = async function () {
    return { content: [{ type: 'text' as const, text: '' }] };
  };
  proto.close = async function () {};
  try {
    const { tools } = await loadMcpServers({
      broken: { ...baseConfig },
      good: { ...baseConfig },
    });
    assert.equal(tools.length, 1, 'broken 失败被吞，good 的工具保留');
    assert.equal(tools[0]!.name, 'good_ok');
  } finally {
    proto.connect = origConnect;
    proto.listAllTools = origList;
    proto.callTool = origCall;
    proto.close = origClose;
  }
});

test('loadMcpServers：返回 clients 与 closeAll', async () => {
  const stub = stubClient({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
  try {
    const { clients, closeAll } = await loadMcpServers({
      a: { ...baseConfig },
      b: { ...baseConfig },
    });
    assert.equal(clients.length, 2, '两个 client');
    assert.equal(typeof closeAll, 'function');
    await closeAll();
    assert.equal(stub.calls.close, 2, 'closeAll 关闭所有 client');
  } finally {
    stub.restore();
  }
});

test('loadMcpServers：空 server 映射返回空工具', async () => {
  const stub = stubClient();
  try {
    const { tools, clients } = await loadMcpServers({});
    assert.deepEqual(tools, []);
    assert.deepEqual(clients, []);
  } finally {
    stub.restore();
  }
});

test('loadMcpServers：每个 server 的工具默认 requiresApproval=true', async () => {
  const stub = stubClient({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] });
  try {
    const { tools } = await loadMcpServers({ s1: { ...baseConfig } });
    assert.equal(tools[0]!.requiresApproval, true);
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：空工具列表返回空数组（不抛错）', async () => {
  const stub = stubClient({ tools: [] });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    assert.deepEqual(tools, []);
  } finally {
    stub.restore();
  }
});

test('loadMcpTools：多个工具均正确映射', async () => {
  const stub = stubClient({
    tools: [
      { name: 'a', description: '工具A', inputSchema: { type: 'object' } },
      { name: 'b', description: '工具B', inputSchema: { type: 'object', properties: { x: {} } } },
      { name: 'c', inputSchema: { type: 'object' } },
    ],
  });
  try {
    const { tools } = await loadMcpTools(baseConfig);
    assert.equal(tools.length, 3);
    assert.deepEqual(
      tools.map((t) => t.name),
      ['a', 'b', 'c'],
    );
    assert.equal(tools[2]!.description, 'MCP 工具：c', 'c 缺 description 走兜底');
  } finally {
    stub.restore();
  }
});
