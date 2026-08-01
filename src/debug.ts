/**
 * 调试工具：状态快照导出 / 事件日志回放 / 时序图生成。
 *
 * 调试长程 Agent 运行时，需要三种离线诊断能力：
 * 1. exportSnapshot：把 memory + budget + trace + 元数据打包成可移植 JSON，
 *    供「现场复制问题」——把快照发给开发者即可离线复现。
 * 2. EventRecorder + replayEventLog：录制 runLoop 的 LoopEvent 序列，
 *    支持序列化/反序列化与回放（不重新调 LLM，纯事件重放做可视化/断言）。
 * 3. renderTimingDiagram：把 span 树渲染成 ASCII 甘特图，直观看到 step/llm/tool/compact
 *    的时间重叠与耗时分布。
 *
 * 零依赖，纯函数（除 EventRecorder 内部数组），可被 test 完整验证。
 */

import type { BudgetSnapshot } from './budget.ts';
import { renderSpanTree, type Span } from './trace.ts';
import type { LoopEvent, Message, TokenUsage } from './types.ts';

// —————————— 1. 状态快照导出 ——————————

/** 快照元数据 */
export interface SnapshotMeta {
  /** 快照生成时间（ISO） */
  capturedAt: string;
  /** agentloop 版本（若可知） */
  agentVersion?: string;
  /** 运行 id（若来自 durable） */
  runId?: string;
  /** 触发快照的原因（如「用户 /debug」） */
  reason?: string;
}

/** 完整状态快照 */
export interface StateSnapshot {
  __schema: 'agentloop-snapshot';
  version: number;
  meta: SnapshotMeta;
  /** 当前 memory 的全部消息 */
  messages: Message[];
  /** 累计 token 用量 */
  totalUsage: TokenUsage;
  /** 预算守卫快照（若启用） */
  budget?: BudgetSnapshot;
  /** 运行结论 */
  stopReason?: string;
  answer?: string;
}

/**
 * 导出一份状态快照。
 * @param input 当前运行的 memory 消息、用量、预算等
 * @param reason 触发原因
 */
export function exportSnapshot(input: {
  messages: Message[];
  totalUsage: TokenUsage;
  budget?: BudgetSnapshot;
  stopReason?: string;
  answer?: string;
  runId?: string;
  agentVersion?: string;
  reason?: string;
}): StateSnapshot {
  return {
    __schema: 'agentloop-snapshot',
    version: 1,
    meta: {
      capturedAt: new Date().toISOString(),
      agentVersion: input.agentVersion,
      runId: input.runId,
      reason: input.reason,
    },
    messages: input.messages.map((m) => ({ ...m })),
    totalUsage: { ...input.totalUsage },
    budget: input.budget ? { ...input.budget } : undefined,
    stopReason: input.stopReason,
    answer: input.answer,
  };
}

