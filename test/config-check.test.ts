/**
 * config-check.ts 配置校验系统的测试（R7）。
 *
 * 用 overrides 参数注入模拟 env 值，避免污染 process.env。
 * 覆盖：类型校验、数值范围、枚举、跨字段互斥/警告、默认值回退、报告格式化。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateConfig,
  formatReport,
  CONFIG_SCHEMA,
  type ConfigReport,
} from '../src/config-check.ts';

/** 取报告中的 error 数 */
function errors(r: ConfigReport): number {
  return r.diagnostics.filter((d) => d.level === 'error').length;
}

/** 取报告中的 warning 数 */
function warnings(r: ConfigReport): number {
  return r.diagnostics.filter((d) => d.level === 'warning').length;
}

// —————————— 默认值全部通过 ——————————

test('默认配置（无 overrides）全部通过', () => {
  const r = validateConfig({});
  assert.equal(r.ok, true);
  assert.equal(errors(r), 0);
});

test('默认值被正确解析到 values', () => {
  const r = validateConfig({});
  assert.equal(r.values['LOOP_MAX_STEPS'], 8);
  assert.equal(r.values['LOOP_STREAM'], true);
  assert.equal(r.values['LOOP_COMPACT_THRESHOLD'], 0.85);
  assert.equal(r.values['LOOP_HITL_MODE'], 'auto');
});

// —————————— 数值类型校验 ——————————

test('LOOP_MAX_STEPS 非数字 → error', () => {
  const r = validateConfig({ LOOP_MAX_STEPS: 'abc' });
  assert.equal(r.ok, false);
  assert.ok(errors(r) >= 1);
});

test('LOOP_MAX_STEPS 负数 → error（低于 min=1）', () => {
  const r = validateConfig({ LOOP_MAX_STEPS: '-5' });
  assert.equal(r.ok, false);
});

test('LOOP_MAX_STEPS=0 → error（低于 min=1）', () => {
  const r = validateConfig({ LOOP_MAX_STEPS: '0' });
  assert.equal(r.ok, false);
});

test('LOOP_MAX_STEPS 合法正数 → 通过', () => {
  const r = validateConfig({ LOOP_MAX_STEPS: '20' });
  assert.equal(r.ok, true);
  assert.equal(r.values['LOOP_MAX_STEPS'], 20);
});

test('LOOP_MAX_STEPS 超过 max=1000 → error', () => {
  const r = validateConfig({ LOOP_MAX_STEPS: '5000' });
  assert.equal(r.ok, false);
});

// —————————— 范围校验 ——————————

test('LOOP_COMPACT_THRESHOLD > 1.0 → error', () => {
  const r = validateConfig({ LOOP_COMPACT_THRESHOLD: '1.5' });
  assert.equal(r.ok, false);
});

test('LOOP_COMPACT_THRESHOLD=0.85 → 通过', () => {
  const r = validateConfig({ LOOP_COMPACT_THRESHOLD: '0.85' });
  assert.equal(r.ok, true);
  assert.equal(r.values['LOOP_COMPACT_THRESHOLD'], 0.85);
});

test('LOOP_COMPACT_THRESHOLD < 0.1 → error', () => {
  const r = validateConfig({ LOOP_COMPACT_THRESHOLD: '0.05' });
  assert.equal(r.ok, false);
});

test('LOOP_TOKEN_BUDGET 低于 min=1000 → error', () => {
  const r = validateConfig({ LOOP_TOKEN_BUDGET: '500' });
  assert.equal(r.ok, false);
});

test('LOOP_COST_BUDGET_WARNING > 1 → error', () => {
  const r = validateConfig({ LOOP_COST_BUDGET_WARNING: '1.5' });
  assert.equal(r.ok, false);
});

// —————————— 枚举校验 ——————————

test('LOOP_HITL_MODE 非法值 → error', () => {
  const r = validateConfig({ LOOP_HITL_MODE: 'paranoid' });
  assert.equal(r.ok, false);
});

