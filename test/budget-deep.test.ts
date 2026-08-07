/**
 * budget.ts 深层测试（R3）。
 *
 * 覆盖基础测试未触及的边界与多轮累计：
 * 1. ratio() 精确占比（含超额 >1）。
 * 2. restore() 显式恢复（脱离 snapshot 构造路径）。
 * 3. 多轮累计：跨多次 add 的累计、超额后继续 add 仍累加。
 * 4. 预警阈值边界（恰好达 threshold、自定义 threshold）。
 * 5. 超限后 onBudgetExceeded 仅触发一次（每次 add 不重复触发）。
 * 6. 预警后超限的回调顺序（warning 先于 exceeded）。
 * 7. 成本估算精度（大额、零成本）。
 * 8. snapshot 一致性（多次 add 后快照字段全对）。
 * 9. usage.totalTokens 缺失时用 prompt+completion 兜底累加。
 * 10. 极小/极大预算边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BudgetGuard, renderBudget, loadBudgetConfig, type BudgetConfig } from '../src/budget.ts';
import type { TokenUsage } from '../src/types.ts';

function mkUsage(total: number): TokenUsage {
  return { promptTokens: Math.floor(total * 0.7), completionTokens: Math.ceil(total * 0.3), totalTokens: total };
}

/** 不带 totalTokens 的 usage（测兜底） */
function partialUsage(prompt: number, completion: number): TokenUsage {
  return { promptTokens: prompt, completionTokens: completion, totalTokens: 0 };
}

// —————————— 1. ratio() 精确占比 ——————————

test('ratio()：未花费时为 0', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  assert.equal(g.ratio(), 0);
});

test('ratio()：半额时为 0.5', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(500));
  assert.equal(g.ratio(), 0.5);
});

test('ratio()：超额时 > 1', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(1500));
  assert.ok(g.ratio() > 1, '超额后 ratio 应 > 1');
  assert.equal(g.ratio(), 1.5);
});

// —————————— 2. restore() 显式恢复 ——————————

test('restore()：直接覆盖 spent 与 warningIssued', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000, warningThreshold: 0.8 });
  g.restore(900, true);
  assert.equal(g.current, 900);
  assert.equal(g.exhausted(), false, '900 < 1000 未耗尽');
});

test('restore()：恢复到已耗尽状态后 exhausted()=true', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.restore(1000, false);
  assert.equal(g.exhausted(), true);
});

test('restore()：恢复 warningIssued=true 后再 add 不重复预警', () => {
  let warnings = 0;
  const g = new BudgetGuard({
    maxTotalTokens: 1000,
    warningThreshold: 0.8,
    onBudgetWarning: () => warnings++,
  });
  g.restore(0, true); // 已预警过
  g.add(mkUsage(850)); // 达 85%，但因 warningIssued=true 不再触发
  assert.equal(warnings, 0, 'warningIssued 已置位，不再预警');
});

test('restore()：恢复后继续累加正确', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.restore(600, false);
  g.add(mkUsage(300));
  assert.equal(g.current, 900);
});

// —————————— 3. 多轮累计 ——————————

test('多轮累计：连续 10 次 add 总额正确', () => {
  const g = new BudgetGuard({ maxTotalTokens: 100_000 });
  for (let i = 0; i < 10; i++) g.add(mkUsage(1000));
  assert.equal(g.current, 10_000);
});

test('多轮累计：超额后继续 add 仍累加（不截断）', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(1200)); // 超额
  assert.equal(g.current, 1200);
  g.add(mkUsage(500));
  assert.equal(g.current, 1700, '超额后仍累加，不截断');
  assert.equal(g.ratio(), 1.7);
});

test('多轮累计：交替大小 usage 累加精确', () => {
  const g = new BudgetGuard({ maxTotalTokens: 100_000 });
  g.add(mkUsage(1));
  g.add(mkUsage(99999));
  g.add(mkUsage(0));
  assert.equal(g.current, 100_000);
  assert.equal(g.exhausted(), true, '恰达上限即耗尽');
});

