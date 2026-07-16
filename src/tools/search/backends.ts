/**
 * 搜索后端抽象：统一接口 + 三个实现（DDG/Wikipedia、Tavily、Firecrawl）。
 *
 * 统一接口让 web_search 工具不关心具体后端——选择器（selector.ts）根据环境变量
 * 和可用 key 自动选最优后端。每个后端把 API 响应解析为统一的 SearchResult。
 *
 * 设计原则：
 * - 每个后端独立，失败不影响其他（可降级）
 * - 零依赖：仅用 fetch
 * - 超时保护：每个请求独立 AbortSignal.timeout
 * - 返回结构化结果，由 web_search.ts 统一截断/格式化
 */

const TIMEOUT_MS = 15000;
const MAX_RESULTS = 3; // API 后端默认取 3 条结果

/** 单条搜索结果 */
export interface SearchResult {
  /** 结果标题 */
  title: string;
  /** 正文内容（已由后端提取，web_search 再统一截断） */
  content: string;
  /** 来源 URL（可选） */
  url?: string;
}

/** 搜索后端接口：任何实现都把 query 变成结果列表 */
export interface SearchBackend {
  /** 后端名称（展示用，如 "Tavily"） */
  name: string;
  /** 执行搜索，返回结果列表（空数组=无结果，抛错=网络/API 故障） */
  search(query: string): Promise<SearchResult[]>;
}

// —————————— DuckDuckGo + Wikipedia 后端（零 key） ——————————

interface DDGResponse {
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Heading?: string;
  Answer?: string;
  Definition?: string;
  RelatedTopics?: Array<{ Text?: string }>;
}

/** DuckDuckGo + Wikipedia 兜底（现有逻辑，搬移为后端实现） */
export const ddgBackend: SearchBackend = {
  name: 'DuckDuckGo',
  async search(query: string): Promise<SearchResult[]> {
    // 1. 先查 DDG 即时答案
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const ddgResp = await fetch(ddgUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (ddgResp.ok) {
      const data = (await ddgResp.json()) as DDGResponse;
      const primary = data.AbstractText || data.Answer || data.Definition;
      if (primary && primary.trim()) {
        return [
          {
            title: data.Heading || query,
            content: primary,
            url: data.AbstractURL,
          },
        ];
      }
      // RelatedTopics 兜底
      if (data.RelatedTopics?.length) {
        const topics = data.RelatedTopics.slice(0, MAX_RESULTS)
          .map((t) => t.Text)
          .filter((t): t is string => !!t);
        if (topics.length) {
          return topics.map((t, i) => ({ title: `${query} 相关 #${i + 1}`, content: t }));
        }
      }
    }

    // 2. DDG 无答案 → Wikipedia opensearch 找标题 → 取摘要
    const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&format=json&origin=*`;
    const wikiResp = await fetch(wikiSearchUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (wikiResp.ok) {
      const wikiData = (await wikiResp.json()) as [string, string[], string[], string[]];
      const title = wikiData[1]?.[0];
      if (title) {
        const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
        const sumResp = await fetch(summaryUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (sumResp.ok) {
          const sumData = (await sumResp.json()) as { extract?: string; title?: string };
          if (sumData.extract?.trim()) {
            return [{ title: sumData.title ?? title, content: sumData.extract }];
          }
        }
      }
    }

    return []; // 两者都无结果
  },
};

// —————————— Tavily 后端 ——————————

interface TavilyResponse {
  results?: Array<{ title?: string; content?: string; url?: string }>;
  answer?: string;
}

/** Tavily 搜索后端（需 TAVILY_API_KEY） */
export function createTavilyBackend(apiKey: string): SearchBackend {
  return {
    name: 'Tavily',
    async search(query: string): Promise<SearchResult[]> {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: MAX_RESULTS,
          include_answer: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Tavily API ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = (await resp.json()) as TavilyResponse;
      const results: SearchResult[] = [];

      // Tavily 有时返回顶层 answer（AI 摘要），优先放第一条
      if (data.answer?.trim()) {
        results.push({ title: `${query}（AI 摘要）`, content: data.answer });
      }
      // 逐条结果
      if (data.results) {
        for (const r of data.results.slice(0, MAX_RESULTS)) {
          if (r.content?.trim()) {
            results.push({
              title: r.title || query,
              content: r.content,
              url: r.url,
            });
          }
        }
      }
      return results;
    },
  };
}

// —————————— Firecrawl 后端 ——————————

interface FirecrawlResponse {
  success?: boolean;
  data?: Array<{
    title?: string;
    markdown?: string;
    content?: string;
    url?: string;
    metadata?: { title?: string };
  }>;
}

/** Firecrawl 搜索后端（需 FIRECRAWL_API_KEY） */
export function createFirecrawlBackend(apiKey: string): SearchBackend {
  return {
    name: 'Firecrawl',
    async search(query: string): Promise<SearchResult[]> {
      const resp = await fetch('https://api.firecrawl.dev/v2/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          limit: MAX_RESULTS,
          scrapeOptions: { formats: ['markdown'] },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Firecrawl API ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = (await resp.json()) as FirecrawlResponse;
      const results: SearchResult[] = [];
      if (data.data) {
        for (const item of data.data.slice(0, MAX_RESULTS)) {
          const content = item.markdown || item.content;
          if (content?.trim()) {
            results.push({
              title: item.title || item.metadata?.title || query,
              content,
              url: item.url,
            });
          }
        }
      }
      return results;
    },
  };
}
