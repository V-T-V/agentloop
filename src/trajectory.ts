/**
 * 轨迹渲染：把 Span 树转成人类可读的「执行轨迹」。
 *
 * 用途双重：
 *   1. /replay 命令展示（逐步显示 AI 做了什么、工具返回了什么）。
 *   2. LLM-as-judge 的评估 prompt 输入（让 judge 模型看懂整条轨迹）。
 *
 * 依赖 loop.ts 已写入 span.attributes 的内容捕获（input.messages / output.content /
 * output.toolCalls / output.result / summary / approval.decision / error）。
 *
 * 子 agent 轨迹自动嵌套：tool(delegate) 的 children 是子 run 的 step 树，
 * 用缩进层级体现委托关系。
 */

import type { Span } from './trace.ts';
import type { Message, ToolCall } from './types.ts';

/** 一条结构化轨迹事件（供程序化消费，也便于测试断言） */
export interface TrajectoryEvent {
  step: number;
  kind: 'llm' | 'tool' | 'compact' | 'error';
  /** 可读摘要 */
  summary: string;
  /** 原始属性（含捕获的全部内容） */
  attributes: Record<string, unknown>;
  /** 缩进层级（顶层=0，子 agent 内部递增） */
  depth: number;
}

/** 从一棵 span 树提取按时间顺序的轨迹事件列表 */
export function extractTrajectory(root: Span | null): TrajectoryEvent[] {
  if (!root) return [];
  const events: TrajectoryEvent[] = [];
  walk(root, 0, events);
  return events;
}

/** 深度优先遍历，按 step → llm/tool/compact 的自然顺序收集事件 */
function walk(span: Span, depth: number, out: TrajectoryEvent[]): void {
  // step span：进入它的子 span（llm/tool/compact），自身不产事件
  if (span.name === 'step') {
    for (const child of span.children) walk(child, depth, out);
    return;
  }
  // run span：根，直接下钻
  if (span.name === 'run') {
    for (const child of span.children) walk(child, depth, out);
    return;
  }
  const step = typeof span.attributes['step'] === 'number' ? (span.attributes['step'] as number) : 0;
  if (span.name === 'llm') {
    out.push({ step, kind: 'llm', summary: summarizeLLM(span), attributes: span.attributes, depth });
    return;
  }
  if (span.name === 'tool') {
    out.push({ step, kind: 'tool', summary: summarizeTool(span), attributes: span.attributes, depth });
    // 子 agent：tool(delegate) 的 children 是嵌套 run 树，递归并加深层级
    for (const child of span.children) walk(child, depth + 1, out);
    return;
  }
  if (span.name === 'compact') {
    out.push({ step, kind: 'compact', summary: summarizeCompact(span), attributes: span.attributes, depth });
    return;
  }
  // 其它未知 span：递归子节点
  for (const child of span.children) walk(child, depth, out);
}

function summarizeLLM(span: Span): string {
  const content = span.attributes['output.content'];
  const toolCalls = span.attributes['output.toolCalls'] as ToolCall[] | undefined;
  const parts: string[] = [];
  if (content) parts.push(`回复：${truncate(String(content), 200)}`);
  if (toolCalls && toolCalls.length) {
    parts.push(
      `决定调用工具：${toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(', ')}`,
    );
  }
  if (span.attributes['error']) parts.push(`出错：${span.attributes['error']}`);
  return parts.join('；') || '(空)';
}

function summarizeTool(span: Span): string {
  const toolName = span.attributes['tool'] ?? span.name;
  const args = span.attributes['input.arguments'];
  const result = span.attributes['output.result'];
  const approval = span.attributes['approval.decision'] as
    | { approved: boolean; reason?: string }
    | undefined;
  const parts: string[] = [`工具 ${toolName}`];
  if (args && Object.keys(args as object).length) parts.push(`参数 ${JSON.stringify(args)}`);
  if (approval) {
    parts.push(approval.approved ? '✅ 已获审批' : `❌ 审批被拒（${approval.reason ?? ''}）`);
  }
  if (result) parts.push(`结果：${truncate(String(result), 200)}`);
  return parts.join(' | ');
}

function summarizeCompact(span: Span): string {
  const summary = span.attributes['summary'];
  const before = span.attributes['beforeMessages'];
  const after = span.attributes['afterMessages'];
  return `上下文压缩 ${before}→${after} 条；摘要：${truncate(String(summary ?? ''), 150)}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 把轨迹事件列表渲染成可读文本（供 /replay 与评估 prompt） */
export function renderTrajectory(root: Span | null): string {
  const events = extractTrajectory(root);
  if (events.length === 0) return '(无轨迹)';
  const lines: string[] = [];
  for (const ev of events) {
    const pad = '  '.repeat(ev.depth);
    const tag = ev.kind === 'llm' ? '🧠' : ev.kind === 'tool' ? '🔧' : ev.kind === 'compact' ? '🗜️' : '⛔';
    lines.push(`${pad}${tag} [step ${ev.step}] ${ev.summary}`);
  }
  return lines.join('\n');
}

/** 提取原始的用户问题（轨迹首条 user 消息），供评估时对照「任务是什么」 */
export function extractUserQuestion(root: Span | null): string {
  if (!root) return '';
  const firstLLM = findFirstLLM(root);
  const messages = firstLLM?.attributes['input.messages'] as Message[] | undefined;
  const firstUser = messages?.find((m) => m.role === 'user');
  return firstUser?.content ? String(firstUser.content) : '';
}

/** 提取最终答案（run span 的 answer 属性） */
export function extractFinalAnswer(root: Span | null): string {
  if (!root) return '';
  return String(root.attributes['answer'] ?? '');
}

function findFirstLLM(span: Span): Span | undefined {
  if (span.name === 'llm') return span;
  for (const child of span.children) {
    const hit = findFirstLLM(child);
    if (hit) return hit;
  }
  return undefined;
}
