/**
 * 配置校验系统：启动时检查所有环境变量配置项的类型、范围与互斥性。
 *
 * agentloop 通过环境变量配置压缩、预算、流式、HITL、checkpoint 等，
 * 但散落在各模块的 loadXxxConfig() 中，缺少统一的启动期校验——
 * 错误配置（如 threshold=1.5、maxSteps=-1、budget 配了但 compact 关了）
 * 只会在运行时暴露成诡异行为。
 *
 * 本模块提供：
 * 1. ConfigSchema：声明每个配置键的类型、范围、默认、互斥规则。
 * 2. validateConfig()：读 process.env，按 schema 校验，返回 ConfigReport（错误/警告）。
 * 3. checkAndAbort()：校验失败时打印报告并 process.exit(1)（CLI 启动用）。
 *
 * 零依赖，纯函数式（除 env 读取），可被 test 完整验证。
 */

import { env } from './env.ts';

/** 配置项的类型 */
export type ConfigType = 'number' | 'boolean' | 'string' | 'enum';

/** 单个配置项的 schema */
export interface ConfigFieldSchema {
  /** 环境变量名 */
  key: string;
  /** 展示名（中文） */
  label: string;
  /** 类型 */
  type: ConfigType;
  /** 默认值（字符串形式，与 env 一致） */
  fallback: string;
  /** 数值范围（仅 type=number） */
  min?: number;
  max?: number;
  /** 枚举允许值（仅 type=enum） */
  enum?: string[];
  /** 为 0/空 时是否表示「禁用」（如 budget tokens=0 表示不启用预算） */
  zeroDisables?: boolean;
  /** 说明（写入报告） */
  description?: string;
}

/** 校验结果的单条诊断 */
export interface ConfigDiagnostic {
  /** 严重级别：error 导致拒绝启动，warning 仅提示 */
  level: 'error' | 'warning';
  /** 相关配置键 */
  key: string;
  /** 诊断消息 */
  message: string;
}

/** 一份校验报告 */
export interface ConfigReport {
  /** 所有诊断（error 在前） */
  diagnostics: ConfigDiagnostic[];
  /** 解析后的有效值（key → value） */
  values: Record<string, string | number | boolean>;
  /** 是否通过（无 error） */
  ok: boolean;
}

/** agentloop 全部配置项 schema */
export const CONFIG_SCHEMA: ConfigFieldSchema[] = [
  // —— 主循环 ——
  {
    key: 'LOOP_MAX_STEPS',
    label: '最大推理步数',
    type: 'number',
    fallback: '8',
    min: 1,
    max: 1000,
    description: '单次 runLoop 的最大 Think-Act-Observe 步数',
  },
  {
    key: 'LOOP_STREAM',
    label: '流式输出',
    type: 'boolean',
    fallback: '1',
    description: '是否使用流式（0=关闭，1=开启）',
  },
  // —— 上下文压缩 ——
  {
    key: 'LOOP_TOKEN_BUDGET',
    label: '上下文 token 预算',
    type: 'number',
    fallback: '120000',
    min: 1000,
    max: 10_000_000,
    description: '模型上下文窗口预算（驱动 auto-compact 阈值）',
  },
  {
    key: 'LOOP_COMPACT_THRESHOLD',
    label: '压缩阈值占比',
    type: 'number',
    fallback: '0.85',
    min: 0.1,
    max: 1.0,
    description: 'token 占比达此值触发压缩（0-1）',
  },
  {
    key: 'LOOP_COMPACT_MAX_MESSAGES',
    label: '压缩消息条数阈值',
    type: 'number',
    fallback: '60',
    min: 5,
    max: 10_000,
    description: '消息条数兜底阈值',
  },
  {
    key: 'LOOP_COMPACT_RECENT',
    label: '压缩保留最近 N 条',
    type: 'number',
    fallback: '6',
    min: 0,
    max: 100,
    description: '压缩时保留不压缩的最近窗口',
  },
  // —— 预算 ——
  {
    key: 'LOOP_COST_BUDGET_TOKENS',
    label: '成本预算 token 上限',
    type: 'number',
    fallback: '0',
    min: 0,
    zeroDisables: true,
    description: '单次 runLoop 总 token 上限，0=不启用预算控制',
  },
  {
    key: 'LOOP_COST_BUDGET_PER_K',
    label: '每千 token 费用',
    type: 'number',
    fallback: '0',
    min: 0,
    description: '用于估算成本（美元），不影响停机',
  },
  {
    key: 'LOOP_COST_BUDGET_WARNING',
    label: '预算预警阈值',
    type: 'number',
    fallback: '0.8',
    min: 0,
    max: 1,
    description: '占比达此值预警（0-1）',
  },
  // —— HITL ——
  {
    key: 'LOOP_HITL_MODE',
    label: 'HITL 审批模式',
    type: 'enum',
    fallback: 'auto',
    enum: ['auto', 'strict'],
    description: 'auto=无钩子放行，strict=无钩子拒绝高风险工具',
  },
  // —— 可观测性 ——
  {
    key: 'LOOP_TRACE',
    label: 'Trace 开关',
    type: 'boolean',
    fallback: '1',
    description: '是否记录 span trace（0=关闭）',
  },
  // —— Checkpoint ——
  {
    key: 'LOOP_CHECKPOINT_DIR',
    label: '检查点目录',
    type: 'string',
    fallback: '.agentloop/checkpoints',
    description: '检查点持久化目录',
  },
];

