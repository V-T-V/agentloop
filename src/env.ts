/**
 * 轻量 .env 加载器（零依赖）。
 *
 * 仅做最朴素的事：读取 .env，按 `KEY=VALUE` 解析，注入到 process.env。
 * 不支持多行值、变量插值等高级特性——本项目用不到。
 *
 * 原样改编自工作区兄弟项目 dashan/shared/env.ts（同源于 agentresearch/src/env.ts）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

/** 解析单行 KEY=VALUE，返回 [key, value] 或 null（注释/空行） */
export function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const eqIndex = trimmed.indexOf('=');
  if (eqIndex <= 0) return null;

  const key = trimmed.slice(0, eqIndex).trim();
  let value = trimmed.slice(eqIndex + 1).trim();

  // 去掉首尾成对的引号
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/** 从 cwd 加载 .env，仅注入未设置的变量（不覆盖已有）。进程内幂等。 */
export function loadEnv(cwd: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  const envPath = resolve(cwd, '.env');
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** 读取一个环境变量，支持默认值 */
export function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

/**
 * 读取一个数值型环境变量。
 *
 * 相比 `Number(env(k, d)) || d` 的常见写法，本函数正确处理合法的 `0`：
 * 后者会把 `0` 当 falsy 吞掉，导致「想设为 0」的配置静默回退到默认值。
 *
 * 规则：
 *   - 变量未设置或为空串 → 返回 fallback
 *   - 解析为 NaN → 返回 fallback（不抛错，保持与 env() 一致的容错语义）
 *   - 解析成功 → 返回该值；若提供 min/max 则钳制到区间内
 *
 * @param min 若给定，返回值不小于 min（先于 max 钳制）
 * @param max 若给定，返回值不大于 max
 */
export function envNumber(key: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (typeof min === 'number' && n < min) return min;
  if (typeof max === 'number' && n > max) return max;
  return n;
}

/**
 * 读取一个整型环境变量（向下取整）。语义同 envNumber，但保证返回整数。
 * 用于「次数/条数」类配置（如重试次数、消息条数），避免传 2.5 之类的小数。
 */
export function envInt(key: string, fallback: number, min?: number, max?: number): number {
  return Math.trunc(envNumber(key, fallback, min, max));
}
