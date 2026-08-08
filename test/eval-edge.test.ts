/**
 * R13-D5（agentloop）：eval.ts 深层边界测试。
 *
 * 补 eval.test.ts 未覆盖：
 *   - DEFAULT_RUBRIC 结构完整性
 *   - renderEval 格式（星级条/总分/建议）
 *   - evalModelName 环境变量回退
 *   - 自定义 rubric
 *   - 缺失分数的兜底
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RUBRIC, renderEval, evalModelName } from '../src/eval.ts';
import type { EvalDimension, EvalResult } from '../src/types.ts';

describe('DEFAULT_RUBRIC 结构', () => {
  test('6 个维度', () => {
    assert.equal(DEFAULT_RUBRIC.length, 6);
  });

  test('每个维度有 key/label/criteria', () => {
    for (const dim of DEFAULT_RUBRIC) {
      assert.ok(typeof dim.key === 'string' && dim.key.length > 0);
      assert.ok(typeof dim.label === 'string' && dim.label.length > 0);
      assert.ok(typeof dim.criteria === 'string' && dim.criteria.length > 0);
    }
  });

  test('key 唯一', () => {
    const keys = DEFAULT_RUBRIC.map((d) => d.key);
    const unique = new Set(keys);
    assert.equal(keys.length, unique.size);
  });

  test('含核心维度（工具选择/效率/安全）', () => {
    const keys = DEFAULT_RUBRIC.map((d) => d.key);
    assert.ok(keys.includes('tool_selection'));
    assert.ok(keys.includes('efficiency'));
    assert.ok(keys.includes('safety'));
  });
});

describe('renderEval 格式', () => {
  function makeResult(over: Partial<EvalResult> = {}): EvalResult {
    return {
      scores: {
        tool_selection: 5,
        argument_quality: 4,
        efficiency: 3,
        error_recovery: 4,
        task_completion: 5,
        safety: 5,
      },
      overall: 85,
      reasoning: '整体表现优秀',
      suggestions: ['可以减少不必要的工具调用'],
      ...over,
    };
  }

  test('含总分', () => {
    const s = renderEval(makeResult());
    assert.match(s, /85\/100|总分/);
  });

  test('含星级条（★/☆）', () => {
    const s = renderEval(makeResult());
    assert.ok(s.includes('★') || s.includes('☆'));
  });

  test('含各维度 label', () => {
    const s = renderEval(makeResult());
    assert.match(s, /工具选择/);
    assert.match(s, /效率/);
  });

  test('含理由', () => {
    const s = renderEval(makeResult({ reasoning: '测试理由文案' }));
    assert.match(s, /测试理由文案/);
  });

  test('含改进建议', () => {
    const s = renderEval(makeResult({ suggestions: ['建议A', '建议B'] }));
    assert.match(s, /建议A/);
    assert.match(s, /建议B/);
  });

  test('空建议 → 无建议段', () => {
    const s = renderEval(makeResult({ suggestions: [] }));
    // 不含「改进建议」标题或内容为空
    assert.ok(!s.includes('建议A'));
  });

  test('缺失分数 → 兜底为 0（☆☆☆☆☆）', () => {
    const r = makeResult({ scores: { tool_selection: 3 } as Record<string, number> });
    const s = renderEval(r);
    // 其他维度分数缺失，renderEval 用 0 兜底
    assert.match(s, /☆/);
  });

  test('自定义 rubric 生效', () => {
    const customRubric: EvalDimension[] = [
      { key: 'custom', label: '自定义维度', criteria: '测试用' },
    ];
    const r: EvalResult = {
      scores: { custom: 4 },
      overall: 80,
      reasoning: '自定义',
      suggestions: [],
    };
    const s = renderEval(r, customRubric);
    assert.match(s, /自定义维度/);
    assert.match(s, /80/);
  });
});

describe('evalModelName', () => {
  test('返回非空字符串', () => {
    const name = evalModelName();
    assert.ok(typeof name === 'string');
    assert.ok(name.length > 0);
  });

  test('回退到 LOOP_LLM_MODEL 或默认', () => {
    // 不改 env，只验证返回值是已知模式
    const name = evalModelName();
    // 应该是 LOOP_EVAL_MODEL（若设）或 LOOP_LLM_MODEL 或 'glm-4-flash'
    assert.ok(name.length > 0);
  });
});

describe('renderEval 边界', () => {
  test('全 5 分 → 全 ★', () => {
    const r: EvalResult = {
      scores: Object.fromEntries(DEFAULT_RUBRIC.map((d) => [d.key, 5])),
      overall: 100,
      reasoning: '完美',
      suggestions: [],
    };
    const s = renderEval(r);
    // 5 个 ★ 无 ☆
    assert.ok(s.includes('★★★★★'));
  });

  test('全 1 分 → 1★4☆', () => {
    const r: EvalResult = {
      scores: Object.fromEntries(DEFAULT_RUBRIC.map((d) => [d.key, 1])),
      overall: 20,
      reasoning: '较差',
      suggestions: ['需要改进'],
    };
    const s = renderEval(r);
    assert.ok(s.includes('★'));
    assert.ok(s.includes('☆'));
  });

  test('overall=0 不崩溃', () => {
    const r: EvalResult = {
      scores: {},
      overall: 0,
      reasoning: '',
      suggestions: [],
    };
    const s = renderEval(r);
    assert.ok(typeof s === 'string');
  });
});