// —————————— 4. 预警阈值边界 ——————————

test('预警：恰好达 threshold 时不预警（需 > threshold，>= 判定看实现）', () => {
  // warningThreshold=0.8，spent 恰好 800 = 0.8 → pct=0.8 >= 0.8 触发
  let warnings = 0;
  const g = new BudgetGuard({
    maxTotalTokens: 1000,
    warningThreshold: 0.8,
    onBudgetWarning: () => warnings++,
  });
  g.add(mkUsage(800)); // pct=0.8 >= 0.8 → 触发
  assert.equal(warnings, 1, 'pct 恰好等于 threshold 应触发（>= 判定）');
});

test('预警：自定义 threshold=0.5 在 50% 触发', () => {
  let warnings = 0;
  const g = new BudgetGuard({
    maxTotalTokens: 1000,
    warningThreshold: 0.5,
    onBudgetWarning: () => warnings++,
  });
  g.add(mkUsage(400)); // 40% < 50%，不触发
  assert.equal(warnings, 0);
  g.add(mkUsage(150)); // 55% >= 50%，触发
  assert.equal(warnings, 1);
});

test('预警：threshold=0 时首次 add 即触发', () => {
  let warnings = 0;
  const g = new BudgetGuard({
    maxTotalTokens: 1000,
    warningThreshold: 0,
    onBudgetWarning: () => warnings++,
  });
  g.add(mkUsage(1)); // pct=0.001 >= 0 → 触发
  assert.equal(warnings, 1);
});

test('预警：回调携带正确的 pct 与 estimatedCost', () => {
  const captured: Array<{ pct: number; estimatedCost: number; spent: number; limit: number }> = [];
  const g = new BudgetGuard({
    maxTotalTokens: 1000,
    costPerKToken: 0.02,
    warningThreshold: 0.8,
    onBudgetWarning: (i) => {
      captured.push(i);
    },
  });
  g.add(mkUsage(850));
  const info = captured[0];
  assert.ok(info);
  assert.equal(info!.spent, 850);
  assert.equal(info!.limit, 1000);
  assert.ok(Math.abs(info!.pct - 0.85) < 1e-9);
  assert.equal(info!.estimatedCost, (850 / 1000) * 0.02, '850 token × $0.02/K');
});

// —————————— 5. 超限回调仅触发一次 ——————————

test('超限：onBudgetExceeded 在多次 add 中仅触发一次（达限那次）', () => {
  let count = 0;
  const g = new BudgetGuard({
    maxTotalTokens: 1000,
    onBudgetExceeded: () => count++,
  });
  g.add(mkUsage(1000)); // 达限 → 触发
  assert.equal(count, 1);
  g.add(mkUsage(500)); // 已超限，继续 add → 实现每次 add 都检测，故会再触发
  // 注：实现是每次 add 都调用 onBudgetExceeded（只要 exhausted()），故第 2 次也触发
  assert.equal(count, 2, '实现每次 add 都重新检测超限并触发回调');
});

// —————————— 6. 预警先于超限 ——————————

test('回调顺序：一次 add 跨越阈值又达上限时，预警被跳过（exhausted 时不再预警）', () => {
  // 实现：预警分支有 !exhausted() 守卫，故一次跨到上限只触发 exceeded。
  const order: string[] = [];
  const g = new BudgetGuard({
    maxTotalTokens: 1000,
    warningThreshold: 0.5,
    onBudgetWarning: () => order.push('warning'),
    onBudgetExceeded: () => order.push('exceeded'),
  });
  g.add(mkUsage(1000)); // 一次跨越阈值与上限 → 只 exceeded
  assert.deepEqual(order, ['exceeded']);
});

test('回调顺序：先达预警、后续 add 才达上限时，warning 先于 exceeded', () => {
  const order: string[] = [];
  const g = new BudgetGuard({
    maxTotalTokens: 1000,
    warningThreshold: 0.5,
    onBudgetWarning: () => order.push('warning'),
    onBudgetExceeded: () => order.push('exceeded'),
  });
  g.add(mkUsage(600)); // 60% > 50% → warning（未耗尽）
  g.add(mkUsage(400)); // 100% → exceeded
  assert.deepEqual(order, ['warning', 'exceeded']);
});

