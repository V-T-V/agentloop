/**
 * 客观验证层（verify-by-assertion）。
 *
 * 与 LLM-as-judge（eval.ts，主观质量分）互补：提供确定性的硬成败判定。
 * 业界依据：SWE-bench 的 verify-by-execution（跑测试判定对错）、GAIA 的
 * ground-truth 匹配、MorphLLM 的「success rate verified on end state」。
 *
 * 为什么需要客观验证：LLM-judge 有随机性，且 [arXiv「corrupt success」] 指出
 * agent 可能「技术上完成任务但方式有问题」，纯主观打分抓不到——需要客观断言兜底。
 *
 * 设计：任务定义时附带一组断言（assertions），跑完后 verifyTask() 逐条判定，
 * 返回每条 pass/fail + 总通过率。全部确定性、可重复、无 LLM 调用。
 */

import { extractTrajectory } from './trajectory.ts';
import type { RunLoopOutput } from './loop.ts';

/** 单条验证断言（判定的最小单元） */
export type Assertion =
  | { type: 'answer_contains'; value: string; description?: string }
  | { type: 'answer_not_contains'; value: string; description?: string }
  | { type: 'answer_regex'; value: string; description?: string }
  | {
      type: 'answer_number_in_range';
      min?: number;
      max?: number;
      /** 提取该关键词附近的数字（而非第一个）。解决「答案含年份/其它数字干扰」问题 */
      near?: string;
      description?: string;
    }
  | {
      type: 'answer_all_numbers_in_range';
      min?: number;
      max?: number;
      description?: string;
    }
  | { type: 'tool_used'; name: string; description?: string }
  | { type: 'tool_not_used'; name: string; description?: string }
  | { type: 'steps_at_most'; max: number; description?: string }
  | { type: 'stop_reason'; value: 'final' | 'max_steps' | 'error'; description?: string }
  | { type: 'answer_json_path'; path: string; equals?: unknown; contains?: string; description?: string }
  | { type: 'answer_length'; min?: number; max?: number; description?: string }
  | { type: 'answer_matches_schema'; schema: import('./types.ts').JsonSchemaProp; description?: string }
  | { type: 'custom'; check: (result: RunLoopOutput) => boolean; description?: string };

/** 单条断言的判定结果 */
export interface AssertionResult {
  /** 断言的人类可读描述 */
  description: string;
  /** 是否通过 */
  passed: boolean;
  /** 判定细节（失败时说明原因） */
  detail: string;
}

/** 一次任务的完整验证结果 */
export interface VerifyResult {
  /** 逐条断言结果 */
  results: AssertionResult[];
  /** 通过的断言数 */
  passed: number;
  /** 总断言数 */
  total: number;
  /** 通过率 0-100 */
  passRate: number;
  /** 是否全部通过（passed === total） */
  allPassed: boolean;
}

/** 从断言提取人类可读描述（缺 description 时用 type+value 兜底） */
function describe(a: Assertion): string {
  if (a.description) return a.description;
  switch (a.type) {
    case 'answer_contains':
      return `答案应包含「${a.value}」`;
    case 'answer_not_contains':
      return `答案不应包含「${a.value}」`;
    case 'answer_regex':
      return `答案应匹配正则 /${a.value}/`;
    case 'answer_number_in_range':
      return `答案数值（${a.near ? `近「${a.near}」` : '首个'}）应在 [${a.min ?? '-∞'}, ${a.max ?? '+∞'}]`;
    case 'answer_all_numbers_in_range':
      return `答案中所有数值都应在 [${a.min ?? '-∞'}, ${a.max ?? '+∞'}]`;
    case 'tool_used':
      return `应使用工具「${a.name}」`;
    case 'tool_not_used':
      return `不应使用工具「${a.name}」`;
    case 'steps_at_most':
      return `步数应 ≤ ${a.max}`;
    case 'stop_reason':
      return `停止原因应为「${a.value}」`;
    case 'answer_json_path':
      return `JSON 路径「${a.path}」${a.equals !== undefined ? `应为 ${JSON.stringify(a.equals)}` : a.contains ? `应包含「${a.contains}」` : '应有值'}`;
    case 'answer_length':
      return `答案长度应 ${a.min !== undefined ? `≥ ${a.min}` : ''} ${a.max !== undefined ? `且 ≤ ${a.max}` : ''}`.trim();
    case 'answer_matches_schema':
      return `答案应符合给定 JSON Schema`;
    case 'custom':
      return '自定义检查';
  }
}

