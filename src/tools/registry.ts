/**
 * 工具注册表：defineTool 辅助函数 + 内置工具集合。
 *
 * 用 defineTool 可以在定义具体工具时获得参数类型推断；
 * builtinTools 集中登记所有内置工具，供 loop.ts 与 CLI 使用。
 */

import type { AnyToolDef, ToolDef } from '../types.ts';
import { datetimeTool } from './datetime.ts';
import { calculatorTool } from './calculator.ts';
import { iterateTool } from './iterate.ts';
import { httpGetTool } from './http_get.ts';
import { webSearchTool } from './web_search.ts';
import { recallTool } from './recall.ts';
import { memoryStoreTool } from './memory_store.ts';

/**
 * 定义一个工具，带类型推断。
 * 仅是把传入对象原样返回并约束为 ToolDef，不增加运行时开销。
 */
export function defineTool<TArgs extends Record<string, unknown>>(
  tool: ToolDef<TArgs>,
): ToolDef<TArgs> {
  return tool;
}

/**
 * 项目内置的全部工具（顺序即 /tools 展示顺序）。
 * 各工具有自己的 TArgs，统一擦除为 AnyToolDef 存入数组；
 * 执行期由 loop.ts 传入按 schema 解析后的参数对象。
 */
export const builtinTools: AnyToolDef[] = [
  datetimeTool as AnyToolDef,
  calculatorTool as AnyToolDef,
  iterateTool as AnyToolDef,
  webSearchTool as AnyToolDef,
  httpGetTool as AnyToolDef,
  recallTool as AnyToolDef,
  memoryStoreTool as AnyToolDef,
];

/** 按名称查找工具 */
export function findTool(name: string): AnyToolDef | undefined {
  return builtinTools.find((t) => t.name === name);
}
