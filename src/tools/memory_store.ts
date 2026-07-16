/**
 * 工具：memory_store —— 把重要事实存入持久化记忆。
 *
 * 让 agent 能主动保存调研结果/关键事实，供后续 recall 检索。
 * 存储到 MemoryStore（文件持久化），跨会话可用。
 *
 * 不需审批（纯本地文件写入）。
 */

import type { ToolDef } from '../types.ts';
import { getMemoryStore } from './recall.ts';

export const memoryStoreTool: ToolDef<{ text: string; tag?: string }> = {
  name: 'memory_store',
  description:
    '把一条重要事实或调研结果存入持久化记忆，供后续 recall 检索。' +
    '适合保存搜索到的关键信息，避免重复搜索。' +
    '无需审批（纯本地存储）。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要保存的内容（事实、结论、数据等）' },
      tag: { type: 'string', description: '分类标签（可选，便于后续筛选）' },
    },
    required: ['text'],
  },
  requiresApproval: false,
  async execute({ text, tag }) {
    const store = getMemoryStore();
    const metadata = tag ? { tag } : undefined;
    store.add(text, metadata);
    await store.persist();
    return { ok: true, output: `已保存到记忆（当前共 ${store.size} 条）${tag ? `，标签：${tag}` : ''}` };
  },
};
