/**
 * 成本/Token 预算控制：8 小时长任务的「刹车系统」。
 *
 * 长任务最大现实风险是费用失控——一次 sub-agent 扇出可能瞬间烧掉大量 token。
 * BudgetGuard 在每次 LLM 调用后累加 usage，达阈值即触发优雅终止。
 *
 * 设计依据：Diagrid durable execution 三要素之「自动故障检测」——
 * 预算超限也是一种「故障」，需要被检测并触发停止。
 *
 * 工作流：
 *   每次 LLM 调用 → accumulate(usage) → 若 exhausted() 则 stopReason='budget_exceeded'
 *   → 落盘 checkpoint → 优雅返回（下次 resume 可调整预算后续跑）
 *
 * 零依赖，纯内存状态，可序列化（供 checkpoint 持久化累计值）。
 */

import { envNumber } from './env.ts';
import type { TokenUsage } from './types.ts';

/** 预算配置：控制长任务的 token/费用上限 */
export interface BudgetConfig {
  /** 最大总 token 数（prompt + completion 累计）。硬上限，达此即停。 */
  maxTotalTokens: number;
  /** 每千 token 费用（美元），仅用于展示估算成本，不影响停机逻辑。0 表示不跟踪成本。 */
  costPerKToken?: number;
  /** 预算耗尽时的回调（如记日志、发告警） */
  onBudgetExceeded?: (info: { spent: number; limit: number; estimatedCost: number }) => void;
  /** 预警阈值（占比 0-1，如 0.8 = 80% 时预警）。默认 0.8 */
  warningThreshold?: number;
  /** 预警回调（未达硬上限但接近时触发，默认仅一次） */
  onBudgetWarning?: (info: { spent: number; limit: number; pct: number; estimatedCost: number }) => void;
}

/**
 * 从环境变量加载预算配置；未配置则返回 null（禁用预算控制）。
 *
 * 用 envNumber 替代 Number(env)||d：后者会把合法的 0 吞掉。
 * - maxTotalTokens: 0/未设/非数字 → 返回 null（禁用预算）
 * - warningThreshold: envNumber 钳制到 [0,1]；0 表示「一花费就预警」（合法边缘配置）
 * - costPerKToken: 0 → undefined（不计费，仅 token 限额）
 */
export function loadBudgetConfig(): BudgetConfig | null {
  const maxTokens = envNumber('LOOP_COST_BUDGET_TOKENS', 0);
  if (maxTokens <= 0) return null;
  return {
    maxTotalTokens: maxTokens,
    costPerKToken: envNumber('LOOP_COST_BUDGET_PER_K', 0) || undefined,
    warningThreshold: envNumber('LOOP_COST_BUDGET_WARNING', 0.8, 0, 1),
  };
}

/** 预算状态快照（可序列化，供 checkpoint 持久化） */
export interface BudgetSnapshot {
  spent: number;
  limit: number;
  estimatedCost: number;
  exhausted: boolean;
  warningIssued: boolean;
}

/**
 * 预算守卫：累加器 + 阈值检测。
 *
 * 用法：
 *   const guard = new BudgetGuard(config);
 *   guard.add(usage);            // 每次 LLM 调用后
 *   if (guard.exhausted()) { ... 停止 ... }
 *
 * 跨恢复延续：把 snapshot 存入 checkpoint，resume 时 new BudgetGuard(config, snapshot) 恢复累计。
 */
export class BudgetGuard {
  private spent = 0;
  private warningIssued = false;
  readonly config: BudgetConfig;

  constructor(config: BudgetConfig, snapshot?: BudgetSnapshot) {
    this.config = config;
    if (snapshot) {
      this.spent = snapshot.spent;
      this.warningIssued = snapshot.warningIssued;
    }
  }

  /** 累加一次 LLM 调用的 token 用量，返回累加后的总额 */
  add(usage: TokenUsage | null): number {
    if (!usage) return this.spent;
    this.spent += usage.totalTokens || (usage.promptTokens + usage.completionTokens);

    // 预警检测（仅触发一次）
    const threshold = this.config.warningThreshold ?? 0.8;
    const pct = this.spent / this.config.maxTotalTokens;
    if (!this.warningIssued && pct >= threshold && !this.exhausted()) {
      this.warningIssued = true;
      this.config.onBudgetWarning?.({
        spent: this.spent,
        limit: this.config.maxTotalTokens,
        pct,
        estimatedCost: this.estimatedCost(),
      });
    }

    // 超限检测
    if (this.exhausted()) {
      this.config.onBudgetExceeded?.({
        spent: this.spent,
        limit: this.config.maxTotalTokens,
        estimatedCost: this.estimatedCost(),
      });
    }
    return this.spent;
  }

  /** 当前已花费 token */
  get current(): number {
    return this.spent;
  }

  /** 预算是否已耗尽 */
  exhausted(): boolean {
    return this.spent >= this.config.maxTotalTokens;
  }

  /** 剩余 token 预算（不小于 0） */
  remaining(): number {
    return Math.max(0, this.config.maxTotalTokens - this.spent);
  }

  /** 当前占比（0-1+） */
  ratio(): number {
    return this.spent / this.config.maxTotalTokens;
  }

  /** 估算已花费成本（美元），未配置 costPerKToken 则返回 0 */
  estimatedCost(): number {
    const perK = this.config.costPerKToken ?? 0;
    return (this.spent / 1000) * perK;
  }

  /**
   * 从持久化的值恢复累计状态（checkpoint resume 用）。
   * 直接覆盖 spent 和 warningIssued，使预算跨恢复延续。
   */
  restore(spent: number, warningIssued: boolean): void {
    this.spent = spent;
    this.warningIssued = warningIssued;
  }

  /** 导出快照（供 checkpoint 持久化） */
  snapshot(): BudgetSnapshot {
    return {
      spent: this.spent,
      limit: this.config.maxTotalTokens,
      estimatedCost: this.estimatedCost(),
      exhausted: this.exhausted(),
      warningIssued: this.warningIssued,
    };
  }
}

/** 渲染预算状态为 CLI 友好字符串 */
export function renderBudget(guard: BudgetGuard | null): string {
  if (!guard) return '';
  const pct = (guard.ratio() * 100).toFixed(1);
  const cost = guard.estimatedCost();
  const costStr = cost > 0 ? ` ≈ $${cost.toFixed(4)}` : '';
  const status = guard.exhausted() ? '⛔ 已耗尽' : `✅ ${pct}%`;
  return `预算：${guard.current}/${guard.config.maxTotalTokens} tokens（${status}${costStr}）`;
}
