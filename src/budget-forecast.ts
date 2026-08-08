/**
 * R13-D7（agentloop）：预算消耗预测器。
 *
 * budget.ts 有累计与阈值检测，但缺「按当前速率还能跑多久」的预测。
 * 本模块补：
 *   - forecastBudget：基于历史消耗速率预测剩余可用步数与时间
 *   - budgetBurnRate：计算平均每步/每分钟的 token 消耗
 *   - recommendBudgetAction：基于预测给出建议（继续/预警/停止）
 *
 * 纯函数，输入已用 token + 步数 + 时间。
 */

export interface BudgetForecastInput {
  /** 已消耗 token */
  spent: number;
  /** 预算上限 */
  limit: number;
  /** 已执行步数 */
  steps: number;
  /** 已运行时间（毫秒） */
  elapsedMs: number;
}

export interface BudgetForecast {
  /** 剩余 token */
  remaining: number;
  /** 消耗占比（0~1） */
  usedRatio: number;
  /** 平均每步 token */
  tokensPerStep: number;
  /** 平均每分钟 token */
  tokensPerMin: number;
  /** 按当前速率预测还能跑多少步 */
  estimatedRemainingSteps: number;
  /** 按当前速率预测还能跑多少分钟 */
  estimatedRemainingMin: number;
  /** 预计总步数（已跑 + 预测） */
  estimatedTotalSteps: number;
  /** 建议动作 */
  action: BudgetAction;
  /** 预测理由 */
  reason: string;
}

export type BudgetAction = '继续' | '预警' | '停止';

/**
 * 预测预算消耗。
 */
export function forecastBudget(input: BudgetForecastInput): BudgetForecast {
  const { spent, limit, steps, elapsedMs } = input;
  const remaining = Math.max(0, limit - spent);
  const usedRatio = limit > 0 ? spent / limit : 0;

  // 消耗速率
  const tokensPerStep = steps > 0 ? spent / steps : 0;
  const elapsedMin = elapsedMs / 60000;
  const tokensPerMin = elapsedMin > 0 ? spent / elapsedMin : 0;

  // 预测剩余
  const estimatedRemainingSteps = tokensPerStep > 0 ? Math.floor(remaining / tokensPerStep) : Infinity;
  const estimatedRemainingMin = tokensPerMin > 0 ? remaining / tokensPerMin : Infinity;
  const estimatedTotalSteps = steps + (estimatedRemainingSteps === Infinity ? 0 : estimatedRemainingSteps);

  // 建议动作
  let action: BudgetAction = '继续';
  let reason: string;
  if (usedRatio >= 1) {
    action = '停止';
    reason = `预算已耗尽（${spent}/${limit} token，${(usedRatio * 100).toFixed(0)}%）`;
  } else if (usedRatio >= 0.8) {
    action = '预警';
    reason = `预算接近上限（${(usedRatio * 100).toFixed(0)}%），剩余约 ${estimatedRemainingSteps} 步`;
  } else if (estimatedRemainingSteps !== Infinity && estimatedRemainingSteps < 3) {
    action = '预警';
    reason = `按当前速率仅剩 ${estimatedRemainingSteps} 步预算`;
  } else {
    reason = `预算充足（${(usedRatio * 100).toFixed(0)}%），可继续 ${estimatedRemainingSteps === Infinity ? '∞' : estimatedRemainingSteps} 步`;
  }

  return {
    remaining,
    usedRatio: Math.min(1, usedRatio),
    tokensPerStep,
    tokensPerMin,
    estimatedRemainingSteps,
    estimatedRemainingMin,
    estimatedTotalSteps,
    action,
    reason,
  };
}

/**
 * 计算消耗速率（tokensPerStep / tokensPerMin）。
 */
export function budgetBurnRate(spent: number, steps: number, elapsedMs: number): {
  tokensPerStep: number;
  tokensPerMin: number;
} {
  return {
    tokensPerStep: steps > 0 ? spent / steps : 0,
    tokensPerMin: elapsedMs > 0 ? spent / (elapsedMs / 60000) : 0,
  };
}

/**
 * 基于预测给出建议动作。
 */
export function recommendBudgetAction(forecast: BudgetForecast): BudgetAction {
  return forecast.action;
}

/**
 * 生成人类可读的预算报告。
 */
export function describeBudgetForecast(f: BudgetForecast): string {
  if (f.remaining === 0 && f.usedRatio >= 1) {
    return `预算耗尽：已用 ${(f.usedRatio * 100).toFixed(0)}%，建议停止。`;
  }
  const steps = f.estimatedRemainingSteps === Infinity ? '∞' : f.estimatedRemainingSteps;
  const mins = f.estimatedRemainingMin === Infinity ? '∞' : f.estimatedRemainingMin.toFixed(1);
  return `预算 ${(f.usedRatio * 100).toFixed(0)}% | 速率 ${f.tokensPerStep.toFixed(0)} tok/步 | 剩余 ${steps} 步 / ${mins} min | 建议：${f.action}`;
}
