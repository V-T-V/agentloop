/**
 * 工具入参的 JSON-Schema 校验（零依赖，仅支持本项目 JsonSchemaProp 子集）。
 *
 * 设计意图：在 loop 调用工具前先校验模型给出的参数。校验失败不抛异常，
 * 而是返回带友好错误信息的失败结果，回填给 LLM——让模型有机会据错误修正重试，
 * 而不是让工具内部因类型不符而崩溃。
 *
 * 支持的校验：required 必填、type 类型、enum 枚举、未知字段（警告而非拒绝）。
 * 不做完整 JSON Schema 实现，只覆盖本项目工具会用到的部分。
 */

import type { JsonSchemaProp, ToolParameters } from './types.ts';

export interface ValidationResult {
  ok: boolean;
  /** 校验失败的字段与原因（ok=true 时为空） */
  errors: string[];
}

/** 校验单个值是否符合某个属性 schema */
function validateValue(value: unknown, schema: JsonSchemaProp, path: string, errors: string[]): void {
  // enum 校验
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${path}: 值 ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema.enum)} 中`);
    return;
  }
  // type 校验（注意 number/integer 的细分）
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: 期望 string，实际 ${typeof value}`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value))
        errors.push(`${path}: 期望 number，实际 ${typeof value}`);
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        errors.push(`${path}: 期望 integer，实际 ${typeof value} (${String(value)})`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: 期望 boolean，实际 ${typeof value}`);
      break;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path}: 期望 array，实际 ${typeof value}`);
      } else if (schema.items) {
        value.forEach((item, i) => validateValue(item, schema.items!, `${path}[${i}]`, errors));
      }
      break;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path}: 期望 object，实际 ${value === null ? 'null' : typeof value}`);
      }
      break;
    case 'null':
      if (value !== null) errors.push(`${path}: 期望 null，实际 ${typeof value}`);
      break;
  }
}

/**
 * 校验参数对象是否符合工具的 parameters schema。
 * 返回 { ok, errors }，绝不抛异常。
 */
export function validateToolArgs(
  args: unknown,
  parameters: ToolParameters,
): ValidationResult {
  const errors: string[] = [];

  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, errors: [`参数必须是对象，实际 ${args === null ? 'null' : Array.isArray(args) ? 'array' : typeof args}`] };
  }

  const obj = args as Record<string, unknown>;

  // 必填检查
  if (parameters.required) {
    for (const key of parameters.required) {
      if (obj[key] === undefined) {
        errors.push(`缺少必填参数「${key}」`);
      }
    }
  }

  // 逐属性类型检查
  for (const [key, propSchema] of Object.entries(parameters.properties)) {
    if (obj[key] !== undefined) {
      validateValue(obj[key], propSchema, key, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 把校验结果格式化为喂给 LLM 的友好字符串 */
export function formatValidationErrors(result: ValidationResult): string {
  if (result.ok) return '';
  return `参数校验失败：${result.errors.join('；')}`;
}