/** 解析一个字符串为指定类型，失败返回 null */
function parseValue(raw: string, type: ConfigType): string | number | boolean | null {
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return raw === '1' || raw.toLowerCase() === 'true';
    case 'string':
      return raw;
    case 'enum':
      return raw;
    default:
      return null;
  }
}

/** 校验单个字段，返回诊断列表 */
function validateField(field: ConfigFieldSchema, raw: string): { diags: ConfigDiagnostic[]; value: string | number | boolean | null } {
  const diags: ConfigDiagnostic[] = [];
  // 空值处理
  if (raw === '' || raw === undefined) {
    return { diags, value: parseValue(field.fallback, field.type) };
  }
  // 类型校验
  const parsed = parseValue(raw, field.type);
  if (parsed === null) {
    diags.push({ level: 'error', key: field.key, message: `${field.label}（${field.key}）=「${raw}」无法解析为 ${field.type}` });
    return { diags, value: null };
  }
  // 数值范围
  if (field.type === 'number' && typeof parsed === 'number') {
    if (field.min !== undefined && parsed < field.min) {
      diags.push({ level: 'error', key: field.key, message: `${field.label}（${field.key}）=${parsed} 低于最小值 ${field.min}` });
    }
    if (field.max !== undefined && parsed > field.max) {
      diags.push({ level: 'error', key: field.key, message: `${field.label}（${field.key}）=${parsed} 超过最大值 ${field.max}` });
    }
  }
  // 枚举校验
  if (field.type === 'enum' && field.enum && !field.enum.includes(raw)) {
    diags.push({ level: 'error', key: field.key, message: `${field.label}（${field.key}）=「${raw}」不在允许值 [${field.enum.join(', ')}] 中` });
  }
  return { diags, value: parsed };
}

/** 互斥/依赖规则校验（跨字段） */
function validateCrossField(values: Record<string, string | number | boolean>): ConfigDiagnostic[] {
  const diags: ConfigDiagnostic[] = [];
  // 规则1：配了预算 token 但预警阈值 > 1 无意义（已在单字段拦）
  // 规则2：LOOP_COMPACT_RECENT 必须 < LOOP_COMPACT_MAX_MESSAGES，否则永远不压缩
  const recent = values['LOOP_COMPACT_RECENT'];
  const maxMsgs = values['LOOP_COMPACT_MAX_MESSAGES'];
  if (typeof recent === 'number' && typeof maxMsgs === 'number' && recent >= maxMsgs) {
    diags.push({
      level: 'warning',
      key: 'LOOP_COMPACT_RECENT',
      message: `压缩保留窗口(${recent}) ≥ 消息阈值(${maxMsgs})，可能导致永不触发压缩`,
    });
  }
  // 规则3：预算预警阈值必须 < 1（若=1 则预警与超限同时，无意义）
  const warning = values['LOOP_COST_BUDGET_WARNING'];
  if (typeof warning === 'number' && warning >= 1) {
    diags.push({
      level: 'warning',
      key: 'LOOP_COST_BUDGET_WARNING',
      message: `预算预警阈值 ${warning} ≥ 1，预警与超限将同时触发`,
    });
  }
  return diags;
}

/**
 * 校验全部配置：读 process.env，按 schema 校验，返回报告。
 * @param overrides 可选：显式传入 env 值（测试用，避免污染 process.env）
 */
export function validateConfig(overrides?: Record<string, string>): ConfigReport {
  const diagnostics: ConfigDiagnostic[] = [];
  const values: Record<string, string | number | boolean> = {};

  for (const field of CONFIG_SCHEMA) {
    const raw = overrides?.[field.key] ?? env(field.key, field.fallback);
    const { diags, value } = validateField(field, raw);
    diagnostics.push(...diags);
    if (value !== null) values[field.key] = value;
  }

  diagnostics.push(...validateCrossField(values));

  // 排序：error 优先
  diagnostics.sort((a, b) => (a.level === 'error' ? -1 : 1) - (b.level === 'error' ? -1 : 1));
  const ok = !diagnostics.some((d) => d.level === 'error');
  return { diagnostics, values, ok };
}

/** 把报告格式化为可读字符串 */
export function formatReport(report: ConfigReport): string {
  const lines: string[] = [];
  if (report.diagnostics.length === 0) {
    lines.push('✅ 配置校验通过，无问题。');
  } else {
    for (const d of report.diagnostics) {
      const icon = d.level === 'error' ? '❌' : '⚠️';
      lines.push(`${icon} [${d.key}] ${d.message}`);
    }
  }
  if (!report.ok) {
    lines.push('');
    lines.push(`共 ${report.diagnostics.filter((d) => d.level === 'error').length} 个错误，启动被拒绝。`);
  }
  return lines.join('\n');
}

/**
 * 校验并退出：CLI 启动入口调用。
 * 校验失败时打印报告并 process.exit(1)。
 * @returns 报告（成功时调用方可继续）
 */
export function checkAndAbort(overrides?: Record<string, string>): ConfigReport {
  const report = validateConfig(overrides);
  if (!report.ok) {
    console.error(formatReport(report));
    process.exit(1);
  }
  return report;
}
