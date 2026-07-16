/**
 * 轨迹持久化：把每次 runLoop 的完整 trace（含内容捕获）落盘成 JSON。
 *
 * 复用 storage-file.ts 的设计：原子写（.tmp→rename）、损坏文件容错、列表排序。
 * 路径 LOOP_TRACE_DIR（默认 .agentloop/traces）。
 *
 * 落盘后可跨进程回放（/replay）与离线评估（/eval），无需重新跑一遍。
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { env } from './env.ts';
import type { Span } from './trace.ts';
import type { TokenUsage } from './types.ts';

const SCHEMA_KEY = 'agentloop-trace';

/** 一条持久化的轨迹记录（含完整 span 树 + 运行元信息） */
export interface PersistedTrace {
  __schema: typeof SCHEMA_KEY;
  version: number;
  id: string;
  createdAt: string;
  /** 用户原始问题 */
  userQuestion: string;
  /** 最终答案 */
  answer: string;
  /** 停止原因 */
  stopReason: string;
  /** 步数 */
  steps: number;
  /** 累计 token */
  usage: TokenUsage;
  /** 完整 span 树（含捕获的内容） */
  trace: Span;
}

/** 列表展示用的轻量元信息 */
export interface TraceMeta {
  id: string;
  createdAt: string;
  steps: number;
  answer: string;
  userQuestion: string;
}

export class TraceStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? env('LOOP_TRACE_DIR', '.agentloop/traces');
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async save(record: PersistedTrace): Promise<void> {
    await this.ensureDir();
    const finalPath = this.path(record.id);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmpPath, finalPath);
  }

  async load(id: string): Promise<PersistedTrace | null> {
    try {
      const raw = await readFile(this.path(id), 'utf8');
      const record = JSON.parse(raw) as PersistedTrace;
      if (record.__schema !== SCHEMA_KEY) return null;
      return record;
    } catch {
      return null;
    }
  }

  async list(): Promise<TraceMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const metas: TraceMeta[] = [];
    for (const name of names) {
      // 跳过非 .json 与 .json.tmp 残留文件（save 写的是 <id>.json.tmp）
      if (!name.endsWith('.json') || name.endsWith('.json.tmp')) continue;
      const id = name.slice(0, -5);
      try {
        const raw = await readFile(join(this.dir, name), 'utf8');
        const record = JSON.parse(raw) as PersistedTrace;
        if (record.__schema !== SCHEMA_KEY) continue;
        metas.push({
          id,
          createdAt: record.createdAt,
          steps: record.steps,
          answer: String(record.answer ?? '').slice(0, 60),
          userQuestion: String(record.userQuestion ?? '').slice(0, 40),
        });
      } catch {
        continue; // 损坏文件跳过
      }
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 清理旧轨迹：按时间（maxAgeMs）或数量（maxCount）淘汰。
   * - maxAgeMs：删除创建时间早于 now - maxAgeMs 的记录（0=不限）
   * - maxCount：只保留最近 maxCount 条（按 createdAt 降序，0=不限）
   * 同时清理 .json.tmp 残留文件。
   */
  async prune(options: { maxAgeMs?: number; maxCount?: number }): Promise<{ deleted: number }> {
    let deleted = 0;
    // 1. 清理所有 .json.tmp 残留
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return { deleted: 0 };
    }
    // 2. 按时间淘汰
    const maxAgeMs = options.maxAgeMs ?? 0;
    if (maxAgeMs > 0) {
      const cutoff = Date.now() - maxAgeMs;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(this.dir, name), 'utf8');
          const record = JSON.parse(raw) as PersistedTrace;
          if (new Date(record.createdAt).getTime() < cutoff) {
            await rm(join(this.dir, name), { force: true });
            deleted++;
          }
        } catch {
          // 损坏文件也清掉
          await rm(join(this.dir, name), { force: true }).catch(() => {});
          deleted++;
        }
      }
    }
    // 3. 按数量淘汰
    const maxCount = options.maxCount ?? 0;
    if (maxCount > 0) {
      const metas = await this.list();
      if (metas.length > maxCount) {
        // metas 按 createdAt 降序（最近在前），淘汰末尾的旧记录
        const toDelete = metas.slice(maxCount);
        for (const m of toDelete) {
          await rm(this.path(m.id), { force: true }).catch(() => {});
          deleted++;
        }
      }
    }
    // 4. 清理 tmp 残留
    for (const name of names) {
      if (name.endsWith('.json.tmp')) {
        await rm(join(this.dir, name), { force: true }).catch(() => {});
        deleted++;
      }
    }
    return { deleted };
  }

  async delete(id: string): Promise<void> {
    try {
      await rm(this.path(id), { force: true });
    } catch {
      // 忽略
    }
  }
}

/** 生成轨迹 id（时间戳 + 随机后缀） */
export function newTraceId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}${rand}`;
}

/** 从一次 runLoop 的输出构造持久化记录 */
export function makeTraceRecord(
  id: string,
  output: { answer: string; steps: number; stopReason: string; trace: Span | null; totalUsage: TokenUsage },
  userQuestion: string,
): PersistedTrace | null {
  if (!output.trace) return null;
  return {
    __schema: SCHEMA_KEY,
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    userQuestion,
    answer: output.answer,
    stopReason: output.stopReason,
    steps: output.steps,
    usage: output.totalUsage,
    trace: output.trace,
  };
}
