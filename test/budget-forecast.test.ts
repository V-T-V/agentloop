/**
 * R13-D7（agentloop）：预算消耗预测器测试。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  forecastBudget,
  budgetBurnRate,
  recommendBudgetAction,
  describeBudgetForecast,
} from '../src/budget-forecast.ts';

describe('forecastBudget', () => {
  test('空运行（spent=0）→ 继续，充足', () => {
    const f = forecastBudget({ spent: 0, limit: 10000, steps: 0, elapsedMs: 0 });
    assert.equal(f.usedRatio, 0);
    assert.equal(f.action, '继续');
    assert.equal(f.remaining, 10000);
  });

  test('消耗 50% → 继续', () => {
    const f = forecastBudget({ spent: 5000, limit: 10000, steps: 5, elapsedMs: 60000 });
    assert.ok(Math.abs(f.usedRatio - 0.5) < 1e-9);
    assert.equal(f.action, '继续');
  });

  test('消耗 80% → 预警', () => {
    const f = forecastBudget({ spent: 8000, limit: 10000, steps: 8, elapsedMs: 80000 });
    assert.equal(f.action, '预警');
  });

  test('消耗 100% → 停止', () => {
    const f = forecastBudget({ spent: 10000, limit: 10000, steps: 10, elapsedMs: 100000 });
    assert.equal(f.action, '停止');
    assert.equal(f.remaining, 0);
  });

  test('超限（spent > limit）→ 停止，remaining=0', () => {
    const f = forecastBudget({ spent: 12000, limit: 10000, steps: 10, elapsedMs: 100000 });
    assert.equal(f.action, '停止');
    assert.equal(f.remaining, 0);
    assert.ok(f.usedRatio <= 1); // 封顶 1
  });

  test('tokensPerStep 正确', () => {
    const f = forecastBudget({ spent: 1000, limit: 10000, steps: 5, elapsedMs: 60000 });
    assert.equal(f.tokensPerStep, 200);
  });

  test('tokensPerMin 正确', () => {
    const f = forecastBudget({ spent: 6000, limit: 100000, steps: 10, elapsedMs: 120000 });
    // 6000 token / 2 min = 3000 tok/min
    assert.equal(f.tokensPerMin, 3000);
  });

  test('estimatedRemainingSteps 正确', () => {
    // 200 tok/步，剩余 5000 → 25 步
    const f = forecastBudget({ spent: 5000, limit: 10000, steps: 25, elapsedMs: 60000 });
    assert.equal(f.estimatedRemainingSteps, 25);
  });

  test('steps=0 → tokensPerStep=0, estSteps=Infinity', () => {
    const f = forecastBudget({ spent: 0, limit: 10000, steps: 0, elapsedMs: 0 });
    assert.equal(f.tokensPerStep, 0);
    assert.equal(f.estimatedRemainingSteps, Infinity);
  });

  test('剩余 <3 步 → 预警（即使 <80%）', () => {
    // 1000 tok/步，剩 2000 token → 2 步
    const f = forecastBudget({ spent: 98000, limit: 100000, steps: 98, elapsedMs: 100000 });
    assert.equal(f.action, '预警');
  });

  test('limit=0 → usedRatio 封顶 0', () => {
    const f = forecastBudget({ spent: 100, limit: 0, steps: 1, elapsedMs: 1000 });
    assert.equal(f.usedRatio, 0); // limit=0 时 usedRatio=0
  });
});

describe('budgetBurnRate', () => {
  test('基本速率', () => {
    const r = budgetBurnRate(1000, 5, 60000);
    assert.equal(r.tokensPerStep, 200);
    assert.equal(r.tokensPerMin, 1000);
  });

  test('steps=0 → tokensPerStep=0', () => {
    assert.equal(budgetBurnRate(100, 0, 60000).tokensPerStep, 0);
  });

  test('elapsedMs=0 → tokensPerMin=0', () => {
    assert.equal(budgetBurnRate(100, 5, 0).tokensPerMin, 0);
  });
});

describe('recommendBudgetAction', () => {
  test('透传 forecast.action', () => {
    const f = forecastBudget({ spent: 5000, limit: 10000, steps: 5, elapsedMs: 60000 });
    assert.equal(recommendBudgetAction(f), f.action);
  });
});

describe('describeBudgetForecast', () => {
  test('耗尽 → 含「耗尽」', () => {
    const f = forecastBudget({ spent: 10000, limit: 10000, steps: 10, elapsedMs: 100000 });
    const s = describeBudgetForecast(f);
    assert.match(s, /耗尽|停止/);
  });

  test('非空 → 含百分比与速率', () => {
    const f = forecastBudget({ spent: 3000, limit: 10000, steps: 3, elapsedMs: 60000 });
    const s = describeBudgetForecast(f);
    assert.match(s, /%/);
    assert.match(s, /tok/);
  });

  test('含建议动作', () => {
    const f = forecastBudget({ spent: 5000, limit: 10000, steps: 5, elapsedMs: 60000 });
    const s = describeBudgetForecast(f);
    assert.match(s, /继续/);
  });

  test('输出为非空字符串', () => {
    const f = forecastBudget({ spent: 0, limit: 10000, steps: 0, elapsedMs: 0 });
    const s = describeBudgetForecast(f);
    assert.ok(typeof s === 'string' && s.length > 0);
  });
});
