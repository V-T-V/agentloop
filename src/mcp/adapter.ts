/**
 * MCP 适配器：把 MCP 服务端的工具映射为本项目 ToolDef[]。
 *
 * MCP 工具 → ToolDef 映射：
 * - name → name（保持不变）
 * - description → description
 * - inputSchema → parameters（已是 JSON Schema object，直接用）
 * - callTool → execute（调用 client.callTool，拼接 content 为字符串）
 *
 * 安全：MCP 工具默认标记 requiresApproval=true（外部工具，调用前需人确认）。
 * 可通过配置覆盖。
 */

import { McpStdioClient, type McpServerConfig } from './client.ts';
import type { ToolCallResultContent, ToolDefinition } from './protocol.ts';
import type { AnyToolDef, ToolParameters, ToolResult } from '../types.ts';

/** MCP 工具加载配置 */
export interface McpToolsConfig extends McpServerConfig {
  /** 加载的工具名前缀（避免多 server 工具名冲突）。默认 ''（不加前缀） */
  toolPrefix?: string;
  /** 是否要求审批（外部工具默认 true）。设 false 则自动放行 */
  requiresApproval?: boolean;
}

/** 把 MCP content 数组拼接为字符串结果 */
function renderToolContent(contents: ToolCallResultContent[]): string {
  return contents
    .map((c) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'image') return `[图片 ${c.mimeType ?? ''}]`;
      if (c.type === 'resource') return `[资源 ${c.text ?? ''}]`;
      return '';
    })
    .join('\n');
}

/**
 * 从一个 MCP 服务端加载工具，返回 ToolDef[]。
 *
 * 用法：
 *   const tools = await loadMcpTools({ command: 'npx', args: ['-y', '@mcp/server-fs', '/tmp'] });
 *   // tools 可直接传给 runLoop 的 tools 参数
 */
export async function loadMcpTools(config: McpToolsConfig): Promise<{
  tools: AnyToolDef[];
  client: McpStdioClient;
  close: () => Promise<void>;
}> {
  const client = new McpStdioClient(config);
  await client.connect();

  // 用 listAllTools 翻页拉取全部工具（分页 server 不会丢工具）；无分页时等价于 listTools。
  const { tools: mcpTools } = await client.listAllTools();
  const prefix = config.toolPrefix ?? '';
  const requiresApproval = config.requiresApproval ?? true;

  const tools: AnyToolDef[] = mcpTools.map((mcpTool: ToolDefinition) => {
    const name = prefix ? `${prefix}_${mcpTool.name}` : mcpTool.name;
    // MCP inputSchema 直接作为 ToolParameters（已是 JSON Schema object）
    const parameters: ToolParameters = (mcpTool.inputSchema as ToolParameters) ?? {
      type: 'object',
      properties: {},
    };
    return {
      name,
      description: mcpTool.description ?? `MCP 工具：${mcpTool.name}`,
      parameters,
      requiresApproval,
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: args,
          });
          const output = renderToolContent(result.content);
          return { ok: !result.isError, output };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, output: `MCP 工具「${mcpTool.name}」调用失败：${msg}` };
        }
      },
    };
  });

  return {
    tools,
    client,
    close: () => client.close(),
  };
}

/**
 * 批量加载多个 MCP 服务端的工具，合并返回。
 * 每个 server 的工具名加前缀（server 名），避免冲突。
 *
 * 用法：
 *   const { tools, closeAll } = await loadMcpServers({
 *     fs: { command: 'npx', args: ['-y', '@mcp/server-fs', '/tmp'] },
 *     git: { command: 'npx', args: ['-y', '@mcp/server-git', '/repo'] },
 *   });
 */
export async function loadMcpServers(
  servers: Record<string, McpToolsConfig>,
): Promise<{
  tools: AnyToolDef[];
  clients: McpStdioClient[];
  closeAll: () => Promise<void>;
}> {
  const allTools: AnyToolDef[] = [];
  const clients: McpStdioClient[] = [];

  for (const [name, config] of Object.entries(servers)) {
    try {
      const { tools, client, close } = await loadMcpTools({ ...config, toolPrefix: name });
      allTools.push(...tools);
      clients.push(client);
      void close; // closeAll 统一管理
    } catch (e) {
      // 单个 server 加载失败不阻塞其他
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`MCP server「${name}」加载失败：${msg}`);
    }
  }

  return {
    tools: allTools,
    clients,
    closeAll: async () => {
      await Promise.all(clients.map((c) => c.close()));
    },
  };
}
