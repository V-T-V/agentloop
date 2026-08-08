/**
 * R13-D6（agentloop）：runLoop 运行统计摘要器。
 *
 * trace.ts 有 span 树，metrics.ts 有聚合面板，但缺一个「面向用户的运行总结」——
 * 把一次 runLoop 的关键信息（步数/耗时/token/工具调用/压缩/错误）合成一句话摘要。
 *
 * 用途：CLI 输出尾部的「本次运行：3 步，耗时 2.3s，1500 token，2 次工具调用」。
 *
 * 纯函数。
 */

import type { Span } from './trace.ts';
import { flattenSpans } from './metrics.ts';

export interface LoopSummary {
  /** 总步数 */
  steps: number;
  /** 总耗时（毫秒） */
  durationMs: number;
  /** 总 token */
  totalTokens: number;
  /** 工具调用次数 */
  toolCalls: number;
  /** 工具成功次数 */
  toolSuccess: number;
  /** 压缩次数 */
  compacts: number;
  /** 错误次数 */
  errors: number;
  /** 是否成功完成（有 final 事件） */
  completed: boolean;
  /** 最慢的一步耗时（毫秒） */
  slowestStepMs: number;
  /** 人类可读摘要 */
  summary: string;
}

/**
 * 从 rootSpan 生成运行摘要。
 */
export function summarizeLoop(rootSpan: Span | null): LoopSummary {
  if (!rootSpan) {
    return {
      steps: 0, durationMs: 0, totalTokens: 0, toolCalls: 0,
      toolSuccess: 0, compacts: 0, errors: 0, completed: false,
      slowestStepMs: 0, summary: '无运行数据',
    };
  }

  const spans = flattenSpans(rootSpan);
  const steps = spans.filter((s) => s.name === 'step');
  const tools = spans.filter((s) => s.name === 'tool');
  const compacts = spans.filter((s) => s.name === 'compact');
  const errors = spans.filter((s) => s.status === 'error');
  const finals = spans.filter((s) => s.name === 'final');
  const llmSpans = spans.filter((s) => s.name === 'llm');

  const durationMs = rootSpan.end !== null ? rootSpan.end - rootSpan.start : 0;
  const totalTokens = llmSpans.reduce((sum, s) => sum + (s.usage?.totalTokens ?? 0), 0);
  const toolSuccess = tools.filter((s) => s.status !== 'error').length;
  const stepDurations = steps.map((s) => (s.end !== null ? s.end - s.start : 0));
  const slowestStepMs = stepDurations.length > 0 ? Math.max(...stepDurations) : 0;

  const summary = buildSummary(
    steps.length, durationMs, totalTokens, tools.length,
    toolSuccess, compacts.length, errors.length, finals.length > 0,
  );

  return {
    steps: steps.length,
    durationMs,
    totalTokens,
    toolCalls: tools.length,
    toolSuccess,
    compacts: compacts.length,
    errors: errors.length,
    completed: finals.length > 0,
    slowestStepMs,
    summary,
  };
}

function buildSummary(
  steps: number, durationMs: number, tokens: number,
  toolCalls: number, toolSuccess: number, compacts: number,
  errors: number, completed: boolean,
): string {
  const parts: string[] = [];
  parts.push(`${steps} 步`);
  parts.push(formatDuration(durationMs));
  if (tokens > 0) parts.push(`${formatTokens(tokens)} token`);
  if (toolCalls > 0) parts.push(`${toolCalls} 次工具调用${errors > 0 ? `（${errors} 错误）` : '（全成功）'}`);
  if (compacts > 0) parts.push(`${compacts} 次压缩`);
  parts.push(completed ? '✅ 完成' : '⚠️ 未完成');
  return parts.join(' · ');
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * 判断运行是否「健康」（无错误 + 完成 + 未超时）。
 */
export function isHealthyRun(summary: LoopSummary, maxDurationMs = 60000): boolean {
  return summary.errors === 0 && summary.completed && summary.durationMs <= maxDurationMs;
}

/**
 * 生成运行效率评级（基于步数/token/耗时比）。
 */
export function efficiencyRating(summary: LoopSummary): '高效' | '正常' | '低效' {
  if (summary.steps === 0) return '正常';
  // 平均每步 token：>1000 为低效（可能冗余），<300 为高效
  const tokensPerStep = summary.steps > 0 ? summary.totalTokens / summary.steps : 0;
  if (tokensPerStep > 0 && tokensPerStep < 300) return '高效';
  if (tokensPerStep > 1000) return '低效';
  return '正常';
}
