/**
 * 工具：recall —— 检索跨会话的持久化记忆。
 *
 * 让 agent 能主动检索之前存入 MemoryStore 的事实，避免重复搜索。
 * 配合 memory_store 工具（写入记忆）使用。
 *
 * 不需审批（纯本地文件读取，无网络风险）。
 */

import type { ToolDef } from '../types.ts';
import { MemoryStore } from '../memory-store.ts';

// 单例 MemoryStore（与 memory_store 工具共享）
let sharedStore: MemoryStore | null = null;

/** 获取/创建共享 MemoryStore 单例 */
export function getMemoryStore(): MemoryStore {
  if (!sharedStore) {
    sharedStore = new MemoryStore();
  }
  return sharedStore;
}

/** 初始化共享 store（加载已有数据）——入口点调用一次 */
export async function initMemoryStore(): Promise<MemoryStore> {
  const store = getMemoryStore();
  await store.load();
  return store;
}

export const recallTool: ToolDef<{ query: string; k?: number }> = {
  name: 'recall',
  description:
    '检索之前保存的记忆/事实。用关键词搜索，返回最相关的若干条。' +
    '适合在搜索前先查是否已有相关信息，避免重复工作。' +
    '无需审批（纯本地检索）。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（中英文均可）' },
      k: { type: 'integer', description: '返回最多几条（默认3）' },
    },
    required: ['query'],
  },
  requiresApproval: false,
  async execute({ query, k }) {
    const store = getMemoryStore();
    const maxK = k ?? 3;
    const results = store.search(query, maxK);
    if (results.length === 0) {
      return { ok: false, output: `记忆中未找到与「${query}」相关的内容。` };
    }
    const parts = results.map((r, i) => {
      const score = (r.score * 100).toFixed(0);
      return `${i + 1}. [相关度${score}%] ${r.record.text}`;
    });
    return { ok: true, output: `找到 ${results.length} 条相关记忆：\n${parts.join('\n\n')}` };
  },
};
