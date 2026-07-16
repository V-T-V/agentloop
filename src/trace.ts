/**
 * Span 可观测性：把一次 runLoop 拆成层级化的 span 树。
 *
 * 参考 2026 业界共识（Braintrust Agent Observability 指南、AgentOps 论文）：
 * 把每一步推理 / 工具调用 / 压缩当一等 span，记录 token、延迟、状态。
 *
 * 层级约定：
 *   run（root）
 *   └─ step（每一步）
 *      ├─ llm        （LLM 调用，含 usage 与成本）
 *      ├─ tool       （工具执行，每个并发调用一个）
 *      └─ compact    （上下文压缩）
 *
 * 设计为零依赖、可关闭：tracer.disable() 后 startSpan/endSpan 退化为 no-op。
 */

import { env } from './env.ts';
import type { TokenUsage } from './types.ts';

/** 空用量，供无 usage 的调用兜底 */
export const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export type SpanStatus = 'ok' | 'error';

export interface Span {
  readonly id: string;
  name: string;
  parentId: string | null;
  start: number;
  end: number | null;
  status: SpanStatus;
  /** 自由属性：工具名、步号、token、压缩前后量等 */
  attributes: Record<string, unknown>;
  /** 子 span（运行期由 tracer 维护，最终构建成树） */
  children: Span[];
  /** 关联的 token 用量（仅 llm span 常用） */
  usage?: TokenUsage;
}

let counter = 0;
/** 生成 span id（进程内唯一即可） */
function nextId(): string {
  counter += 1;
  return `span_${counter}`;
}

/**
 * Tracer：管理 span 的创建、嵌套、汇总。
 * 用「当前 span 栈」自动建立父子关系——startSpan 时压栈，endSpan 时弹栈。
 * 内部只存扁平列表，树的组装延迟到 getRoot() 时按 parentId 重建，避免
 * 「父 span 尚未结束、其 children 列表不完整」的时序问题。
 */
export class Tracer {
  private readonly enabled: boolean;
  private readonly stack: Span[] = [];
  /** 所有已结束的 span（扁平） */
  private readonly all: Span[] = [];
  private root: Span | null = null;

  constructor(enabled?: boolean) {
    this.enabled = enabled ?? env('LOOP_TRACE', '1') !== '0';
  }

  /** 是否启用（关闭时所有操作退化为 no-op） */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 开启一个 span，自动挂到当前栈顶之下；返回需在结束时 endSpan */
  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    if (!this.enabled) {
      // 关闭时返回一个哨兵 span，调用方代码无需判断 enabled
      return { id: 'noop', name, parentId: null, start: 0, end: 0, status: 'ok', attributes, children: [] };
    }
    const parent = this.stack[this.stack.length - 1] ?? null;
    const span: Span = {
      id: nextId(),
      name,
      parentId: parent?.id ?? null,
      start: performance.now(),
      end: null,
      status: 'ok',
      attributes,
      children: [],
    };
    this.stack.push(span);
    if (!this.root) this.root = span;
    return span;
  }

  /** 结束一个 span，把它从栈弹出并登记到扁平列表 */
  endSpan(span: Span, attributes?: Record<string, unknown>): void {
    if (!this.enabled || span.id === 'noop') return;
    span.end = performance.now();
    if (attributes) Object.assign(span.attributes, attributes);
    // 弹栈：从栈顶找该 span 并移除
    const idx = this.stack.lastIndexOf(span);
    if (idx >= 0) this.stack.splice(idx, 1);
    this.all.push(span);
  }

  /** 把 span 标记为 error */
  setError(span: Span): void {
    if (!this.enabled || span.id === 'noop') return;
    span.status = 'error';
  }

  /** 给 span 附加 usage（用于 llm span） */
  setUsage(span: Span, usage: TokenUsage): void {
    if (!this.enabled || span.id === 'noop') return;
    span.usage = usage;
  }

  /**
   * 在 span 进行中追加属性（内容常在 span 中途产生：审批决策、错误等，
   * 不能只靠 start/end 两时刻捕获）。可在 endSpan 前多次调用累积。
   * span 为 null（调用方未提供）时安全 no-op。
   */
  setAttribute(span: Span | null, key: string, value: unknown): void {
    if (!this.enabled || !span || span.id === 'noop') return;
    span.attributes[key] = value;
  }

  /**
   * 返回根 span（完整树）。
   * 每次调用都按 parentId 从扁平列表重建 children，保证拿到最新结构。
   */
  getRoot(): Span | null {
    if (!this.enabled || !this.root) return null;
    // 重建 children：先把所有 span 的 children 清空，再按 parentId 重新挂载
    const byId = new Map<string, Span>();
    for (const s of this.all) {
      s.children = [];
      byId.set(s.id, s);
    }
    for (const s of this.all) {
      if (s.parentId) {
        byId.get(s.parentId)?.children.push(s);
      }
    }
    return this.root;
  }

  /** 所有已结束 span 的扁平列表副本（供 metrics 聚合使用） */
  getAll(): Span[] {
    return [...this.all];
  }

  /** 聚合所有 span 的 usage（全树求和） */
  totalUsage(): TokenUsage {
    let p = 0;
    let c = 0;
    for (const s of this.all) {
      if (s.usage) {
        p += s.usage.promptTokens;
        c += s.usage.completionTokens;
      }
    }
    return { promptTokens: p, completionTokens: c, totalTokens: p + c };
  }

  /** 总耗时（根 span 的起止差），单位 ms */
  totalDurationMs(): number {
    const r = this.root;
    if (!r || r.end === null) return 0;
    return r.end - r.start;
  }
}

/** 计算 token 用量的成本（基于 /1K token 的价格） */
export function costOf(
  usage: TokenUsage,
  inputPricePer1k: number,
  outputPricePer1k: number,
): number {
  return (usage.promptTokens / 1000) * inputPricePer1k + (usage.completionTokens / 1000) * outputPricePer1k;
}

/** 把一棵 span 树渲染成缩进文本，用于 CLI /trace */
export function renderSpanTree(span: Span | null, indent = 0): string {
  if (!span) return '(无 trace)';
  const pad = '  '.repeat(indent);
  const dur = span.end !== null ? `${span.end - span.start >= 1 ? (span.end - span.start).toFixed(1) : '<1'}ms` : '运行中';
  const usage = span.usage ? ` tokens=${span.usage.totalTokens}` : '';
  const attrs = Object.entries(span.attributes)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  const statusMark = span.status === 'error' ? '❌' : '•';
  const line = `${pad}${statusMark} ${span.name} [${dur}]${usage}${attrs ? ' ' + attrs : ''}`;
  const children = span.children.map((c) => renderSpanTree(c, indent + 1)).join('\n');
  return children ? `${line}\n${children}` : line;
}
