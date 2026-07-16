/**
 * 共享运行时准备：ralph-loop 和 long-task 的公共初始化逻辑。
 *
 * M2 修复：两引擎原本各自重复 ~15 行完全相同的初始化代码（loadEnv → createLLM →
 * loadAllTools → registerCleanup → initMemoryStore → makeSubAgentTools → loadBudgetConfig）。
 * 本模块提取为单次调用，避免维护时一处修、另一处漏。
 */

import { loadEnv } from './env.ts';
import { createLLM } from './llm.ts';
import { makeSubAgentTools, type SubAgentDeps } from './subagent.ts';
import { loadAllTools, registerCleanup } from './tools/load-all.ts';
import { initMemoryStore } from './tools/recall.ts';
import { loadBudgetConfig, BudgetGuard, type BudgetConfig } from './budget.ts';
import type { AnyToolDef, ApprovalDecision, ApprovalRequest, LLMClient, ToolDef } from './types.ts';

/** 准备好的运行时——两个引擎共用 */
export interface PreparedRuntime {
  llm: LLMClient;
  tools: AnyToolDef[];
  onApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  budgetConfig: BudgetConfig | null;
  budgetGuard: BudgetGuard | null;
}

/**
 * 准备运行时：加载环境、LLM、工具（含 MCP）、记忆、预算。
 * ralph-loop 和 long-task 调用一次，得到全部依赖。
 */
export async function prepareRuntime(system: string): Promise<PreparedRuntime> {
  loadEnv();
  const llm = createLLM();

  // 加载工具（内置 + MCP + 记忆初始化）
  const { tools: loadedTools, closeAll } = await loadAllTools();
  registerCleanup(closeAll);
  await initMemoryStore();

  const onApproval = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ approved: true });
  const deps: SubAgentDeps = { llm, tools: loadedTools as ToolDef[], system, onApproval };
  const tools: AnyToolDef[] = [...loadedTools, ...makeSubAgentTools(deps)];

  // 预算
  const budgetConfig = loadBudgetConfig();
  const budgetGuard = budgetConfig ? new BudgetGuard(budgetConfig) : null;

  return { llm, tools, onApproval, budgetConfig, budgetGuard };
}
