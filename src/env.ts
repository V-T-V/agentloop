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
