/**
 * 工具：http_get —— 用原生 fetch 抓取一个 URL 的文本内容。
 *
 * 演示「带副作用的异步工具」：
 * - 真实网络 I/O，有延迟、可能失败——失败也作为 { ok:false } 回填，交给 LLM 决策。
 * - 做了长度截断与超时保护，避免把超长内容灌进上下文或永久卡住。
 * - 做 content-type 校验：拒绝把二进制/图片/PDF 等非文本响应的乱码灌进 LLM 上下文。
 */

import type { ToolDef } from '../types.ts';

const MAX_BYTES = 2000; // 截断后喂给 LLM 的最大字符数，防止上下文爆炸
const TIMEOUT_MS = 10000; // 单次抓取超时

/**
 * 判断 content-type 是否为「可安全喂给 LLM 的文本类」。
 * 接受：text/*、application/json、application/xml、application/javascript，
 * 以及带 +xml / +json 后缀的子类型（如 application/atom+xml、application/vnd.api+json）。
 */
function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false; // 未知类型，保守拒绝
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
  // 真实网络请求属于「有副作用的高风险动作」，标记需审批（HITL）。
  // 配合 onApproval 钩子，让用户在执行前确认目标 URL。
  requiresApproval: true,
  async execute({ url }) {
    // 基础校验：只允许 http/https，拒绝 file:// 等其它协议
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, output: `仅支持 http/https URL，收到：${url}` };
    }
    try {
      const resp = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
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
      const text = await resp.text();
      const truncated =
        text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n…（已截断，共 ${text.length} 字符）` : text;
      return { ok: true, output: truncated };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, output: `抓取失败：${msg}` };
    }
  },
};
