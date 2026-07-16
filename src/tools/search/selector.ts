/**
 * 搜索后端选择器：根据环境变量和可用 API key 自动选最优后端。
 *
 * 选择逻辑（优先级从高到低）：
 *   LOOP_SEARCH_BACKEND 显式指定 → 验证 key 可用 → 用指定后端
 *   auto（默认）→ 有 Tavily key 用 Tavily → 有 Firecrawl key 用 Firecrawl → DDG 兜底
 *
 * 设计为「每次调用都重新读取环境变量」，而非启动时固定——
 * 这样运行中修改 .env / 注入 key 后无需重启进程。
 */

import { env } from '../../env.ts';
import {
  createFirecrawlBackend,
  createTavilyBackend,
  ddgBackend,
  type SearchBackend,
} from './backends.ts';

/**
 * 选择当前搜索后端。每次调用都重新读取环境变量（支持运行时热切换）。
 *
 * 显式指定优先：LOOP_SEARCH_BACKEND=tavily → 必须有 TAVILY_API_KEY，否则降级。
 * auto 模式：按 key 可用性自动选（Tavily > Firecrawl > DDG）。
 */
export function selectBackend(): SearchBackend {
  const preferred = env('LOOP_SEARCH_BACKEND', 'auto').toLowerCase();
  const tavilyKey = env('TAVILY_API_KEY', '');
  const firecrawlKey = env('FIRECRAWL_API_KEY', '');

  // 显式指定
  if (preferred === 'tavily' && tavilyKey) return createTavilyBackend(tavilyKey);
  if (preferred === 'firecrawl' && firecrawlKey) return createFirecrawlBackend(firecrawlKey);
  if (preferred === 'ddg') return ddgBackend;

  // auto 模式：按优先级自动选（有 key 的最优后端）
  if (tavilyKey) return createTavilyBackend(tavilyKey);
  if (firecrawlKey) return createFirecrawlBackend(firecrawlKey);

  // 无任何 key → DDG 兜底（零 key，但覆盖差）
  return ddgBackend;
}

/** 当前生效的后端名称（诊断/展示用） */
export function currentBackendName(): string {
  return selectBackend().name;
}

/**
 * 显式指定但 key 缺失时的降级说明（诊断用）。
 * 返回 null 表示配置正常；返回字符串表示有降级发生。
 */
export function backendStatus(): { name: string; configured: boolean; note?: string } {
  const preferred = env('LOOP_SEARCH_BACKEND', 'auto').toLowerCase();
  const tavilyKey = env('TAVILY_API_KEY', '');
  const firecrawlKey = env('FIRECRAWL_API_KEY', '');

  if (preferred === 'tavily' && !tavilyKey) {
    return { name: ddgBackend.name, configured: false, note: '指定了 tavily 但无 TAVILY_API_KEY，降级到 DDG' };
  }
  if (preferred === 'firecrawl' && !firecrawlKey) {
    return { name: ddgBackend.name, configured: false, note: '指定了 firecrawl 但无 FIRECRAWL_API_KEY，降级到 DDG' };
  }

  const backend = selectBackend();
  const isReal = backend.name !== 'DuckDuckGo';
  return {
    name: backend.name,
    configured: isReal,
    note: isReal ? undefined : '无 API key，使用 DDG（覆盖较差）',
  };
}
