/**
 * 统一工具加载器：合并内置工具 + MCP 外部工具。
 *
 * 三个入口点（cli.ts / run-task.ts / long-task.ts）都通过本模块加载工具，
 * 确保 MCP 工具（若配置了 mcp-servers.json）自动加入可用工具列表。
 *
 * 流程：
 *   1. 取 builtinTools（datetime/calculator/web_search/http_get/iterate）
 *   2. 调 loadMcpFromConfig()（若 LOOP_MCP_CONFIG 指向配置文件或有默认配置）
 *   3. 合并返回；MCP 子进程的 closeAll 在进程退出时调用
 *
 * 设计为「失败不阻塞」：MCP 加载失败只 warn，不影响内置工具。
 */

import { builtinTools } from './registry.ts';
import { loadMcpFromConfig } from '../mcp/registry.ts';
import type { AnyToolDef } from '../types.ts';

export interface LoadedTools {
  /** 合并后的工具列表（内置 + MCP） */
  tools: AnyToolDef[];
  /** 关闭所有 MCP 子进程（进程退出时调用；无 MCP 则空操作） */
  closeAll: () => Promise<void>;
  /** 实际加载的 MCP 工具数量（诊断用） */
  mcpToolCount: number;
}

/**
 * 加载全部工具：内置 + MCP（若配置了）。
 *
 * MCP 加载是异步的（需 spawn 子进程 + 握手），故本函数为 async。
 * MCP 加载失败不抛错（仅 warn），返回内置工具。
 */
export async function loadAllTools(): Promise<LoadedTools> {
  const tools: AnyToolDef[] = [...builtinTools];

  try {
    const mcp = await loadMcpFromConfig();
    if (mcp.tools.length > 0) {
      tools.push(...mcp.tools);
      console.log(`[loop] 已加载 ${mcp.tools.length} 个 MCP 工具`);
    }
    return { tools, closeAll: mcp.closeAll, mcpToolCount: mcp.tools.length };
  } catch (e) {
    // MCP 加载失败不阻塞——内置工具仍可用
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[loop] MCP 工具加载失败（已忽略，仅用内置工具）：${msg}`);
    return { tools, closeAll: async () => {}, mcpToolCount: 0 };
  }
}

/**
 * 注册进程退出时的 MCP 清理。
 * 在入口点调用一次即可。
 */
export function registerCleanup(closeAll: () => Promise<void>): void {
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await closeAll();
    } catch {
      // 退出时忽略错误
    }
  };
  process.on('exit', () => void cleanup());
  process.on('SIGINT', () => {
    void cleanup().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void cleanup().then(() => process.exit(0));
  });
}
