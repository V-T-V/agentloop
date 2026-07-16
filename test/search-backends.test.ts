/**
 * 搜索后端 + 选择器的测试。
 *
 * 全部用 mock fetch（不真实联网），覆盖：
 * - DDG 后端：即时答案 / Wikipedia 降级 / 无结果
 * - Tavily 后端：结果解析 / answer 字段 / API 错误
 * - Firecrawl 后端：markdown 解析 / API 错误
 * - 选择器：auto / 显式指定 / key 缺失降级
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ddgBackend, createTavilyBackend, createFirecrawlBackend } from '../src/tools/search/backends.ts';
import { selectBackend, currentBackendName, backendStatus } from '../src/tools/search/selector.ts';

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const { status, body } = handler(u, init);
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  // 清理测试设置的环境变量
  delete process.env.LOOP_SEARCH_BACKEND;
  delete process.env.TAVILY_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});

// —————————— DDG 后端 ——————————

test('ddgBackend：DDG 有即时答案', async () => {
  globalThis.fetch = mockFetch((url) => {
    if (url.includes('duckduckgo')) {
      return { status: 200, body: { AbstractText: '量子计算原理。', Heading: 'Quantum Computing', AbstractURL: 'https://ddg.com/q' } };
    }
    return { status: 404, body: {} };
  });
  const results = await ddgBackend.search('quantum');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.content, '量子计算原理。');
  assert.equal(results[0]!.title, 'Quantum Computing');
  assert.equal(results[0]!.url, 'https://ddg.com/q');
});

test('ddgBackend：RelatedTopics 兜底', async () => {
  globalThis.fetch = mockFetch((url) => {
    if (url.includes('duckduckgo')) {
      return { status: 200, body: { AbstractText: '', RelatedTopics: [{ Text: '主题A' }, { Text: '主题B' }] } };
    }
    return { status: 404, body: {} };
  });
  const results = await ddgBackend.search('test');
  assert.ok(results.length >= 2);
  assert.equal(results[0]!.content, '主题A');
});

test('ddgBackend：Wikipedia 降级', async () => {
  let call = 0;
  globalThis.fetch = (() => {
    call++;
    if (call === 1) return Promise.resolve(new Response('{"AbstractText":""}', { status: 200 }));
    if (call === 2) return Promise.resolve(new Response('["q",["Tesla"],[],[]]', { status: 200 }));
    return Promise.resolve(new Response('{"extract":"发明家","title":"Tesla"}', { status: 200 }));
  }) as unknown as typeof fetch;
  const results = await ddgBackend.search('tesla');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.content, '发明家');
});

test('ddgBackend：全无结果返回空数组', async () => {
  globalThis.fetch = mockFetch(() => ({ status: 200, body: { AbstractText: '' } }));
  const results = await ddgBackend.search('nonexistent');
  assert.equal(results.length, 0);
});

test('ddgBackend：名称正确', () => {
  assert.equal(ddgBackend.name, 'DuckDuckGo');
});

// —————————— Tavily 后端 ——————————

test('Tavily：正常结果解析', async () => {
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          results: [
            { title: '结果1', content: '内容1', url: 'https://a.com' },
            { title: '结果2', content: '内容2', url: 'https://b.com' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  }) as unknown as typeof fetch;

  const backend = createTavilyBackend('tvly-test-key');
  const results = await backend.search('test query');
  assert.equal(results.length, 2);
  assert.equal(results[0]!.title, '结果1');
  assert.equal(results[0]!.content, '内容1');

  // 验证请求格式
  const body = JSON.parse(capturedInit!.body as string);
  assert.equal(body.query, 'test query');
  assert.equal(body.max_results, 3);
  // Authorization header
  const headers = capturedInit!.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tvly-test-key');
});

test('Tavily：顶层 answer 字段优先', async () => {
  globalThis.fetch = mockFetch(() => ({
    status: 200,
    body: {
      answer: 'AI 生成的摘要',
      results: [{ title: 'R1', content: 'C1' }],
    },
  }));
  const backend = createTavilyBackend('tvly-test');
  const results = await backend.search('q');
  assert.equal(results.length, 2);
  assert.equal(results[0]!.content, 'AI 生成的摘要');
});

test('Tavily：API 错误抛出', async () => {
  globalThis.fetch = mockFetch(() => ({ status: 401, body: 'unauthorized' }));
  const backend = createTavilyBackend('bad-key');
  await assert.rejects(backend.search('q'), /Tavily API 401/);
});

test('Tavily：空结果返回空数组', async () => {
  globalThis.fetch = mockFetch(() => ({ status: 200, body: { results: [] } }));
  const backend = createTavilyBackend('key');
  const results = await backend.search('q');
  assert.equal(results.length, 0);
});

test('Tavily：名称正确', () => {
  assert.equal(createTavilyBackend('k').name, 'Tavily');
});

// —————————— Firecrawl 后端 ——————————

test('Firecrawl：markdown 内容解析', async () => {
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { title: '页面1', markdown: '# 标题\n正文内容', url: 'https://a.com' },
            { metadata: { title: '页面2' }, content: '纯文本内容' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  }) as unknown as typeof fetch;

  const backend = createFirecrawlBackend('fc-test-key');
  const results = await backend.search('test');
  assert.equal(results.length, 2);
  assert.equal(results[0]!.content, '# 标题\n正文内容'); // markdown 优先
  assert.equal(results[1]!.title, '页面2'); // metadata.title 兜底
  assert.equal(results[1]!.content, '纯文本内容'); // content 兜底

  // 验证请求格式
  const body = JSON.parse(capturedInit!.body as string);
  assert.equal(body.query, 'test');
  assert.equal(body.limit, 3);
  assert.ok(body.scrapeOptions?.formats?.includes('markdown'));
  const headers = capturedInit!.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer fc-test-key');
});

test('Firecrawl：API 错误抛出', async () => {
  globalThis.fetch = mockFetch(() => ({ status: 500, body: 'server error' }));
  const backend = createFirecrawlBackend('fc-bad');
  await assert.rejects(backend.search('q'), /Firecrawl API 500/);
});

test('Firecrawl：空结果返回空数组', async () => {
  globalThis.fetch = mockFetch(() => ({ status: 200, body: { data: [] } }));
  const backend = createFirecrawlBackend('key');
  const results = await backend.search('q');
  assert.equal(results.length, 0);
});

test('Firecrawl：名称正确', () => {
  assert.equal(createFirecrawlBackend('k').name, 'Firecrawl');
});

// —————————— 选择器 ——————————

test('selector：auto + 无 key → DDG', () => {
  delete process.env.LOOP_SEARCH_BACKEND;
  delete process.env.TAVILY_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  assert.equal(selectBackend().name, 'DuckDuckGo');
});

test('selector：auto + Tavily key → Tavily', () => {
  process.env.LOOP_SEARCH_BACKEND = 'auto';
  process.env.TAVILY_API_KEY = 'tvly-test';
  delete process.env.FIRECRAWL_API_KEY;
  assert.equal(selectBackend().name, 'Tavily');
});

test('selector：auto + Firecrawl key（无 Tavily）→ Firecrawl', () => {
  process.env.LOOP_SEARCH_BACKEND = 'auto';
  delete process.env.TAVILY_API_KEY;
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  assert.equal(selectBackend().name, 'Firecrawl');
});

test('selector：auto + 两个 key → Tavily 优先', () => {
  process.env.LOOP_SEARCH_BACKEND = 'auto';
  process.env.TAVILY_API_KEY = 'tvly-test';
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  assert.equal(selectBackend().name, 'Tavily');
});

test('selector：显式 ddg → DDG（即使有 key）', () => {
  process.env.LOOP_SEARCH_BACKEND = 'ddg';
  process.env.TAVILY_API_KEY = 'tvly-test';
  assert.equal(selectBackend().name, 'DuckDuckGo');
});

test('selector：显式 tavily + 有 key → Tavily', () => {
  process.env.LOOP_SEARCH_BACKEND = 'tavily';
  process.env.TAVILY_API_KEY = 'tvly-test';
  assert.equal(selectBackend().name, 'Tavily');
});

test('selector：显式 firecrawl + 有 key → Firecrawl', () => {
  process.env.LOOP_SEARCH_BACKEND = 'firecrawl';
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  assert.equal(selectBackend().name, 'Firecrawl');
});

test('selector：显式 tavily 但无 key → 降级 DDG', () => {
  process.env.LOOP_SEARCH_BACKEND = 'tavily';
  delete process.env.TAVILY_API_KEY;
  assert.equal(selectBackend().name, 'DuckDuckGo');
});

test('currentBackendName：返回当前后端名', () => {
  delete process.env.TAVILY_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.LOOP_SEARCH_BACKEND;
  assert.equal(currentBackendName(), 'DuckDuckGo');
});

test('backendStatus：正常配置', () => {
  process.env.LOOP_SEARCH_BACKEND = 'auto';
  process.env.TAVILY_API_KEY = 'tvly-test';
  const status = backendStatus();
  assert.equal(status.name, 'Tavily');
  assert.equal(status.configured, true);
  assert.equal(status.note, undefined);
});

test('backendStatus：无 key 降级提示', () => {
  delete process.env.TAVILY_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.LOOP_SEARCH_BACKEND;
  const status = backendStatus();
  assert.equal(status.name, 'DuckDuckGo');
  assert.equal(status.configured, false);
  assert.ok(status.note);
});

test('backendStatus：指定 tavily 但无 key → 降级提示', () => {
  process.env.LOOP_SEARCH_BACKEND = 'tavily';
  delete process.env.TAVILY_API_KEY;
  const status = backendStatus();
  assert.equal(status.name, 'DuckDuckGo');
  assert.equal(status.configured, false);
  assert.match(status.note!, /tavily.*TAVILY_API_KEY/);
});
