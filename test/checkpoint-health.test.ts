/**
 * R13-D9（agentloop）：检查点健康检查器测试。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCheckpointHealth,
  describeCheckpointHealth,
  canRestore,
  type CheckpointLike,
} from '../src/checkpoint-health.ts';

function validCp(over: Partial<CheckpointLike> = {}): CheckpointLike {
  return {
    version: 1,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    totalUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    step: 3,
    ...over,
  };
}

describe('checkCheckpointHealth', () => {
  test('完整检查点 → healthy', () => {
    const r = checkCheckpointHealth(validCp());
    assert.equal(r.health, 'healthy');
    assert.equal(r.issues.length, 0);
  });

  test('null → corrupt', () => {
    const r = checkCheckpointHealth(null);
    assert.equal(r.health, 'corrupt');
    assert.ok(r.issues.length > 0);
  });

  test('基础类型 → corrupt', () => {
    assert.equal(checkCheckpointHealth(42).health, 'corrupt');
    assert.equal(checkCheckpointHealth('str').health, 'corrupt');
    assert.equal(checkCheckpointHealth(undefined).health, 'corrupt');
  });

  test('缺 version → corrupt', () => {
    const r = checkCheckpointHealth({ messages: [] });
    assert.equal(r.health, 'corrupt');
    assert.ok(r.issues.some((i) => i.includes('version')));
  });

  test('version 非数字 → degraded/corrupt', () => {
    const r = checkCheckpointHealth({ version: '1', messages: [] });
    assert.ok(r.issues.some((i) => i.includes('version')));
  });

  test('messages 非数组 → corrupt', () => {
    const r = checkCheckpointHealth({ version: 1, messages: 'not array' });
    assert.equal(r.health, 'corrupt');
  });

  test('messages 为空 → degraded（结构合法但空）', () => {
    const r = checkCheckpointHealth({ version: 1, messages: [] });
    assert.equal(r.health, 'degraded');
  });

  test('消息缺 role/content → degraded', () => {
    const r = checkCheckpointHealth({
      version: 1,
      messages: [{ role: 'user' }], // 缺 content
    });
    assert.ok(r.issues.some((i) => i.includes('role/content')));
  });

  test('totalUsage.totalTokens 非有限 → degraded', () => {
    const r = checkCheckpointHealth({
      version: 1,
      messages: [{ role: 'user', content: 'x' }],
      totalUsage: { totalTokens: NaN },
    });
    assert.ok(r.issues.some((i) => i.includes('totalTokens')));
  });

  test('totalUsage 可选 → healthy', () => {
    const r = checkCheckpointHealth({
      version: 1,
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(r.health, 'healthy');
  });

  test('step 负数 → degraded', () => {
    const r = checkCheckpointHealth({
      version: 1,
      messages: [{ role: 'user', content: 'x' }],
      step: -1,
    });
    assert.ok(r.issues.some((i) => i.includes('step')));
  });

  test('passedChecks ≤ checkedFields', () => {
    const r = checkCheckpointHealth(validCp());
    assert.ok(r.passedChecks <= r.checkedFields);
  });
});

describe('describeCheckpointHealth', () => {
  test('healthy → ✅', () => {
    const s = describeCheckpointHealth(checkCheckpointHealth(validCp()));
    assert.match(s, /✅/);
  });

  test('corrupt → ❌', () => {
    const s = describeCheckpointHealth(checkCheckpointHealth(null));
    assert.match(s, /❌/);
  });

  test('含通过率', () => {
    const s = describeCheckpointHealth(checkCheckpointHealth(validCp()));
    assert.match(s, /\d+\/\d+/);
  });

  test('有问题 → 含问题列表', () => {
    const r = checkCheckpointHealth({ version: 'bad', messages: 'bad' });
    const s = describeCheckpointHealth(r);
    assert.match(s, /问题/);
  });
});

describe('canRestore', () => {
  test('healthy → true', () => {
    assert.ok(canRestore(checkCheckpointHealth(validCp())));
  });

  test('degraded → true', () => {
    const r = checkCheckpointHealth({ version: 1, messages: [] });
    assert.ok(canRestore(r)); // degraded 可恢复
  });

  test('corrupt → false', () => {
    assert.ok(!canRestore(checkCheckpointHealth(null)));
  });
});
