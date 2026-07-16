/**
 * 会话记忆：内存级消息缓冲 + 可选滑动窗口。
 *
 * 不落盘、不持久化——每次进程启动都是全新会话。
 * 提供 add / addToolResult / clear / snapshot 等原语供 loop.ts 使用。
 *
 * 设计为「平坦的消息历史」：所有 system/user/assistant/tool 消息按时间顺序平铺，
 * 不做树状分支或复杂状态机——这是 Anthropic 官方推荐的最简可靠形态。
 */

import { extractText } from './multimodal.ts';
import type { Message, ToolResult } from './types.ts';

export interface MemoryOptions {
  /**
   * 保留最近 N 条消息（始终保留首条 system），0 / 负数表示不裁剪。
   * 裁剪按「整组」进行：负责若干 tool 结果的 assistant(tool_calls) 会与其 tool 结果
   * 一同保留，避免留下孤立的 tool 消息（否则 OpenAI 兼容端点会直接 400
   * 「tool message must be a response to a preceding tool_calls message」）。
   * 故实际返回条数可能略多于 N。
   */
  windowSize?: number;
}

export class Memory {
  private readonly messages: Message[] = [];
  private readonly windowSize: number;

  constructor(systemPrompt: string, options: MemoryOptions = {}) {
    this.windowSize = options.windowSize ?? 0;
    this.messages.push({ role: 'system', content: systemPrompt });
  }

  /** 追加一条消息 */
  add(message: Message): void {
    this.messages.push(message);
  }

  /** 追加一条 tool 结果消息（回填到指定 tool_call_id） */
  addToolResult(callId: string, name: string, result: ToolResult): void {
    this.messages.push({
      role: 'tool',
      content: result.output,
      toolCallId: callId,
      name,
    });
  }

  /** 清空对话（保留 system prompt，可替换为新的） */
  clear(systemPrompt?: string): void {
    this.messages.length = 0;
    this.messages.push({ role: 'system', content: systemPrompt ?? '' });
  }

  /**
   * 用一组全新消息替换全部历史（供上下文压缩重写使用）。
   * 调用方负责保证新历史的语义正确性（如保留 system、保留最近窗口）。
   */
  replaceAll(messages: Message[]): void {
    this.messages.length = 0;
    for (const m of messages) this.messages.push(m);
  }

  /**
   * 供 LLM 调用读取的快照（应用滑动窗口）。
   * 始终保留首条 system，再取最近若干条，保证系统提示不丢失。
   *
   * 配对保护：tool 结果消息必须紧随一个带 tool_calls 的 assistant 出现，否则 OpenAI
   * 兼容端点会返回 400。因此裁剪按「整组」进行——若裁剪后窗口的首条非 system 消息是
   * 孤立的 tool，则向前回溯到负责它的 assistant(tool_calls) 一并保留。
   */
  snapshot(): Message[] {
    if (this.windowSize <= 0 || this.messages.length <= this.windowSize) {
      return [...this.messages];
    }
    const [system, ...rest] = this.messages;
    // rest 中起始裁剪下标（rest[0] 对应 messages[1]）
    let start = rest.length - (this.windowSize - 1);
    if (start < 0) start = 0;
    // 向前回溯：跳过连续的 tool 消息，并连带保留它前方的 assistant(tool_calls)
    while (start > 0 && rest[start]!.role === 'tool') {
      start--;
    }
    const tail = rest.slice(start);
    return system && system.role === 'system' ? [system, ...tail] : [...tail];
  }

  /** 当前消息总数（含 system） */
  get length(): number {
    return this.messages.length;
  }

  /** 系统提示（首条 system 消息内容；若无则空串。多模态：提取纯文本） */
  get systemPrompt(): string {
    const first = this.messages[0];
    return first && first.role === 'system' ? extractText(first.content) : '';
  }

  /** 全部消息（含 system 首条）的深拷贝，供持久化使用 */
  serializeMessages(): Message[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /** 从一组消息重建记忆（持久化加载用）。会丢弃当前内容。 */
  static fromMessages(messages: Message[], windowSize = 0): Memory {
    const first = messages[0];
    const system = first && first.role === 'system' ? extractText(first.content) : '';
    const mem = new Memory(system, { windowSize });
    mem.messages.length = 0;
    for (const m of messages) mem.messages.push(m);
    return mem;
  }
}
