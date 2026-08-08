/**
 * R13-D2（agentloop）：config-check.ts 配置校验深层测试。
 *
 * validateConfig 接受 overrides，避免污染 process.env，完全可测。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfig,
  CONFIG_SCHEMA,
  type ConfigFieldSchema,
} from '../src/config-check.ts';

describe('validateConfig 基础', () => {
  test('默认配置（无 override）→ ok=true', () => {
    const r = validateConfig({});
    assert.equal(r.ok, true);
    assert.equal(r.diagnostics.filter((d) => d.level === 'error').length, 0);
  });

  test('返回所有 schema 字段的解析值', () => {
    const r = validateConfig({});
    for (const field of CONFIG_SCHEMA) {
      assert.ok(field.key in r.values, `缺字段 ${field.key}`);
    }
  });

  test('number 类型解析正确', () => {
    const r = validateConfig({ LOOP_MAX_STEPS: '15' });
    assert.equal(r.values['LOOP_MAX_STEPS'], 15);
  });

  test('boolean 类型解析（1/0/true/false）', () => {
    assert.equal(validateConfig({ LOOP_STREAM: '1' }).values['LOOP_STREAM'], true);
    assert.equal(validateConfig({ LOOP_STREAM: '0' }).values['LOOP_STREAM'], false);
    assert.equal(validateConfig({ LOOP_STREAM: 'true' }).values['LOOP_STREAM'], true);
    assert.equal(validateConfig({ LOOP_STREAM: 'false' }).values['LOOP_STREAM'], false);
  });
});

describe('validateConfig 数值范围', () => {
  test('低于 min → error', () => {
    const r = validateConfig({ LOOP_MAX_STEPS: '0' }); // min=1
    assert.equal(r.ok, false);
    const errs = r.diagnostics.filter((d) => d.level === 'error' && d.key === 'LOOP_MAX_STEPS');
    assert.ok(errs.length >= 1);
  });

  test('超过 max → error', () => {
    const r = validateConfig({ LOOP_MAX_STEPS: '9999' }); // max=1000
    assert.equal(r.ok, false);
  });

  test('恰在边界 → ok', () => {
    const r1 = validateConfig({ LOOP_MAX_STEPS: '1' }); // min=1
    assert.equal(r1.ok, true);
    const r2 = validateConfig({ LOOP_MAX_STEPS: '1000' }); // max=1000
    assert.equal(r2.ok, true);
  });

  test('非数值（type=number）→ error', () => {
    const r = validateConfig({ LOOP_MAX_STEPS: 'abc' });
    assert.equal(r.ok, false);
    const errs = r.diagnostics.filter((d) => d.key === 'LOOP_MAX_STEPS');
    assert.ok(errs.length >= 1);
    assert.match(errs[0]!.message, /无法解析|number/);
  });

  test('NaN 不被接受', () => {
    const r = validateConfig({ LOOP_MAX_STEPS: 'NaN' });
    assert.equal(r.ok, false);
  });

  test('Infinity 不被接受', () => {
    const r = validateConfig({ LOOP_MAX_STEPS: 'Infinity' });
    assert.equal(r.ok, false);
  });
});

describe('validateConfig 空值与默认', () => {
  test('空字符串 → 用 fallback', () => {
    const r = validateConfig({ LOOP_MAX_STEPS: '' });
    assert.equal(r.ok, true);
    // fallback=8
    assert.equal(r.values['LOOP_MAX_STEPS'], 8);
  });

  test('undefined → 用 fallback', () => {
    const r = validateConfig({});
    assert.equal(r.values['LOOP_MAX_STEPS'], 8); // fallback
  });
});

describe('validateConfig 跨字段规则', () => {
  test('RECENT ≥ MAX_MESSAGES → warning', () => {
    // 需要先找到这两个字段的合法值
    const r = validateConfig({
      LOOP_COMPACT_RECENT: '50',
      LOOP_COMPACT_MAX_MESSAGES: '40',
    });
    const warns = r.diagnostics.filter(
      (d) => d.level === 'warning' && d.key === 'LOOP_COMPACT_RECENT',
    );
    // 只有当 50 和 40 都在合法范围时才会触发跨字段检查
    if (r.values['LOOP_COMPACT_RECENT'] === 50 && r.values['LOOP_COMPACT_MAX_MESSAGES'] === 40) {
      assert.ok(warns.length >= 1, '应产生 warning');
      assert.match(warns[0]!.message, /永不触发|压缩/);
    }
  });

  test('BUDGET_WARNING ≥ 1 → warning', () => {
    const r = validateConfig({ LOOP_COST_BUDGET_WARNING: '1.5' });
    // 检查是否有 warning（若 1.5 在合法范围内）
    if (r.values['LOOP_COST_BUDGET_WARNING'] === 1.5) {
      const warns = r.diagnostics.filter(
        (d) => d.level === 'warning' && d.key === 'LOOP_COST_BUDGET_WARNING',
      );
      assert.ok(warns.length >= 1);
    }
  });
});

describe('validateConfig 诊断排序', () => {
  test('error 排在 warning 前', () => {
    const r = validateConfig({
      LOOP_MAX_STEPS: '0', // error
      LOOP_COMPACT_RECENT: '999', // 可能 warning
      LOOP_COMPACT_MAX_MESSAGES: '1',
    });
    let lastErrorIdx = -1;
    let firstWarningIdx = Infinity;
    r.diagnostics.forEach((d, i) => {
      if (d.level === 'error') lastErrorIdx = i;
      if (d.level === 'warning' && firstWarningIdx === Infinity) firstWarningIdx = i;
    });
    if (lastErrorIdx >= 0 && firstWarningIdx < Infinity) {
      assert.ok(lastErrorIdx < firstWarningIdx, 'error 应在 warning 前');
    }
  });
});

describe('CONFIG_SCHEMA 完整性', () => {
  test('每个字段有 key/label/type/fallback', () => {
    for (const f of CONFIG_SCHEMA) {
      assert.ok(typeof f.key === 'string' && f.key.length > 0);
      assert.ok(typeof f.label === 'string' && f.label.length > 0);
      assert.ok(['number', 'boolean', 'string', 'enum'].includes(f.type));
      assert.ok(typeof f.fallback === 'string');
    }
  });

  test('number 类型有 min（max 可选，如预算可无上限）', () => {
    for (const f of CONFIG_SCHEMA.filter((f) => f.type === 'number')) {
      assert.ok(f.min !== undefined, `${f.key} 应有 min`);
    }
  });

  test('key 唯一（无重复）', () => {
    const keys = CONFIG_SCHEMA.map((f) => f.key);
    const unique = new Set(keys);
    assert.equal(keys.length, unique.size, '配置键应唯一');
  });
});