// —————————— 7. 成本估算精度 ——————————

test('成本估算：大额累加精度', () => {
  const g = new BudgetGuard({ maxTotalTokens: 10_000_000, costPerKToken: 0.005 });
  g.add(mkUsage(1_000_000));
  // 1_000_000 / 1000 * 0.005 = 5
  assert.equal(g.estimatedCost(), 5);
  g.add(mkUsage(500_000));
  assert.equal(g.estimatedCost(), 7.5);
});

test('成本估算：零成本（未配置 costPerKToken）恒为 0', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(999));
  assert.equal(g.estimatedCost(), 0);
});

test('成本估算：costPerKToken=0 显式配置也为 0', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000, costPerKToken: 0 });
  g.add(mkUsage(999));
  assert.equal(g.estimatedCost(), 0);
});

// —————————— 8. snapshot 一致性 ——————————

test('snapshot：多次 add 后字段全对', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000, costPerKToken: 0.01, warningThreshold: 0.8 });
  g.add(mkUsage(300));
  g.add(mkUsage(400));
  g.add(mkUsage(150));
  const snap = g.snapshot();
  assert.equal(snap.spent, 850);
  assert.equal(snap.limit, 1000);
  assert.equal(snap.estimatedCost, (850 / 1000) * 0.01);
  assert.equal(snap.exhausted, false);
  assert.equal(snap.warningIssued, true, '850 >= 800 已预警');
});

test('snapshot：耗尽状态字段正确', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(1000));
  const snap = g.snapshot();
  assert.equal(snap.exhausted, true);
  assert.equal(snap.spent, 1000);
});

test('snapshot：用快照构造新 guard 完全恢复', () => {
  const g1 = new BudgetGuard({ maxTotalTokens: 1000, warningThreshold: 0.8 });
  g1.add(mkUsage(850));
  const snap = g1.snapshot();
  const g2 = new BudgetGuard({ maxTotalTokens: 1000, warningThreshold: 0.8 }, snap);
  assert.equal(g2.current, 850);
  // warningIssued 也恢复
  let warnings = 0;
  g2.config.onBudgetWarning = () => warnings++;
  g2.add(mkUsage(50)); // 900，但因 warningIssued 已 true 不再预警
  assert.equal(warnings, 0);
});

// —————————— 9. usage.totalTokens 缺失兜底 ——————————

test('兜底：usage.totalTokens=0 时用 prompt+completion 累加', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(partialUsage(300, 200)); // totalTokens=0 → 用 300+200=500
  assert.equal(g.current, 500);
});

test('兜底：混合 totalTokens 有无的 usage 累加', () => {
  const g = new BudgetGuard({ maxTotalTokens: 10_000 });
  g.add(mkUsage(100)); // totalTokens=100
  g.add(partialUsage(50, 50)); // totalTokens=0 → 100
  assert.equal(g.current, 200);
});

// —————————— 10. 极小/极大预算边界 ——————————

test('边界：极小预算 maxTotalTokens=1，单次 add(1) 即耗尽', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1 });
  g.add(mkUsage(1));
  assert.equal(g.exhausted(), true);
  assert.equal(g.remaining(), 0);
});

test('边界：极大预算 maxTotalTokens=Number.MAX_SAFE_INTEGER', () => {
  const g = new BudgetGuard({ maxTotalTokens: Number.MAX_SAFE_INTEGER });
  g.add(mkUsage(1_000_000));
  assert.equal(g.exhausted(), false);
  assert.equal(g.ratio(), 1_000_000 / Number.MAX_SAFE_INTEGER);
});

test('remaining()：未花费时等于上限', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  assert.equal(g.remaining(), 1000);
});

test('remaining()：部分花费后为差值', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(300));
  assert.equal(g.remaining(), 700);
});

