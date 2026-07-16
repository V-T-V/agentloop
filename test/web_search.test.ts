/**
 * web_search.ts 网络搜索工具的测试。
 *
 * 全部用 mock fetch（不真实联网），保证测试快速稳定。
 * 重点：requiresApproval 标记、降级链路（DDG→Wikipedia）、错误处理。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { webSearchTool } from '../src/tools/web_search.ts';

// 保存原始 fetch，测试后恢复
const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => { status: number; body: unknown }): typeof fetch {
  return ((url: string) => {
    const { status, body } = handler(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as unknown as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('标记为高风险（requiresApproval）', () => {
  assert.equal(webSearchTool.requiresApproval, true);
});

test('参数 schema：query 必填且为 string', () => {
  assert.ok(webSearchTool.parameters.required?.includes('query'));
  assert.equal(webSearchTool.parameters.properties['query']?.type, 'string');
});

test('DDG 有即时答案时直接返回', async () => {
  globalThis.fetch = mockFetch((url) => {
    if (url.includes('duckduckgo')) {
      return { status: 200, body: { AbstractText: '特斯拉是发明家。', AbstractSource: 'Wikipedia' } };
    }
    return { status: 404, body: {} };
  });
  const r = await webSearchTool.execute({ query: 'tesla' });
  assert.equal(r.ok, true);
  assert.match(r.output, /特斯拉是发明家/);
  assert.match(r.output, /DuckDuckGo/);
});

test('DDG 无答案时降级到 Wikipedia 摘要', async () => {
  let call = 0;
  globalThis.fetch = (() => {
    call++;
    const responses = [
      { status: 200, body: { AbstractText: '' } }, // DDG 空
      { status: 200, body: ['q', ['Nikola Tesla'], [''], ['']] }, // opensearch
      { status: 200, body: { extract: '塞尔维亚裔美国发明家。', title: 'Nikola Tesla' } }, // summary
    ];
    const i = Math.min(call - 1, 2);
    const r = responses[i]!;
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
  }) as unknown as typeof fetch;
  const r = await webSearchTool.execute({ query: 'nikola tesla' });
  assert.equal(r.ok, true);
  assert.match(r.output, /塞尔维亚裔美国发明家/);
  assert.match(r.output, /Nikola Tesla/);
});

test('DDG 和 Wikipedia 都无结果时返回明确失败', async () => {
  globalThis.fetch = mockFetch(() => ({ status: 200, body: { AbstractText: '' } }));
  // DDG 空 + opensearch 也返回空
  let n = 0;
  globalThis.fetch = (() => {
    n++;
    if (n === 1) return Promise.resolve(new Response('{"AbstractText":""}', { status: 200 }));
    return Promise.resolve(new Response('["q",[],[],[]]', { status: 200 })); // 无标题
  }) as unknown as typeof fetch;
  const r = await webSearchTool.execute({ query: '不存在的奇怪词xyz' });
  assert.equal(r.ok, false);
  assert.match(r.output, /未找到/);
});

test('网络超时/失败时返回明确错误（不抛出）', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('fetch failed: ECONNREFUSED'))) as unknown as typeof fetch;
  const r = await webSearchTool.execute({ query: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.output, /搜索失败/);
  assert.match(r.output, /网络不可达|换关键词|fetch failed/);
});

test('DDG 用 RelatedTopics 兜底（无 AbstractText 但有相关主题）', async () => {
  globalThis.fetch = mockFetch((url) => {
    if (url.includes('duckduckgo')) {
      return {
        status: 200,
        body: { AbstractText: '', RelatedTopics: [{ Text: '特斯拉线圈是一种谐振变压器' }, { Text: '相关链接' }] },
      };
    }
    return { status: 404, body: {} };
  });
  const r = await webSearchTool.execute({ query: 'tesla coil' });
  assert.equal(r.ok, true);
  assert.match(r.output, /特斯拉线圈/);
});

test('结果超长被截断', async () => {
  const long = 'A'.repeat(3000);
  globalThis.fetch = mockFetch(() => ({ status: 200, body: { AbstractText: long } }));
  const r = await webSearchTool.execute({ query: 'x' });
  assert.equal(r.ok, true);
  assert.ok(r.output.length < 2000);
  assert.match(r.output, /已截断/);
});
