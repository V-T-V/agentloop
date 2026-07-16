/**
 * 上下文工程：自动压缩（auto-compact）。
 *
 * 这是让 Agent 能长程运行的第一大主线。依据：
 * - Anthropic《Effective Context Engineering》：上下文接近窗口上限时，质量会进入「rot 区」，
 *   应在此之前把历史摘要化、重启上下文。
 * - Claude Code 在 ~95% 时触发 auto-compact。本项目用更保守的 85%，给摘要本身留空间。
 *
 * 触发条件（双重阈值，任一满足即触发）：
 *   estimatedTokens(memory) >= threshold * tokenBudget   // token 为主
 *   OR memory.length >= maxMessages                        // 消息条数兜底
 *
 * 压缩流程：
 *   1. 保留首条 system + 最近 N 条（recent window）不压缩。
 *   2. 中间历史拼成一段，构造摘要请求，调 LLM 生成结构化摘要。
 *   3. 用 [system] + [摘要 user/assistant] + [recent window] 重写 Memory。
 *
 * 设计为「可关闭 + 离线可用」：未配置时不触发；StubLLM 也能正常摘要。
 */

import { env } from './env.ts';
import { Memory } from './memory.ts';
import { extractText } from './multimodal.ts';
import { estimateMemoryTokens } from './tokens.ts';
import type { LLMClient, Message } from './types.ts';

export interface CompactConfig {
  /** 模型上下文预算（token），默认取 LOOP_TOKEN_BUDGET，再默认 120000 */
  tokenBudget: number;
  /** token 占比阈值，达此则压缩，默认 0.85 */
  threshold: number;
  /** 消息条数兜底阈值，默认 60 */
  maxMessages: number;
  /** 压缩时保留最近 N 条不压缩，默认 6 */
  recentWindow: number;
}

/** 从环境变量读取压缩配置（带默认值） */
export function loadCompactConfig(): CompactConfig {
  return {
    tokenBudget: Number(env('LOOP_TOKEN_BUDGET', '120000')) || 120000,
    threshold: Number(env('LOOP_COMPACT_THRESHOLD', '0.85')) || 0.85,
    maxMessages: Number(env('LOOP_COMPACT_MAX_MESSAGES', '60')) || 60,
    recentWindow: Number(env('LOOP_COMPACT_RECENT', '6')) || 6,
  };
}

/** 估算当前记忆的 token 数 */
export function currentTokens(memory: Memory): number {
  return estimateMemoryTokens(memory.snapshot());
}

/** 判断是否应该触发压缩（双重阈值） */
export function shouldCompact(memory: Memory, config: CompactConfig): boolean {
  // 消息太少不值得压缩（至少要有 system + 摘要目标 + recent window 的量）
  const minMessages = 2 + config.recentWindow + 1;
  if (memory.length < minMessages) return false;
  const tokens = currentTokens(memory);
  const tokenTrigger = tokens >= config.threshold * config.tokenBudget;
  const messageTrigger = memory.length >= config.maxMessages;
  return tokenTrigger || messageTrigger;
}

/** 摘要指令：指导 LLM 如何压缩历史 */
const COMPACT_SYSTEM_PROMPT =
  '你是一个对话压缩助手。请把下面的对话历史压缩成一段简洁的摘要，' +
  '保留所有关键事实、用户意图、已做出的决定、工具调用结果要点，' +
  '丢弃寒暄与冗余。只输出摘要正文，不要额外解释。';

/** 把中间历史消息渲染成可摘要的纯文本 */
function renderHistory(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = m.role;
      const parts: string[] = [];
      // 多模态：提取纯文本（图片用 [图片] 占位）
      const text = extractText(m.content);
      if (text) parts.push(text);
      if (m.toolCalls) {
        parts.push(m.toolCalls.map((c) => `[调用工具 ${c.name}(${JSON.stringify(c.arguments)})]`).join(' '));
      }
      return `【${role}】${parts.join(' ') || '(空)'}`;
    })
    .join('\n');
}

export interface CompactResult {
  /** 是否实际执行了压缩（未触发或历史太短则为 false） */
  performed: boolean;
  beforeTokens: number;
  afterTokens: number;
  beforeMessages: number;
  afterMessages: number;
  /** 摘要内容（performed=false 时为空） */
  summary: string;
}

/**
 * 执行压缩：在 memory 上原地重写历史。
 * 如果不应压缩或历史太短，原样返回 performed:false。
 */
export async function compactMemory(
  memory: Memory,
  llm: LLMClient,
  config: CompactConfig,
): Promise<CompactResult> {
  const beforeTokens = currentTokens(memory);
  const beforeMessages = memory.length;
  const snapshot = memory.snapshot();

  if (!shouldCompact(memory, config)) {
    return { performed: false, beforeTokens, afterTokens: beforeTokens, beforeMessages, afterMessages: beforeMessages, summary: '' };
  }

  // 拆分：首条 system + 中间历史（待压缩）+ 最近的 recent window
  const system = snapshot[0]?.role === 'system' ? snapshot[0] : { role: 'system' as const, content: '' };
  const rest = snapshot[0]?.role === 'system' ? snapshot.slice(1) : snapshot;
  // 中间部分 = rest 去掉末尾 recent window
  const recentCount = Math.min(config.recentWindow, rest.length);
  const toCompress = rest.slice(0, rest.length - recentCount);
  const recent = rest.slice(rest.length - recentCount);

  // 待压缩部分为空则无需压缩（理论不应发生，因 shouldCompact 已挡）
  if (toCompress.length === 0) {
    return { performed: false, beforeTokens, afterTokens: beforeTokens, beforeMessages, afterMessages: beforeMessages, summary: '' };
  }

  // 调 LLM 生成摘要（用一次无工具的补全）
  const summaryReq: Message[] = [
    { role: 'system', content: COMPACT_SYSTEM_PROMPT },
    { role: 'user', content: renderHistory(toCompress) },
  ];
  const { message } = await llm.chat({ messages: summaryReq, tools: [] });
  const summary = extractText(message.content).trim() || '(历史已压缩，无摘要)';

  // 重写 memory：system + 压缩标记 + 摘要 + recent window
  const newMessages: Message[] = [
    system,
    {
      role: 'user',
      content: '[以下是此前对话的压缩摘要，供你延续上下文]\n' + summary,
    },
    ...recent,
  ];
  memory.replaceAll(newMessages);

  return {
    performed: true,
    beforeTokens,
    afterTokens: currentTokens(memory),
    beforeMessages,
    afterMessages: memory.length,
    summary,
  };
}