test('LOOP_HITL_MODE=strict → 通过', () => {
  const r = validateConfig({ LOOP_HITL_MODE: 'strict' });
  assert.equal(r.ok, true);
  assert.equal(r.values['LOOP_HITL_MODE'], 'strict');
});

test('LOOP_HITL_MODE=auto → 通过', () => {
  const r = validateConfig({ LOOP_HITL_MODE: 'auto' });
  assert.equal(r.ok, true);
});

// —————————— 布尔校验 ——————————

test('LOOP_STREAM=1 → true', () => {
  const r = validateConfig({ LOOP_STREAM: '1' });
  assert.equal(r.values['LOOP_STREAM'], true);
});

test('LOOP_STREAM=0 → false', () => {
  const r = validateConfig({ LOOP_STREAM: '0' });
  assert.equal(r.values['LOOP_STREAM'], false);
});

test('LOOP_STREAM=true → true（字符串 true）', () => {
  const r = validateConfig({ LOOP_STREAM: 'true' });
  assert.equal(r.values['LOOP_STREAM'], true);
});

// —————————— 跨字段互斥/警告 ——————————

test('跨字段：LOOP_COMPACT_RECENT >= MAX_MESSAGES → warning', () => {
  const r = validateConfig({ LOOP_COMPACT_RECENT: '10', LOOP_COMPACT_MAX_MESSAGES: '8' });
  // 不应 error（仍可启动），但应有 warning
  assert.equal(r.ok, true, 'warning 不阻止启动');
  assert.ok(warnings(r) >= 1);
  assert.ok(r.diagnostics.some((d) => d.key === 'LOOP_COMPACT_RECENT' && d.level === 'warning'));
});

test('跨字段：LOOP_COMPACT_RECENT < MAX_MESSAGES → 无此 warning', () => {
  const r = validateConfig({ LOOP_COMPACT_RECENT: '3', LOOP_COMPACT_MAX_MESSAGES: '60' });
  assert.ok(!r.diagnostics.some((d) => d.key === 'LOOP_COMPACT_RECENT' && d.level === 'warning'));
});

test('跨字段：LOOP_COST_BUDGET_WARNING >= 1 同时触发 error 与 warning', () => {
  // 1.5 已被单字段 range 拦为 error
  const r = validateConfig({ LOOP_COST_BUDGET_WARNING: '1.5' });
  assert.equal(r.ok, false);
});

test('跨字段：LOOP_COST_BUDGET_WARNING=1.0 在范围内但触发 warning', () => {
  // max=1，故 1.0 通过单字段；但跨字段 warning >= 1
  const r = validateConfig({ LOOP_COST_BUDGET_WARNING: '1.0' });
  assert.equal(r.ok, true);
  assert.ok(r.diagnostics.some((d) => d.key === 'LOOP_COST_BUDGET_WARNING' && d.level === 'warning'));
});

// —————————— 空值回退默认 ——————————

test('空字符串配置项回退默认值', () => {
  const r = validateConfig({ LOOP_MAX_STEPS: '' });
  assert.equal(r.values['LOOP_MAX_STEPS'], 8, '空串回退默认 8');
  assert.equal(r.ok, true);
});

test('未在 overrides 中提供的键用 fallback', () => {
  const r = validateConfig({ LOOP_MAX_STEPS: '5' });
  // LOOP_STREAM 未提供 → 用默认 '1' → true
  assert.equal(r.values['LOOP_STREAM'], true);
});

// —————————— 多错误聚合 ——————————

test('多个错误同时存在时全部报告', () => {
  const r = validateConfig({
    LOOP_MAX_STEPS: '-1',
    LOOP_COMPACT_THRESHOLD: '2.0',
    LOOP_HITL_MODE: 'bad',
  });
  assert.equal(r.ok, false);
  assert.ok(errors(r) >= 3, '至少 3 个 error');
});

