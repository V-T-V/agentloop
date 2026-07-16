/**
 * 指标聚合面板：从 trace span 树提取运行统计。
 *
 * 缺口：trace 只有 span 树，调试长任务靠肉眼读 span。本模块把扁平 span 列表
 * 按 name 分组聚合，产出「平均步耗时/工具成功率/token 分布」等可读指标。
 *
 * 用途：长任务诊断、性能瓶颈定位、成本归因。集成到 run-task/long-task 的 --metrics 输出。
 */

import type { Span } from './trace.ts';

/** 单类 span 的聚合统计 */
export interface SpanTypeMetrics {
  /** span 名称（run/step/llm/tool/compact） */
  name: string;
  /** 出现次数 */
  count: number;
  /** 总耗时（ms） */
  totalMs: number;
  /** 平均耗时（ms） */
  avgMs: number;
  /** 最大耗时（ms） */
  maxMs: number;
  /** 最小耗时（ms） */
  minMs: number;
  /** 错误次数 */
  errorCount: number;
  /** 错误率（0-1） */
  errorRate: number;
  /** 该类 span 的 token 汇总（仅 llm span 有值） */
  totalTokens: number;
}

/** 完整指标报告 */
export interface MetricsReport {
  /** 总运行时长（ms） */
  totalDurationMs: number;
  /** 总步数（step span 计数） */
  totalSteps: number;
  /** 总 token（prompt + completion） */
  totalTokens: number;
  /** 按类型分组的指标 */
  byType: SpanTypeMetrics[];
  /** 工具调用成功率（tool span ok 率） */
  toolSuccessRate: number;
  /** LLM 调用次数 */
  llmCalls: number;
  /** 压缩次数 */
  compactCount: number;
}

/** 计算单个 span 的耗时（已结束的 span 才有值） */
function spanDurationMs(span: Span): number {
  if (span.end === null) return 0;
  return span.end - span.start;
}

/** 计算单个 span 的 token 汇总 */
function spanTokens(span: Span): number {
  return span.usage?.totalTokens ?? 0;
}

/** 把 span 树递归展平为列表（供从 rootSpan 聚合时使用） */
export function flattenSpans(root: Span): Span[] {
  const result: Span[] = [root];
  const stack = [...root.children];
  while (stack.length > 0) {
    const s = stack.pop()!;
    result.push(s);
    stack.push(...s.children);
  }
  return result;
}

/**
 * 从扁平 span 列表聚合指标。
 * 接受 Tracer.getAll() 或任何 Span[] 输入。
 */
export function aggregateMetrics(spans: Span[]): MetricsReport {
  const groups = new Map<string, Span[]>();
  let totalDuration = 0;
  let totalTokens = 0;

  for (const span of spans) {
    const group = groups.get(span.name) ?? [];
    group.push(span);
    groups.set(span.name, group);
    if (span.name === 'run' && span.end !== null) {
      totalDuration = Math.max(totalDuration, spanDurationMs(span));
    }
    totalTokens += spanTokens(span);
  }

  const byType: SpanTypeMetrics[] = [];
  for (const [name, groupSpans] of groups) {
    const durations = groupSpans.map(spanDurationMs);
    const totalMs = durations.reduce((a, b) => a + b, 0);
    const errorCount = groupSpans.filter((s) => s.status === 'error').length;
    const tokens = groupSpans.reduce((a, s) => a + spanTokens(s), 0);
    byType.push({
      name,
      count: groupSpans.length,
      totalMs,
      avgMs: groupSpans.length > 0 ? totalMs / groupSpans.length : 0,
      maxMs: durations.length > 0 ? Math.max(...durations) : 0,
      minMs: durations.length > 0 ? Math.min(...durations) : 0,
      errorCount,
      errorRate: groupSpans.length > 0 ? errorCount / groupSpans.length : 0,
      totalTokens: tokens,
    });
  }

  // 按出现次数降序排列
  byType.sort((a, b) => b.count - a.count);

  // 工具成功率
  const toolSpans = groups.get('tool') ?? [];
  const toolErrors = toolSpans.filter((s) => s.status === 'error').length;
  const toolSuccessRate = toolSpans.length > 0 ? (toolSpans.length - toolErrors) / toolSpans.length : 1;

  return {
    totalDurationMs: totalDuration,
    totalSteps: groups.get('step')?.length ?? 0,
    totalTokens,
    byType,
    toolSuccessRate,
    llmCalls: groups.get('llm')?.length ?? 0,
    compactCount: groups.get('compact')?.length ?? 0,
  };
}

/** 格式化毫秒为可读字符串（如 "1.2s" 或 "350ms"） */
function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

/**
 * 渲染指标报告为 CLI 友好的表格字符串。
 * 适合在 run-task/long-task 结束时输出。
 */
export function renderMetrics(report: MetricsReport): string {
  const lines: string[] = [];
  lines.push('📊 运行指标');
  lines.push(`${'─'.repeat(56)}`);
  lines.push(`  总时长：${formatMs(report.totalDurationMs)} | 步数：${report.totalSteps} | LLM调用：${report.llmCalls} | token：${report.totalTokens}`);
  lines.push(`  工具成功率：${(report.toolSuccessRate * 100).toFixed(0)}%${report.compactCount > 0 ? ` | 压缩次数：${report.compactCount}` : ''}`);

  if (report.byType.length > 0) {
    lines.push('');
    lines.push('  按类型统计：');
    lines.push(`  ${'类型'.padEnd(10)} ${'次数'.padStart(4)} ${'总耗时'.padStart(8)} ${'平均'.padStart(8)} ${'最大'.padStart(8)} ${'错误'.padStart(4)} ${'token'.padStart(8)}`);
    lines.push(`  ${'─'.repeat(54)}`);
    for (const m of report.byType) {
      lines.push(
        `  ${m.name.padEnd(10)} ${String(m.count).padStart(4)} ${formatMs(m.totalMs).padStart(8)} ${formatMs(m.avgMs).padStart(8)} ${formatMs(m.maxMs).padStart(8)} ${String(m.errorCount).padStart(4)} ${m.totalTokens > 0 ? String(m.totalTokens).padStart(8) : '-'.padStart(8)}`,
      );
    }
  }
  return lines.join('\n');
}
