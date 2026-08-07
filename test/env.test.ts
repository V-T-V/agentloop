// D8: env.ts 单元测试（parseLine 纯函数 + env 读取 + envNumber/envInt）
// 此前完全未测

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, env, envNumber, envInt } from '../src/env.ts';

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

// ---- envNumber / envInt（R5-D6 新增：修复 Number(env)||d 吞 0 的 bug）----

/** 设置并记录原值，用完恢复，避免污染其他测试 */
function withEnv(key: string, value: string | undefined, fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    const orig = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      await fn();
    } finally {
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
  };
}

test('envNumber: 未设置返回 fallback', withEnv('T_NUM_A', undefined, () => {
  assert.equal(envNumber('T_NUM_A', 42), 42);
}));

test('envNumber: 空串返回 fallback', withEnv('T_NUM_B', '', () => {
  assert.equal(envNumber('T_NUM_B', 7), 7);
}));

test('envNumber: 合法数字正常解析', withEnv('T_NUM_C', '3.14', () => {
  assert.equal(envNumber('T_NUM_C', 0), 3.14);
}));

test('envNumber: 合法 0 被保留（核心修复点）', withEnv('T_NUM_D', '0', () => {
  // 旧实现 Number(env||'0') || 5 = 0 || 5 = 5（错误吞 0）
  assert.equal(envNumber('T_NUM_D', 5), 0, '0 应被保留而非回退到 fallback');
}));

test('envNumber: 负数保留', withEnv('T_NUM_E', '-10', () => {
  assert.equal(envNumber('T_NUM_E', 0), -10);
}));

test('envNumber: 非数字返回 fallback（不抛错）', withEnv('T_NUM_F', 'abc', () => {
  assert.equal(envNumber('T_NUM_F', 99), 99);
}));

test('envNumber: NaN 字面量返回 fallback', withEnv('T_NUM_G', 'NaN', () => {
  assert.equal(envNumber('T_NUM_G', 8), 8);
}));

test('envNumber: Infinity 返回 fallback（非有限）', withEnv('T_NUM_H', 'Infinity', () => {
  assert.equal(envNumber('T_NUM_H', 3), 3);
}));

test('envNumber: min 钳制（小于 min 返回 min）', withEnv('T_NUM_I', '0', () => {
  assert.equal(envNumber('T_NUM_I', 5, 1), 1, '0 钳制到 min=1');
}));

test('envNumber: max 钳制（大于 max 返回 max）', withEnv('T_NUM_J', '200', () => {
  assert.equal(envNumber('T_NUM_J', 5, undefined, 100), 100);
}));

test('envNumber: min/max 同时给定，值在区间内不钳制', withEnv('T_NUM_K', '50', () => {
  assert.equal(envNumber('T_NUM_K', 5, 0, 100), 50);
}));

test('envNumber: 钳制先于 fallback 判断（NaN 不触发 min 钳制）', withEnv('T_NUM_L', 'abc', () => {
  assert.equal(envNumber('T_NUM_L', 7, 1, 10), 7, 'NaN 时直接 fallback，不被 min 改成 1');
}));

test('envInt: 整数正常解析', withEnv('T_INT_A', '42', () => {
  assert.equal(envInt('T_INT_A', 0), 42);
}));

test('envInt: 小数向下取整', withEnv('T_INT_B', '3.9', () => {
  assert.equal(envInt('T_INT_B', 0), 3);
}));

test('envInt: 负小数向零取整（truncate）', withEnv('T_INT_C', '-2.7', () => {
  assert.equal(envInt('T_INT_C', 0), -2);
}));

test('envInt: 合法 0 保留', withEnv('T_INT_D', '0', () => {
  assert.equal(envInt('T_INT_D', 10), 0);
}));

test('envInt: 未设置返回 fallback', withEnv('T_INT_E', undefined, () => {
  assert.equal(envInt('T_INT_E', 60), 60);
}));

test('envInt: 非数字返回 fallback', withEnv('T_INT_F', 'xyz', () => {
  assert.equal(envInt('T_INT_F', 8), 8);
}));

test('envInt: min 钳制', withEnv('T_INT_G', '-5', () => {
  assert.equal(envInt('T_INT_G', 3, 0), 0);
}));

test('envInt: max 钳制', withEnv('T_INT_H', '999', () => {
  assert.equal(envInt('T_INT_H', 3, undefined, 100), 100);
}));