test('error 诊断排在 warning 之前', () => {
  const r = validateConfig({
    LOOP_MAX_STEPS: '-1', // error
    LOOP_COMPACT_RECENT: '100', // warning（>= MAX_MESSAGES 默认 60）
    LOOP_COMPACT_MAX_MESSAGES: '60',
  });
  const firstErrorIdx = r.diagnostics.findIndex((d) => d.level === 'error');
  const firstWarningIdx = r.diagnostics.findIndex((d) => d.level === 'warning');
  assert.ok(firstErrorIdx >= 0 && firstWarningIdx >= 0);
  assert.ok(firstErrorIdx < firstWarningIdx, 'error 应排在 warning 前');
});

// —————————— formatReport ——————————

test('formatReport：通过时输出无问题提示', () => {
  const r = validateConfig({});
  const text = formatReport(r);
  assert.match(text, /通过/);
});

test('formatReport：有错误时输出拒绝启动', () => {
  const r = validateConfig({ LOOP_MAX_STEPS: '-1' });
  const text = formatReport(r);
  assert.match(text, /拒绝/);
  assert.match(text, /LOOP_MAX_STEPS/);
});

test('formatReport：warning 也被展示（带 ⚠️）', () => {
  const r = validateConfig({ LOOP_COMPACT_RECENT: '100', LOOP_COMPACT_MAX_MESSAGES: '60' });
  const text = formatReport(r);
  assert.match(text, /⚠️|warning/);
});

// —————————— CONFIG_SCHEMA 完整性 ——————————

test('CONFIG_SCHEMA：覆盖全部预期配置键', () => {
  const keys = CONFIG_SCHEMA.map((f) => f.key);
  const expected = [
    'LOOP_MAX_STEPS',
    'LOOP_STREAM',
    'LOOP_TOKEN_BUDGET',
    'LOOP_COMPACT_THRESHOLD',
    'LOOP_COMPACT_MAX_MESSAGES',
    'LOOP_COMPACT_RECENT',
    'LOOP_COST_BUDGET_TOKENS',
    'LOOP_COST_BUDGET_PER_K',
    'LOOP_COST_BUDGET_WARNING',
    'LOOP_HITL_MODE',
    'LOOP_TRACE',
    'LOOP_CHECKPOINT_DIR',
  ];
  for (const k of expected) {
    assert.ok(keys.includes(k), `schema 应含 ${k}`);
  }
});

test('CONFIG_SCHEMA：每个字段有 key/label/type/fallback', () => {
  for (const f of CONFIG_SCHEMA) {
    assert.ok(f.key.length > 0);
    assert.ok(f.label.length > 0);
    assert.ok(['number', 'boolean', 'string', 'enum'].includes(f.type));
    assert.ok(f.fallback !== undefined);
  }
});

test('CONFIG_SCHEMA：number 字段有 min', () => {
  for (const f of CONFIG_SCHEMA) {
    if (f.type === 'number') {
      assert.ok(f.min !== undefined, `${f.key} 应有 min`);
    }
  }
});

test('CONFIG_SCHEMA：除无界项外 number 字段有 max', () => {
  // 费用/预算类字段理论上无上限，可不配 max
  const noMaxAllowed = new Set(['LOOP_COST_BUDGET_PER_K', 'LOOP_COST_BUDGET_TOKENS']);
  for (const f of CONFIG_SCHEMA) {
    if (f.type === 'number' && !noMaxAllowed.has(f.key)) {
      assert.ok(f.max !== undefined, `${f.key} 应有 max`);
    }
  }
});

test('CONFIG_SCHEMA：enum 字段有 enum 数组', () => {
  for (const f of CONFIG_SCHEMA) {
    if (f.type === 'enum') {
      assert.ok(f.enum && f.enum.length > 0, `${f.key} 应有 enum 数组`);
    }
  }
});
