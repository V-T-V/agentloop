// D8: env.ts 单元测试（parseLine 纯函数 + env 读取）
// 此前完全未测

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, env } from '../src/env.ts';

// ---- parseLine ----

test('parseLine: 正常 KEY=VALUE', () => {
  assert.deepEqual(parseLine('API_KEY=abc123'), ['API_KEY', 'abc123']);
});

test('parseLine: 带空格的值', () => {
  assert.deepEqual(parseLine('NAME=hello world'), ['NAME', 'hello world']);
});

test('parseLine: 双引号包裹去引号', () => {
  assert.deepEqual(parseLine('MSG="hello world"'), ['MSG', 'hello world']);
});

test('parseLine: 单引号包裹去引号', () => {
  assert.deepEqual(parseLine("MSG='it''s ok'"), ['MSG', "it''s ok"]);
});

test('parseLine: 值含等号', () => {
  assert.deepEqual(parseLine('URL=http://x.com?a=1&b=2'), ['URL', 'http://x.com?a=1&b=2']);
});

test('parseLine: 空行返回 null', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('   '), null);
  assert.equal(parseLine('\t'), null);
});

test('parseLine: 注释行返回 null', () => {
  assert.equal(parseLine('# 这是注释'), null);
  assert.equal(parseLine('  # 缩进注释'), null);
});

test('parseLine: 无等号返回 null', () => {
  assert.equal(parseLine('NOTHING'), null);
});

test('parseLine: 等号在首位返回 null（无 key）', () => {
  assert.equal(parseLine('=value'), null);
});

test('parseLine: key 前后空格 trim', () => {
  assert.deepEqual(parseLine('  KEY  =value'), ['KEY', 'value']);
});

test('parseLine: 空值', () => {
  assert.deepEqual(parseLine('EMPTY='), ['EMPTY', '']);
});

test('parseLine: 只有一对引号不去（不成对）', () => {
  // 'value（只有开头引号）不匹配成对条件，保留原样
  assert.deepEqual(parseLine("X='value"), ['X', "'value"]);
});

// ---- env ----

test('env: 已存在的环境变量', () => {
  process.env.TEST_ENV_VAR_X = 'hello';
  assert.equal(env('TEST_ENV_VAR_X'), 'hello');
  delete process.env.TEST_ENV_VAR_X;
});

test('env: 不存在返回 fallback', () => {
  assert.equal(env('NONEXISTENT_VAR_ZZZ', 'default'), 'default');
});

test('env: 不存在无 fallback 返回空串', () => {
  assert.equal(env('NONEXISTENT_VAR_ZZZ'), '');
});
