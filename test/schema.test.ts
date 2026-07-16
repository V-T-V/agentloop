/**
 * schema.ts 参数校验的测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateToolArgs, formatValidationErrors } from '../src/schema.ts';
import type { ToolParameters } from '../src/types.ts';

const schema: ToolParameters = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
    score: { type: 'number' },
    active: { type: 'boolean' },
    level: { type: 'string', enum: ['low', 'high'] },
  },
  required: ['name'],
};

test('合法参数通过', () => {
  const r = validateToolArgs({ name: '张三', age: 18, score: 9.5, active: true }, schema);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('缺必填字段 → 失败', () => {
  const r = validateToolArgs({ age: 18 }, schema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('name')));
});

test('类型不符 → 失败', () => {
  const r = validateToolArgs({ name: 123 }, schema); // name 应是 string
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('期望 string')));
});

test('integer 拒绝非整数', () => {
  const r = validateToolArgs({ name: 'x', age: 1.5 }, schema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('integer')));
});

test('enum 校验', () => {
  const ok = validateToolArgs({ name: 'x', level: 'high' }, schema);
  assert.equal(ok.ok, true);
  const bad = validateToolArgs({ name: 'x', level: 'medium' }, schema);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('枚举')));
});

test('boolean 校验', () => {
  const r = validateToolArgs({ name: 'x', active: 'yes' }, schema); // 应是 boolean
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('boolean')));
});

test('number 拒绝 NaN', () => {
  const r = validateToolArgs({ name: 'x', score: NaN }, schema);
  assert.equal(r.ok, false);
});

test('未声明字段（undefined）不报错', () => {
  // age 没传且非必填 → 通过
  const r = validateToolArgs({ name: 'x' }, schema);
  assert.equal(r.ok, true);
});

test('非对象参数 → 失败', () => {
  assert.equal(validateToolArgs(null, schema).ok, false);
  assert.equal(validateToolArgs([], schema).ok, false);
  assert.equal(validateToolArgs('string', schema).ok, false);
});

test('array 类型校验 + items', () => {
  const arrSchema: ToolParameters = {
    type: 'object',
    properties: { nums: { type: 'array', items: { type: 'integer' } } },
  };
  assert.equal(validateToolArgs({ nums: [1, 2, 3] }, arrSchema).ok, true);
  assert.equal(validateToolArgs({ nums: [1, 'a', 3] }, arrSchema).ok, false);
});

test('formatValidationErrors：成功时为空串', () => {
  assert.equal(formatValidationErrors({ ok: true, errors: [] }), '');
});

test('formatValidationErrors：失败时拼接错误', () => {
  const s = formatValidationErrors({ ok: false, errors: ['缺 A', '类型错'] });
  assert.match(s, /缺 A/);
  assert.match(s, /类型错/);
});