/** 把快照序列化为 JSON 字符串 */
export function serializeSnapshot(snapshot: StateSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/** 从 JSON 字符串反序列化快照（校验 schema） */
export function parseSnapshot(json: string): StateSnapshot | null {
  try {
    const obj = JSON.parse(json) as StateSnapshot;
    if (obj.__schema !== 'agentloop-snapshot') return null;
    if (obj.version !== 1) return null;
    if (!Array.isArray(obj.messages)) return null;
    return obj;
  } catch {
    return null;
  }
}

// —————————— 2. 事件日志录制与回放 ——————————

/** 事件录制器：收集 LoopEvent 序列 */
export class EventRecorder {
  private readonly events: Array<{ at: number; event: LoopEvent }> = [];
  private readonly startTs: number;

  constructor() {
    this.startTs = Date.now();
  }

  /** 作为 runLoop 的 onEvent 回调使用 */
  record = (event: LoopEvent): void => {
    this.events.push({ at: Date.now() - this.startTs, event });
  };

  /** 已录制的事件数 */
  get length(): number {
    return this.events.length;
  }

  /** 导出为可序列化的日志（相对时间戳 ms） */
  exportLog(): EventLog {
    return {
      __schema: 'agentloop-eventlog',
      version: 1,
      startedAt: new Date(this.startTs).toISOString(),
      events: this.events.map((e) => ({ atMs: e.at, event: e.event })),
    };
  }

  /** 按类型过滤事件 */
  filterByType(type: LoopEvent['type']): LoopEvent[] {
    return this.events.filter((e) => e.event.type === type).map((e) => e.event);
  }
}

/** 可序列化的事件日志 */
export interface EventLog {
  __schema: 'agentloop-eventlog';
  version: number;
  startedAt: string;
  events: Array<{ atMs: number; event: LoopEvent }>;
}

/** 序列化事件日志 */
export function serializeEventLog(log: EventLog): string {
  return JSON.stringify(log, null, 2);
}

/** 反序列化事件日志（校验 schema） */
export function parseEventLog(json: string): EventLog | null {
  try {
    const obj = JSON.parse(json) as EventLog;
    if (obj.__schema !== 'agentloop-eventlog') return null;
    if (obj.version !== 1) return null;
    if (!Array.isArray(obj.events)) return null;
    return obj;
  } catch {
    return null;
  }
}

/** 回放统计：从事件日志汇总各类型计数与总时长 */
export interface ReplaySummary {
  totalEvents: number;
  /** 各事件类型计数 */
  counts: Record<string, number>;
  /** 日志总时长（ms，最后一个事件的 atMs） */
  durationMs: number;
  /** 最终答案（若有 final 事件） */
  finalAnswer?: string;
  /** 工具调用次数 */
  toolCalls: number;
  /** 压缩次数 */
  compacts: number;
  /** 错误数 */
  errors: number;
}

/** 回放事件日志，生成汇总报告 */
export function summarizeEventLog(log: EventLog): ReplaySummary {
  const counts: Record<string, number> = {};
  let toolCalls = 0;
  let compacts = 0;
  let errors = 0;
  let finalAnswer: string | undefined;
  let durationMs = 0;
  for (const entry of log.events) {
    const t = entry.event.type;
    counts[t] = (counts[t] ?? 0) + 1;
    durationMs = entry.atMs;
    switch (t) {
      case 'tool_call':
        toolCalls++;
        break;
      case 'compact':
        compacts++;
        break;
      case 'error':
        errors++;
        break;
      case 'final':
        finalAnswer = entry.event.answer;
        break;
    }
  }
  return { totalEvents: log.events.length, counts, durationMs, finalAnswer, toolCalls, compacts, errors };
}

/** 把事件日志渲染为时间线文本（每事件一行） */
export function renderEventTimeline(log: EventLog): string {
  const lines: string[] = [`时间线（起点 ${log.startedAt}，共 ${log.events.length} 事件）`];
  for (const entry of log.events) {
    const e = entry.event;
    const ts = `+${entry.atMs.toString().padStart(6, ' ')}ms`;
    lines.push(`  ${ts}  ${describeEvent(e)}`);
  }
  return lines.join('\n');
}

/** 简短描述一个事件 */
function describeEvent(e: LoopEvent): string {
  switch (e.type) {
    case 'thinking':
      return `[step${e.step}] ${e.message}`;
    case 'tool_call':
      return `[step${e.step}] 调用工具 ${e.call.name}`;
    case 'tool_result':
      return `[step${e.step}] 工具 ${e.callId} 完成 (${e.result.ok ? '成功' : '失败'})`;
    case 'final':
      return `[最终] ${e.answer.slice(0, 40)}${e.answer.length > 40 ? '…' : ''}`;
    case 'max_steps':
      return `[上限] 达到 ${e.steps} 步`;
    case 'error':
      return `[错误] ${e.message}`;
    case 'budget_exceeded':
      return `[预算] ${e.spent}/${e.limit} 耗尽`;
    case 'stream_delta':
      return `[step${e.step}] 流式 +${e.text.length}字`;
    case 'usage':
      return `[step${e.step}] 用量 ${e.usage.totalTokens} tokens`;
    case 'compact':
      return `[step${e.step}] 压缩 ${e.beforeMessages}→${e.afterMessages} msg`;
    case 'approval_request':
      return `[step${e.step}] 审批请求 ${e.call.name}`;
    case 'approval_result':
      return `[step${e.step}] 审批 ${e.decision.approved ? '通过' : '拒绝'}`;
    default:
      return `[${(e as { type: string }).type}]`;
  }
}

// —————————— 3. 时序图生成（ASCII 甘特图）——————————

/** 把 span 树扁平化为按开始时间排序的 span 列表 */
function flattenSpans(span: Span, out: Span[] = []): Span[] {
  out.push(span);
  for (const c of span.children) flattenSpans(c, out);
  return out;
}

/** 渲染时序甘特图：每个 span 一行，用 █ 表示占用时间段 */
export function renderTimingDiagram(root: Span | null, width = 60): string {
  if (!root) return '(无 trace)';
  const all = flattenSpans(root);
  // 计算总时间范围（用 run root 的 start/end）
  const t0 = root.start;
  const t1 = root.end ?? Math.max(...all.map((s) => s.end ?? s.start));
  const total = Math.max(1, t1 - t0);

  // 按层级缩进展示（用 renderSpanTree 的顺序），但每行加甘特条
  const lines: string[] = [];
  lines.push(`时序图（总 ${total.toFixed(1)}ms，宽 ${width} 字符）`);
  lines.push('');

  // 递归渲染：每 span 一行
  const render = (span: Span, depth: number) => {
    const indent = '  '.repeat(depth);
    const dur = (span.end ?? span.start) - span.start;
    const ratio = dur / total;
    const barLen = Math.max(1, Math.round(ratio * width));
    const offset = Math.round(((span.start - t0) / total) * width);
    const pad = ' '.repeat(offset);
    const bar = '█'.repeat(barLen);
    const status = span.status === 'error' ? ' ✗' : '';
    const tool = span.attributes.tool ? `:${span.attributes.tool}` : '';
    const step = span.attributes.step !== undefined ? `#${span.attributes.step}` : '';
    const usageStr = span.usage ? ` ${span.usage.totalTokens}tok` : '';
    lines.push(`${indent}${span.name}${step}${tool} ${pad}${bar} ${dur.toFixed(1)}ms${usageStr}${status}`);
    for (const c of span.children) render(c, depth + 1);
  };
  render(root, 0);

  // 同时附上文本 span 树（详细属性）
  lines.push('');
  lines.push('— Span 树 —');
  lines.push(renderSpanTree(root));
  return lines.join('\n');
}

// —————————— 便捷：从 runLoop 结果一键导出调试包 ——————————

/** 从一次 runLoop 的产出汇总成完整调试包（快照 + 事件日志 + 时序图） */
export function buildDebugBundle(input: {
  messages: Message[];
  totalUsage: TokenUsage;
  trace: Span | null;
  answer: string;
  stopReason: string;
  budget?: BudgetSnapshot;
  events?: EventLog;
  runId?: string;
  reason?: string;
}): { snapshot: StateSnapshot; timingDiagram: string; eventLog?: EventLog } {
  const snapshot = exportSnapshot({
    messages: input.messages,
    totalUsage: input.totalUsage,
    budget: input.budget,
    stopReason: input.stopReason,
    answer: input.answer,
    runId: input.runId,
    reason: input.reason ?? 'debug-bundle',
  });
  return {
    snapshot,
    timingDiagram: renderTimingDiagram(input.trace),
    eventLog: input.events,
  };
}
