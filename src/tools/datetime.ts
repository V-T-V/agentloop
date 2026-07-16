/**
 * 工具：datetime —— 获取当前日期与时间。
 *
 * 最简单的无参工具，用来演示「循环里一次最朴素的工具调用」。
 * 同时供 StubLLM / 真实 LLM 练习整个 Think → Act → Observe 回路。
 */

import type { ToolDef } from '../types.ts';

export const datetimeTool: ToolDef<Record<string, never>> = {
  name: 'datetime',
  description: '获取当前的日期与时间（ISO 字符串 + 本地可读格式）。',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute() {
    const now = new Date();
    return {
      ok: true,
      output: `ISO: ${now.toISOString()}\n本地: ${now.toLocaleString('zh-CN')}`,
    };
  },
};
