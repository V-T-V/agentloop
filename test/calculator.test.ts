/**
 * calculator 工具的安全求值测试。
 *
 * 覆盖正常算式、优先级、括号、除零、非法字符、空表达式等边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calculatorTool } from '../src/tools/calculator.ts';

test('简单加减乘除', async () => {
  assert.equal((await calculatorTool.execute({ expression: '1+2' })).output, '1+2 = 3');
  assert.equal((await calculatorTool.execute({ expression: '10-4' })).output, '10-4 = 6');
  assert.equal((await calculatorTool.execute({ expression: '3*4' })).output, '3*4 = 12');
  assert.equal((await calculatorTool.execute({ expression: '8/2' })).output, '8/2 = 4');
});

test('运算符优先级：先乘除后加减', async () => {
  assert.equal((await calculatorTool.execute({ expression: '2+3*4' })).output, '2+3*4 = 14');
  assert.equal((await calculatorTool.execute({ expression: '10-6/2' })).output, '10-6/2 = 7');
});

test('括号改变优先级', async () => {
  assert.equal((await calculatorTool.execute({ expression: '(1+2)*3' })).output, '(1+2)*3 = 9');
  assert.equal((await calculatorTool.execute({ expression: '((2+3))' })).output, '((2+3)) = 5');
});

test('小数与空白', async () => {
  assert.equal(
    (await calculatorTool.execute({ expression: ' 1.5 + 2.5 ' })).output,
    ' 1.5 + 2.5  = 4',
  );
  assert.equal((await calculatorTool.execute({ expression: '3.0/2' })).output, '3.0/2 = 1.5');
});

test('除零报错但不抛出（返回 ok:false）', async () => {
  const r = await calculatorTool.execute({ expression: '1/0' });
  assert.equal(r.ok, false);
  assert.match(r.output, /除零错误/);
});

test('非法字符被拒绝', async () => {
  const r = await calculatorTool.execute({ expression: '1;drop table' });
  assert.equal(r.ok, false);
  assert.match(r.output, /非法字符/);
});

test('字母表达式被拒绝（无代码注入）', async () => {
  const r = await calculatorTool.execute({ expression: 'console.log(1)' });
  assert.equal(r.ok, false);
  assert.match(r.output, /非法字符/);
});

test('括号不匹配报错', async () => {
  assert.equal((await calculatorTool.execute({ expression: '(1+2' })).ok, false);
  assert.equal((await calculatorTool.execute({ expression: '1+2)' })).ok, false);
});

test('空表达式报错', async () => {
  assert.equal((await calculatorTool.execute({ expression: '' })).ok, false);
});

test('支持负数中间结果', async () => {
  // 5-8 = -3
  assert.equal((await calculatorTool.execute({ expression: '5-8' })).output, '5-8 = -3');
});

test('一元负号：开头 / 紧跟运算符 / 紧跟括号', async () => {
  assert.equal((await calculatorTool.execute({ expression: '-1+2' })).output, '-1+2 = 1');
  assert.equal((await calculatorTool.execute({ expression: '3*-2' })).output, '3*-2 = -6');
  assert.equal((await calculatorTool.execute({ expression: '-(2+3)' })).output, '-(2+3) = -5');
  // 2--3 等价 2-(-3) = 5（两个减号：第一个二元，第二个一元）
  assert.equal((await calculatorTool.execute({ expression: '2--3' })).output, '2--3 = 5');
  assert.equal((await calculatorTool.execute({ expression: '-(-5)' })).output, '-(-5) = 5');
});

test('一元正号被忽略', async () => {
  assert.equal((await calculatorTool.execute({ expression: '+5' })).output, '+5 = 5');
  assert.equal((await calculatorTool.execute({ expression: '3*+2' })).output, '3*+2 = 6');
});

test('科学计数法', async () => {
  assert.equal((await calculatorTool.execute({ expression: '1e3' })).output, '1e3 = 1000');
  assert.equal((await calculatorTool.execute({ expression: '1.5e-2' })).output, '1.5e-2 = 0.015');
  assert.equal((await calculatorTool.execute({ expression: '2E3+1' })).output, '2E3+1 = 2001');
});