/**
 * 简单 JSONPath 取值：支持 $.field.sub[0].name 格式。
 * 不是完整 JSONPath 实现，但覆盖常见用例（点号 + 数组下标）。
 */
function jsonPathGet(obj: unknown, path: string): unknown {
  if (!path.startsWith('$')) return undefined;
  // 去 $ 前缀，按 . 和 [] 分割
  const parts = path
    .slice(1)
    .split(/\.|\[(\d+)\]/)
    .filter((p) => p !== undefined && p !== '');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      cur = cur[Number(p)];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 把答案文本当 JSON 解析（容错：先 strip markdown fence） */
function parseAnswerJson(answer: string): unknown | null {
  let text = answer.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    // 尝试提取第一个 { ... }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 从答案文本中提取数字。
 * - 有 near 关键词时：取该关键词**之后**窗口内的数字（符合「还有 X 天」「共 X」「价格 X」等自然语言）。
 *   之所以只取「之后」而非「前后」：答案常含前置干扰数字（年份、序号），目标数值一般在关键词后。
 * - 无 near 时：取第一个数字（兼容旧行为）。
 */
function extractNumber(text: string, near?: string): number | null {
  if (near) {
    const idx = text.indexOf(near);
    if (idx < 0) return null;
    const window = text.slice(idx + near.length, idx + near.length + 30);
    const nums = [...window.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    return nums.length > 0 ? nums[0]! : null;
  }
  const m = text.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** 提取答案中所有数字（用于 all_numbers_in_range） */
function extractAllNumbers(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

/** 从 trace 提取用过的工具名集合 */
function usedTools(result: RunLoopOutput): Set<string> {
  if (!result.trace) return new Set();
  const events = extractTrajectory(result.trace);
  const names = new Set<string>();
  for (const e of events) {
    if (e.kind === 'tool') {
      const toolName = e.attributes['tool'];
      if (typeof toolName === 'string') names.add(toolName);
    }
  }
  return names;
}

/** 判定单条断言 */
function checkAssertion(a: Assertion, result: RunLoopOutput): AssertionResult {
  const description = describe(a);
  const answer = result.answer;
  switch (a.type) {
    case 'answer_contains': {
      const passed = answer.includes(a.value);
      return { description, passed, detail: passed ? '已包含' : `答案中未找到「${a.value}」` };
    }
    case 'answer_not_contains': {
      const passed = !answer.includes(a.value);
      return { description, passed, detail: passed ? '未包含（符合）' : `答案中仍含「${a.value}」` };
    }
    case 'answer_regex': {
      let passed = false;
      let detail = '正则错误';
      try {
        const re = new RegExp(a.value);
        passed = re.test(answer);
        detail = passed ? '匹配成功' : '未匹配';
      } catch (e) {
        detail = `正则非法：${e instanceof Error ? e.message : String(e)}`;
      }
      return { description, passed, detail };
    }
    case 'answer_number_in_range': {
      const num = extractNumber(answer, a.near);
      if (num === null) {
        return { description, passed: false, detail: a.near ? `答案中未找到「${a.near}」附近的数字` : '答案中未提取到数字' };
      }
      const okMin = a.min === undefined || num >= a.min;
      const okMax = a.max === undefined || num <= a.max;
      const passed = okMin && okMax;
      return { description, passed, detail: `提取数值 ${num}${a.near ? `（近「${a.near}」）` : ''}，${passed ? '在范围内' : '超出范围'}` };
    }
    case 'answer_all_numbers_in_range': {
      const nums = extractAllNumbers(answer);
      if (nums.length === 0) return { description, passed: false, detail: '答案中无数字' };
      const outOfRange = nums.filter((n) => (a.min !== undefined && n < a.min) || (a.max !== undefined && n > a.max));
      const passed = outOfRange.length === 0;
      return {
        description,
        passed,
        detail: passed ? `共 ${nums.length} 个数值均在范围内` : `${outOfRange.length}/${nums.length} 超范围：${outOfRange.slice(0, 3).join(', ')}`,
      };
    }
    case 'tool_used': {
      const tools = usedTools(result);
      const passed = tools.has(a.name);
      return { description, passed, detail: passed ? '已使用' : `未使用（实际用了：${[...tools].join(', ') || '无'}）` };
    }
    case 'tool_not_used': {
      const tools = usedTools(result);
      const passed = !tools.has(a.name);
      return { description, passed, detail: passed ? '未使用（符合）' : `不应使用却用了「${a.name}」` };
    }
    case 'steps_at_most': {
      const passed = result.steps <= a.max;
      return { description, passed, detail: `实际 ${result.steps} 步，${passed ? '≤' : '>'} ${a.max}` };
    }
    case 'stop_reason': {
      const passed = result.stopReason === a.value;
      return { description, passed, detail: `实际「${result.stopReason}」` };
    }
    case 'answer_json_path': {
      const json = parseAnswerJson(answer);
      if (json === null) return { description, passed: false, detail: '答案不是合法 JSON' };
      const val = jsonPathGet(json, a.path);
      if (val === undefined) return { description, passed: false, detail: `路径「${a.path}」不存在` };
      if (a.equals !== undefined) {
        const passed = JSON.stringify(val) === JSON.stringify(a.equals);
        return { description, passed, detail: `路径值 ${JSON.stringify(val)}，${passed ? '匹配' : `期望 ${JSON.stringify(a.equals)}`}` };
      }
      if (a.contains !== undefined) {
        const valStr = typeof val === 'string' ? val : JSON.stringify(val);
        const passed = valStr.includes(a.contains);
        return { description, passed, detail: `路径值含「${a.contains}」：${passed ? '是' : '否'}` };
      }
      // 无 equals/contains：只要路径有值即通过
      return { description, passed: true, detail: `路径「${a.path}」存在值 ${JSON.stringify(val)}` };
    }
    case 'answer_length': {
      const len = answer.length;
      const okMin = a.min === undefined || len >= a.min;
      const okMax = a.max === undefined || len <= a.max;
      const passed = okMin && okMax;
      return { description, passed, detail: `答案长度 ${len}，${passed ? '在范围内' : '超出范围'}` };
    }
    case 'answer_matches_schema': {
      const json = parseAnswerJson(answer);
      if (json === null) return { description, passed: false, detail: '答案不是合法 JSON，无法校验 schema' };
      // 简化校验：检查 type 是否匹配（完整 schema 校验超出范围）
      const expectedType = a.schema.type;
      const actualType = Array.isArray(json) ? 'array' : json === null ? 'null' : typeof json;
      const passed = actualType === expectedType;
      return { description, passed, detail: `类型「${actualType}」${passed ? '匹配' : `应为「${expectedType}」`}` };
    }
    case 'custom': {
      let passed = false;
      let detail = '检查抛错';
      try {
        passed = a.check(result);
        detail = passed ? '自定义检查通过' : '自定义检查未通过';
      } catch (e) {
        detail = `自定义检查异常：${e instanceof Error ? e.message : String(e)}`;
      }
      return { description, passed, detail };
    }
  }
}

/**
 * 对一次任务运行结果做客观验证。
 * 逐条判定断言，返回通过率。纯确定性、无 LLM 调用、可重复。
 */
export function verifyTask(result: RunLoopOutput, assertions: Assertion[]): VerifyResult {
  const results = assertions.map((a) => checkAssertion(a, result));
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  return {
    results,
    passed,
    total,
    passRate: total === 0 ? 100 : Math.round((passed / total) * 100),
    allPassed: total > 0 && passed === total,
  };
}

/** 把验证结果渲染成可读文本 */
export function renderVerify(v: VerifyResult): string {
  const lines: string[] = [];
  const icon = v.allPassed ? '✅' : v.passRate >= 60 ? '⚠️' : '❌';
  lines.push(`${icon} 客观验证：${v.passed}/${v.total} 通过（${v.passRate}%）`);
  for (const r of v.results) {
    lines.push(`  ${r.passed ? '✓' : '✗'} ${r.description} — ${r.detail}`);
  }
  return lines.join('\n');
}
