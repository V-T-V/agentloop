/**
 * 轻量 Token 估算器（零依赖）。
 *
 * 用途：驱动自动压缩的阈值判定，而非精确计费。Claude Code 等生产系统也用
 * 估算值触发 auto-compact——精确的 tiktoken 在浏览器/无依赖环境不可用，
 * 且阈值判定对误差容忍度高（触发后会留足缓冲）。
 *
 * 启发式：
 * - ASCII 字符（含数字、标点、空格）≈ 4 字符 / token
 * - CJK 中文 / 全角字符 ≈ 1.5 字符 / token（中文更「费 token」）
 *
 * 明确标注：这是估算，非精确。偏差通常在 ±20% 内，对阈值判定足够。
 */

import type { Message } from './types.ts';

/** 判断一个码点是否为 CJK / 全角字符（粗略：> 0x2E00 的多为非 ASCII） */
function isWide(cp: number): boolean {
  // CJK 统一表意文字、扩展、日韩文、全角标点等落在这些区间
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文 Jamo
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK 部首 + 表意文字
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xff00 && cp <= 0xffef) || // 全角形式
    (cp >= 0x20000 && cp <= 0x2fffd) // CJK 扩展 B-F
  );
}

/**
 * 估算一段文本的 token 数。
 * 按字符遍历，宽字符计 1/1.5 token，ASCII 计 1/4 token。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (isWide(ch.codePointAt(0) ?? 0)) wide++;
    else narrow++;
  }
  // 宽字符约 1.5 字符/token → wide / 1.5；窄字符约 4 字符/token → narrow / 4
  return Math.ceil(wide / 1.5 + narrow / 4);
}

/**
 * 估算一条消息的 token 数。
 * 每条消息有固定开销（角色标记、分隔符，OpenAI 经验值约 4 token）+ 各文本字段内容。
 */
export function estimateMessageTokens(message: Message): number {
  const overhead = 4; // 角色 + 分隔结构开销
  let sum = overhead;
  if (message.content) {
    if (typeof message.content === 'string') {
      sum += estimateTokens(message.content);
    } else {
      // 多模态：文本 part 按文本估算，图片 part 固定开销（low≈85 token, high≈765 token，取中间 200）
      for (const part of message.content) {
        if (part.type === 'text') sum += estimateTokens(part.text);
        else sum += 200; // 图片粗估
      }
    }
  }
  if (message.toolCalls) {
    for (const c of message.toolCalls) {
      sum += estimateTokens(c.name) + estimateTokens(JSON.stringify(c.arguments)) + 3;
    }
  }
  if (message.name) sum += estimateTokens(message.name);
  return sum;
}

/** 估算一段消息历史的总 token 数 */
export function estimateMemoryTokens(messages: readonly Message[]): number {
  let sum = 0;
  for (const m of messages) sum += estimateMessageTokens(m);
  return sum;
}
