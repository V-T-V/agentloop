/**
 * MCP 配置注册表：从 JSON 配置文件加载多 server 配置。
 *
 * 配置文件格式（mcp-servers.json）：
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
 *       },
 *       "git": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-git", "/repo"]
 *       }
 *     }
 *   }
 *
 * 也支持 Claude Desktop 的 claude_desktop_config.json 格式（同结构）。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { env } from '../env.ts';
import { loadMcpServers } from './adapter.ts';
import type { McpToolsConfig } from './adapter.ts';

/** 配置文件中的 server 条目 */
interface ServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  requiresApproval?: boolean;
}

/** 配置文件根结构（兼容 Claude Desktop 格式） */
interface McpConfigFile {
  mcpServers: Record<string, ServerEntry>;
}

/** 默认配置文件查找路径 */
const CONFIG_PATHS = ['mcp-servers.json', '.agentloop/mcp-servers.json', 'claude_desktop_config.json'];

/**
 * 查找并加载 MCP 配置文件。
 * 查找顺序：
 *   1. LOOP_MCP_CONFIG 环境变量指定的路径
 *   2. 当前目录 mcp-servers.json
 *   3. .agentloop/mcp-servers.json
 *   4. claude_desktop_config.json（Claude Desktop 兼容）
 * 未找到返回 null。
 */
export async function findMcpConfig(): Promise<string | null> {
  const envPath = env('LOOP_MCP_CONFIG', '');
  const candidates = [envPath, ...CONFIG_PATHS].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(resolve(p))) return p;
  }
  return null;
}

/** 读取并解析 MCP 配置文件 */
export async function loadMcpConfig(path?: string): Promise<Record<string, McpToolsConfig> | null> {
  const filePath = path ?? (await findMcpConfig());
  if (!filePath) return null;

  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as McpConfigFile;
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') return null;

    // 转换为 McpToolsConfig（每个 server 的工具名以 server 名为前缀）
    const result: Record<string, McpToolsConfig> = {};
    for (const [name, entry] of Object.entries(parsed.mcpServers)) {
      result[name] = {
        command: entry.command,
        args: entry.args,
        env: entry.env,
        cwd: entry.cwd,
        requiresApproval: entry.requiresApproval ?? true,
        toolPrefix: name,
      };
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * 一站式：从配置文件加载所有 MCP server 的工具。
 * 若无配置文件则返回空列表（不报错，MCP 是可选的）。
 */
export async function loadMcpFromConfig(): Promise<{
  tools: import('../types.ts').AnyToolDef[];
  closeAll: () => Promise<void>;
}> {
  const config = await loadMcpConfig();
  if (!config || Object.keys(config).length === 0) {
    return { tools: [], closeAll: async () => {} };
  }
  return loadMcpServers(config);
}
