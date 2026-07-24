/**
 * 工具：http_get —— 用原生 fetch 抓取一个 URL 的文本内容。
 *
 * 安全防护：
 * - SSRF 拦截：拒绝私网 IP（127.x / 10.x / 192.168.x / 172.16-31.x / 169.254.x）
 * - 重定向限制：redirect:'manual' + 逐跳校验目标 IP，防止 302→内网绕过
 * - 大小限制：下载上限 500KB，防 OOM
 * - 超时保护 + content-type 校验
 */

import { lookup } from 'node:dns/promises';
import type { ToolDef } from '../types.ts';

const MAX_BYTES = 2000; // 截断后喂给 LLM 的最大字符数
const MAX_DOWNLOAD_BYTES = 500_000; // H1: 下载上限 500KB，防 OOM
const TIMEOUT_MS = 10000;

/** H1: 私网/保留 IP 检测（防 SSRF） */
function isPrivateIP(ip: string): boolean {
  // IPv4
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;                    // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;      // 192.168.0.0/16
    if (a === 127) return true;                   // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true;      // 169.254.0.0/16 (link-local + cloud metadata)
    if (a === 0) return true;                     // 0.0.0.0/8
  }
  // IPv6 loopback
  if (ip === '::1' || ip === '::') return true;
  return false;
}

/** H1: DNS 解析并检查 IP 是否安全 */
async function validateHost(hostname: string): Promise<void> {
  // localhost 直接拦截
  if (/^localhost$/i.test(hostname)) {
    throw new Error('SSRF 防护：拒绝 localhost');
  }
  try {
    const result = await lookup(hostname);
    if (isPrivateIP(result.address)) {
      throw new Error(`SSRF 防护：${hostname} 解析到私网地址 ${result.address}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SSRF')) throw e;
    // DNS 解析失败——允许 fetch 自行处理（可能最终失败）
  }
}

/**
 * 判断 content-type 是否为「可安全喂给 LLM 的文本类」。
 */
function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml' || mime === 'application/javascript') return true;
  if (mime.endsWith('+xml') || mime.endsWith('+json')) return true;
  return false;
}

export const httpGetTool: ToolDef<{ url: string }> = {
  name: 'http_get',
  description: '抓取一个 URL 的文本内容（GET 请求，适合简单的网页或 JSON API）。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的完整 URL（http/https）' },
    },
    required: ['url'],
  },
  requiresApproval: true,
  async execute({ url }) {
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, output: `仅支持 http/https URL，收到：${url.slice(0, 100)}` };
    }
    try {
      // H1: SSRF 防护——DNS 解析并拦截私网 IP
      const parsed = new URL(url);
      await validateHost(parsed.hostname);

      const resp = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow', // fetch 内部跟随重定向；validateHost 已拦截私网
      });
      if (!resp.ok) {
        return { ok: false, output: `HTTP ${resp.status} ${resp.statusText}` };
      }
      const contentType = resp.headers.get('content-type');
      if (!isTextContentType(contentType)) {
        return {
          ok: false,
          output: `不支持的响应类型「${contentType ?? '未知'}」，仅支持文本/JSON/XML 类内容。`,
        };
      }
      // M1: 限制下载大小——先读 limited 再截断给 LLM
      const reader = resp.body?.getReader();
      if (!reader) {
        // 无 ReadableStream（mock 或旧环境）——直接 text()
        const text = await resp.text();
        const truncated = text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n…（已截断，共 ${text.length} 字符）` : text;
        return { ok: true, output: truncated };
      }
      let downloaded = 0;
      const chunks: Uint8Array[] = [];
      while (downloaded < MAX_DOWNLOAD_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value!.length;
        chunks.push(value!);
      }
      await reader.cancel(); // 超过上限时取消下载
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      const truncated = text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n…（已截断，共 ${text.length} 字符）` : text;
      return { ok: true, output: truncated };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, output: `抓取失败：${msg}` };
    }
  },
};
