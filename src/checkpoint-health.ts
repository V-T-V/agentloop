/**
 * R13-D9（agentloop）：检查点健康检查器。
 *
 * checkpoint.ts 有序列化/反序列化，但缺「检查点完整性校验」——
 * 恢复前验证检查点是否损坏（缺字段/版本不符/消息丢失）。
 *
 * 纯函数。
 */

import type { Message, TokenUsage } from './types.ts';

/** 检查点健康状态 */
export type CheckpointHealth = 'healthy' | 'degraded' | 'corrupt';

/** 健康检查结果 */
export interface CheckpointReport {
  health: CheckpointHealth;
  /** 发现的问题列表 */
  issues: string[];
  /** 检查的字段数 */
  checkedFields: number;
  /** 通过的检查数 */
  passedChecks: number;
}

/** 检查点最小结构（与 checkpoint.ts 的 Checkpoint 兼容） */
export interface CheckpointLike {
  version?: number;
  messages?: Message[];
  totalUsage?: TokenUsage;
  stopReason?: string;
  answer?: string;
  step?: number;
}

/**
 * 校验检查点完整性。
 */
export function checkCheckpointHealth(cp: unknown): CheckpointReport {
  const issues: string[] = [];
  let checkedFields = 0;
  let passedChecks = 0;

  // 1. 基本类型
  checkedFields++;
  if (cp === null || typeof cp !== 'object') {
    issues.push('检查点非对象（null 或基础类型）');
    return { health: 'corrupt', issues, checkedFields, passedChecks };
  }
  passedChecks++;

  const obj = cp as CheckpointLike;

  // 2. version
  checkedFields++;
  if (obj.version === undefined) {
    issues.push('缺 version 字段');
  } else if (typeof obj.version !== 'number') {
    issues.push(`version 非数字：${typeof obj.version}`);
  } else {
    passedChecks++;
  }

  // 3. messages
  checkedFields++;
  if (obj.messages === undefined) {
    issues.push('缺 messages 字段');
  } else if (!Array.isArray(obj.messages)) {
    issues.push('messages 非数组');
  } else if (obj.messages.length === 0) {
    issues.push('messages 为空（无对话历史）');
    passedChecks++; // 结构合法但空
  } else {
    // 每条消息应有 role/content
    const invalid = obj.messages.filter(
      (m) => !m || typeof m.role !== 'string' || typeof m.content !== 'string',
    );
    if (invalid.length > 0) {
      issues.push(`${invalid.length} 条消息缺 role/content`);
    } else {
      passedChecks++;
    }
  }

  // 4. totalUsage
  checkedFields++;
  if (obj.totalUsage !== undefined) {
    const u = obj.totalUsage;
    if (typeof u !== 'object' || u === null) {
      issues.push('totalUsage 非对象');
    } else if (typeof u.totalTokens !== 'number' || !Number.isFinite(u.totalTokens)) {
      issues.push('totalUsage.totalTokens 缺失或非有限数');
    } else {
      passedChecks++;
    }
  } else {
    passedChecks++; // totalUsage 可选
  }

  // 5. step
  checkedFields++;
  if (obj.step !== undefined) {
    if (typeof obj.step !== 'number' || obj.step < 0) {
      issues.push(`step 非法：${obj.step}`);
    } else {
      passedChecks++;
    }
  } else {
    passedChecks++; // 可选
  }

  // 判定健康度
  let health: CheckpointHealth = 'healthy';
  if (issues.some((i) => i.includes('非对象') || i.includes('缺 version') || i.includes('messages 非数组'))) {
    health = 'corrupt';
  } else if (issues.length > 0) {
    health = 'degraded';
  }

  return { health, issues, checkedFields, passedChecks };
}

/**
 * 生成检查点健康摘要。
 */
export function describeCheckpointHealth(report: CheckpointReport): string {
  const emoji = report.health === 'healthy' ? '✅' : report.health === 'degraded' ? '⚠️' : '❌';
  const parts = [
    `${emoji} 检查点${report.health === 'healthy' ? '健康' : report.health === 'degraded' ? '降级' : '损坏'}`,
    `${report.passedChecks}/${report.checkedFields} 检查通过`,
  ];
  if (report.issues.length > 0) {
    parts.push(`问题：${report.issues.join('；')}`);
  }
  return parts.join(' | ');
}

/**
 * 判断检查点是否可安全恢复。
 */
export function canRestore(report: CheckpointReport): boolean {
  return report.health !== 'corrupt';
}