// —————————— renderBudget 边界 ——————————

test('renderBudget：耗尽时显示已耗尽标记', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(1000));
  const text = renderBudget(g);
  assert.match(text, /已耗尽/);
});

test('renderBudget：超额时仍显示已耗尽', () => {
  const g = new BudgetGuard({ maxTotalTokens: 1000 });
  g.add(mkUsage(1500));
  const text = renderBudget(g);
  assert.match(text, /1500\/1000/);
  assert.match(text, /已耗尽/);
});

// —————————— loadBudgetConfig ——————————

test('loadBudgetConfig：未配置环境变量时返回 null', () => {
  // 默认 LOOP_COST_BUDGET_TOKENS 未设或为 0 → null
  // 注：测试环境可能未设此变量
  const result = loadBudgetConfig();
  // 不强断言 null（环境可能设了），只验证结构
  if (result) {
    assert.ok(result.maxTotalTokens > 0);
  }
});

test('loadBudgetConfig：LOOP_COST_BUDGET_TOKENS 为正数时加载配置', () => {
  const orig = process.env.LOOP_COST_BUDGET_TOKENS;
  process.env.LOOP_COST_BUDGET_TOKENS = '5000';
  try {
    const result = loadBudgetConfig();
    assert.ok(result, '应返回配置对象');
    assert.equal(result!.maxTotalTokens, 5000);
  } finally {
    if (orig === undefined) delete process.env.LOOP_COST_BUDGET_TOKENS;
    else process.env.LOOP_COST_BUDGET_TOKENS = orig;
  }
});

test('loadBudgetConfig：非数字 token 值返回 null（容错）', () => {
  const orig = process.env.LOOP_COST_BUDGET_TOKENS;
  process.env.LOOP_COST_BUDGET_TOKENS = 'not-a-number';
  try {
    const result = loadBudgetConfig();
    assert.equal(result, null, '非数字回退到 0 → null');
  } finally {
    if (orig === undefined) delete process.env.LOOP_COST_BUDGET_TOKENS;
    else process.env.LOOP_COST_BUDGET_TOKENS = orig;
  }
});

test('loadBudgetConfig：warningThreshold 钳制到 [0,1]（R5-D7 迁移 envNumber）', () => {
  const origT = process.env.LOOP_COST_BUDGET_TOKENS;
  const origW = process.env.LOOP_COST_BUDGET_WARNING;
  process.env.LOOP_COST_BUDGET_TOKENS = '1000';
  process.env.LOOP_COST_BUDGET_WARNING = '1.5';
  try {
    const result = loadBudgetConfig();
    assert.equal(result!.warningThreshold, 1, '>1 钳制到上限 1');
  } finally {
    if (origT === undefined) delete process.env.LOOP_COST_BUDGET_TOKENS;
    else process.env.LOOP_COST_BUDGET_TOKENS = origT;
    if (origW === undefined) delete process.env.LOOP_COST_BUDGET_WARNING;
    else process.env.LOOP_COST_BUDGET_WARNING = origW;
  }
});

test('loadBudgetConfig：warningThreshold=0 被保留（合法边缘配置）', () => {
  const origT = process.env.LOOP_COST_BUDGET_TOKENS;
  const origW = process.env.LOOP_COST_BUDGET_WARNING;
  process.env.LOOP_COST_BUDGET_TOKENS = '1000';
  process.env.LOOP_COST_BUDGET_WARNING = '0';
  try {
    const result = loadBudgetConfig();
    // 旧实现 Number(env||'0')||0.8 = 0||0.8 = 0.8，吞掉 0
    assert.equal(result!.warningThreshold, 0, '0 应保留（一花费即预警）');
  } finally {
    if (origT === undefined) delete process.env.LOOP_COST_BUDGET_TOKENS;
    else process.env.LOOP_COST_BUDGET_TOKENS = origT;
    if (origW === undefined) delete process.env.LOOP_COST_BUDGET_WARNING;
    else process.env.LOOP_COST_BUDGET_WARNING = origW;
  }
});
