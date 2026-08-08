/**
 * R13-D8（agentloop）：工具调用统计器。
 *
 * trace 有 tool span，但缺按工具名分组的统计聚合。
 * 本模块补：
 *   - aggregateToolStats：按工具名分组统计（调用次数/成功率/平均耗时）
 *   - rankTools：按使用频率排序
 *   - identifyProblemTools：找出高失败率工具
 *
 * 纯函数，输入 span 列表。
 */

import type { Span } from './trace.ts';

export interface ToolStat {
  /** 工具名（从 span.attributes.name 取） */
  name: string;
  /** 调用次数 */
  calls: number;
  /** 成功次数 */
  successes: number;
  /** 失败次数 */
  failures: number;
  /** 成功率（0~1） */
  successRate: number;
  /** 总耗时（ms） */
  totalMs: number;
  /** 平均耗时（ms） */
  avgMs: number;
  /** 最大耗时（ms） */
  maxMs: number;
}

export interface ToolStatsReport {
  /** 按工具名分组的统计 */
  tools: ToolStat[];
  /** 总调用次数 */
  totalCalls: number;
  /** 总体成功率 */
  overallSuccessRate: number;
  /** 问题工具（成功率 < 0.7） */
  problemTools: ToolStat[];
}

/**
 * 从 span 列表聚合工具统计。
 */
export function aggregateToolStats(spans: Span[]): ToolStatsReport {
  const groups = new Map<string, Span[]>();
  for (const s of spans) {
    if (s.name !== 'tool') continue;
    const toolName = (s.attributes['name'] as string) ?? s.name;
    const group = groups.get(toolName) ?? [];
    group.push(s);
    groups.set(toolName, group);
  }

  const tools: ToolStat[] = [];
  let totalCalls = 0;
  let totalSuccess = 0;

  for (const [name, groupSpans] of groups) {
    const calls = groupSpans.length;
    const successes = groupSpans.filter((s) => s.status !== 'error').length;
    const failures = calls - successes;
    const durations = groupSpans.map((s) => (s.end !== null ? s.end - s.start : 0));
    const totalMs = durations.reduce((a, b) => a + b, 0);
    const toolStat: ToolStat = {
      name,
      calls,
      successes,
      failures,
      successRate: calls > 0 ? successes / calls : 0,
      totalMs,
      avgMs: calls > 0 ? totalMs / calls : 0,
      maxMs: durations.length > 0 ? Math.max(...durations) : 0,
    };
    tools.push(toolStat);
    totalCalls += calls;
    totalSuccess += successes;
  }

  // 按调用次数降序
  tools.sort((a, b) => b.calls - a.calls);
  const problemTools = tools.filter((t) => t.successRate < 0.7 && t.calls >= 2);

  return {
    tools,
    totalCalls,
    overallSuccessRate: totalCalls > 0 ? totalSuccess / totalCalls : 1,
    problemTools,
  };
}

/**
 * 按使用频率排序（返回前 N）。
 */
export function rankTools(report: ToolStatsReport, topN = 5): ToolStat[] {
  return report.tools.slice(0, topN);
}

/**
 * 找出高失败率工具（成功率 < 阈值 且调用次数 ≥ minCalls）。
 */
export function identifyProblemTools(
  report: ToolStatsReport,
  threshold = 0.7,
  minCalls = 2,
): ToolStat[] {
  return report.tools.filter((t) => t.successRate < threshold && t.calls >= minCalls);
}

/**
 * 渲染工具统计报告。
 */
export function renderToolStats(report: ToolStatsReport): string {
  const lines: string[] = [];
  lines.push(`🔧 工具调用统计（${report.totalCalls} 次，成功率 ${(report.overallSuccessRate * 100).toFixed(0)}%）`);
  if (report.tools.length > 0) {
    lines.push(`  ${'工具'.padEnd(16)} ${'次数'.padStart(4)} ${'成功'.padStart(4)} ${'失败'.padStart(4)} ${'成功率'.padStart(6)} ${'平均'.padStart(8)}`);
    for (const t of report.tools) {
      lines.push(
        `  ${t.name.padEnd(16)} ${String(t.calls).padStart(4)} ${String(t.successes).padStart(4)} ${String(t.failures).padStart(4)} ${(t.successRate * 100).toFixed(0).padStart(5)}% ${t.avgMs.toFixed(0).padStart(7)}ms`,
      );
    }
  }
  if (report.problemTools.length > 0) {
    lines.push('');
    lines.push(`⚠️ 问题工具（成功率 <70%）：`);
    for (const t of report.problemTools) {
      lines.push(`  • ${t.name}：${(t.successRate * 100).toFixed(0)}% 成功率（${t.failures}/${t.calls} 失败）`);
    }
  }
  return lines.join('\n');
}
