/**
 * 工具：web_search —— 网络搜索（多后端可配置）。
 *
 * 委托给搜索后端抽象（search/backends.ts + search/selector.ts）：
 *   LOOP_SEARCH_BACKEND=auto（默认）→ 有 Tavily key 用 Tavily → 有 Firecrawl key 用 Firecrawl → DDG 兜底
 *   LOOP_SEARCH_BACKEND=tavily / firecrawl / ddg → 显式指定
 *
 * 三种后端：
 *   1. Tavily（AI 搜索，需 TAVILY_API_KEY）—— 质量最高，专为 Agent/RAG 设计
 *   2. Firecrawl（搜索+抓取，需 FIRECRAWL_API_KEY）—— 返回完整 markdown 内容
 *   3. DuckDuckGo + Wikipedia（零 key）—— 兜底，覆盖较差
 *
 * 不配置任何 key 时，行为与原版完全一致（DDG）。标记 requiresApproval：真实网络请求。
 */

import type { ToolDef } from '../types.ts';
import { selectBackend } from './search/selector.ts';
import { ddgBackend, type SearchResult } from './search/backends.ts';

const MAX_CHARS = 1500; // 截断，防上下文爆炸

/** 把 SearchResult 列表渲染为喂给 LLM 的字符串 */
function renderResults(query: string, backendName: string, results: SearchResult[]): string {
  if (results.length === 0) return '';
  const parts = results.map((r, i) => {
    const title = r.title ? `【${r.title}】` : '';
    const url = r.url ? `（来源：${r.url}）` : '';
    return `${i + 1}. ${title}${r.content}${url}`;
  });
  return `[${backendName}] 搜索「${query}」结果：\n${parts.join('\n\n')}`;
}

export const webSearchTool: ToolDef<{ query: string }> = {
  name: 'web_search',
  description:
    '网络搜索：查询一个事实性问题，返回搜索结果。' +
    '后端可在 .env 中配置（LOOP_SEARCH_BACKEND=auto/tavily/firecrawl/ddg）。' +
    '适合查「X 是什么」「X 的定义」「X 的最新情况」等事实类问题。' +
    '注意：需要审批（真实网络请求）。返回失败时请换关键词重试或改用其它方式。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索查询词（中英文均可，英文效果通常更好）' },
    },
    required: ['query'],
  },
  requiresApproval: true,
  async execute({ query }) {
    const backend = selectBackend();
    try {
      const results = await backend.search(query);
      if (results.length > 0) {
        const text = renderResults(query, backend.name, results);
        return { ok: true, output: truncate(text) };
      }
      // 无结果：区分网络故障 vs 真无结果
      return {
        ok: false,
        output: `未找到「${query}」的相关结果（${backend.name}）。请尝试换关键词。`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      // M7: 429 限流——短暂退避后重试一次，仍失败则降级到 DDG
      if (/429|rate.?limit|too many requests/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 2000)); // 2s 退避
        try {
          const retryResults = await backend.search(query);
          if (retryResults.length > 0) {
            return { ok: true, output: truncate(renderResults(query, backend.name, retryResults)) };
          }
        } catch {
          // 重试仍失败，降级到 DDG
        }
        // 降级：用 DDG 兜底（若有 DDG 后端可用）
        if (backend.name !== 'DuckDuckGo') {
          try {
            const ddgResults = await ddgBackend.search(query);
            if (ddgResults.length > 0) {
              return { ok: true, output: truncate(renderResults(query, 'DuckDuckGo(降级)', ddgResults)) };
            }
          } catch {
            // DDG 也失败
          }
        }
        return { ok: false, output: `搜索限流（${backend.name} 429），退避+DDG降级均失败。请稍后重试或用已有知识回答。` };
      }

      const hint = /timeout|connect|ECONN|fetch failed|abort/i.test(msg)
        ? '（可能网络不可达——可尝试用已有知识回答）'
        : '';
      return { ok: false, output: `搜索失败（${backend.name}）：${msg}${hint}` };
    }
  },
};

function truncate(s: string): string {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}…（已截断）` : s;
}
