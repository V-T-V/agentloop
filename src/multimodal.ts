/**
 * 多模态辅助函数。
 *
 * Message.content 现在是 string | ContentPart[] | null，多处代码（compact 渲染、
 * eval 判断、verify 提取答案）需要从 content 中取纯文本。本模块集中提供提取逻辑，
 * 避免散落的类型判断。
 */

import type { ContentPart, Message } from './types.ts';

/**
 * 从 content 提取纯文本：
 * - string → 原样返回
 * - ContentPart[] → 拼接所有 text part，图片用 [图片] 占位
 * - null → 空串
 */
export function extractText(content: string | ContentPart[] | null): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  // ContentPart[] 数组
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      return '[图片]'; // 图片占位，供摘要/日志使用
    })
    .join('');
}

/** 判断 content 是否包含图片 */
export function hasImage(content: string | ContentPart[] | null): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((p) => p.type === 'image_url');
}

/** 从一条消息提取纯文本（便捷封装） */
export function messageText(msg: Message): string {
  return extractText(msg.content);
}

/**
 * 创建图片消息部件的便捷构造器。
 * url 可以是 http(s) URL 或 data: base64 URI。
 */
export function imageUrlPart(url: string, detail: 'low' | 'high' | 'auto' = 'auto'): ContentPart {
  return { type: 'image_url', image_url: { url, detail } };
}

/** 创建文本部件 */
export function textPart(text: string): ContentPart {
  return { type: 'text', text };
}
