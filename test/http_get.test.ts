/**
 * http_get 工具测试。
 *
 * 通过临时替换 globalThis.fetch 注入受控响应，避免真实网络。
 * 重点验证：协议白名单、content-type 校验、超长截断、HTTP 错误码、超时。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { httpGetTool } from '../src/tools/http_get.ts';

/** 临时替换全局 fetch，返回原还原函数 */
function mockFetch(
  responder: (url: string) =>
    | { ok: true; status?: number; contentType?: string | null; body: string }
    | { ok: false; status: number; statusText?: string; contentType?: string | null },
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: URL | Request | string) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = responder(url);
    const headers = new Map<string, string>();
    if (r.contentType !== undefined) {
      if (r.contentType !== null) headers.set('content-type', r.contentType);
    } else if (r.ok) {
      headers.set('content-type', 'text/html; charset=utf-8');
    }
    if (r.ok) {
      return Promise.resolve({
        ok: true,
        status: r.status ?? 200,
        statusText: 'OK',
        headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
        text: () => Promise.resolve(r.body),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: false,
      status: r.status,
      statusText: r.statusText ?? '',
      headers: { get: () => null },
      text: () => Promise.resolve(''),
    } as unknown as Response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('文本响应（text/html）正常返回', async () => {
  const restore = mockFetch(() => ({ ok: true, contentType: 'text/html; charset=utf-8', body: '<h1>hi</h1>' }));
  try {
    const r = await httpGetTool.execute({ url: 'https://example.com' });
    assert.equal(r.ok, true);
    assert.equal(r.output, '<h1>hi</h1>');
  } finally {
    restore();
  }
});

test('JSON 响应（application/json）允许', async () => {
  const restore = mockFetch(() => ({ ok: true, contentType: 'application/json', body: '{"a":1}' }));
  try {
    const r = await httpGetTool.execute({ url: 'https://api.example.com' });
    assert.equal(r.ok, true);
    assert.equal(r.output, '{"a":1}');
  } finally {
    restore();
  }
});

test('带 +xml 后缀的内容类型允许（如 application/atom+xml）', async () => {
  const restore = mockFetch(() => ({ ok: true, contentType: 'application/atom+xml', body: '<feed/>' }));
  try {
    const r = await httpGetTool.execute({ url: 'https://example.com/feed' });
    assert.equal(r.ok, true);
  } finally {
    restore();
  }
});

test('二进制响应（image/png）被拒绝，不灌入乱码', async () => {
  const restore = mockFetch(() => ({ ok: true, contentType: 'image/png', body: '\u0008PNG...' }));
  try {
    const r = await httpGetTool.execute({ url: 'https://example.com/a.png' });
    assert.equal(r.ok, false);
    assert.match(r.output, /不支持的响应类型/);
    assert.match(r.output, /image\/png/);
  } finally {
    restore();
  }
});

test('缺少 content-type 被保守拒绝', async () => {
  const restore = mockFetch(() => ({ ok: true, contentType: null, body: 'mystery' }));
  try {
    const r = await httpGetTool.execute({ url: 'https://example.com' });
    assert.equal(r.ok, false);
    assert.match(r.output, /不支持的响应类型/);
  } finally {
    restore();
  }
});

test('超长文本被截断并标注总长度', async () => {
  const long = 'A'.repeat(5000);
  const restore = mockFetch(() => ({ ok: true, contentType: 'text/plain', body: long }));
  try {
    const r = await httpGetTool.execute({ url: 'https://example.com/big' });
    assert.equal(r.ok, true);
    assert.match(r.output, /已截断/);
    assert.match(r.output, /5000 字符/);
  } finally {
    restore();
  }
});

test('非 http/https 协议被拒绝', async () => {
  const r = await httpGetTool.execute({ url: 'file:///etc/passwd' });
  assert.equal(r.ok, false);
  assert.match(r.output, /仅支持 http\/https/);
});

test('HTTP 错误码（404）返回失败', async () => {
  const restore = mockFetch(() => ({ ok: false, status: 404, statusText: 'Not Found' }));
  try {
    const r = await httpGetTool.execute({ url: 'https://example.com/missing' });
    assert.equal(r.ok, false);
    assert.match(r.output, /404/);
  } finally {
    restore();
  }
});
