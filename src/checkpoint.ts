/**
 * Durable Execution：检查点持久化与崩溃恢复。
 *
 * 这是让 Agent 能长程运行（8 小时+）的核心基础设施。依据研究归档
 * `research/long-running-agents.md` 的设计：
 *
 * - **Checkpoint-and-Resume**（借鉴 Temporal / Addy Osmani）：在 step 边界
 *   把完整状态快照落盘；崩溃后加载最近快照，从下一 step 继续。
 * - **原子写**（借鉴 FileSessionStore）：先写 .tmp 再 rename，防中途崩溃损坏。
 * - **多代保留**（generational retention）：保留最新 + 前一代，防最新恰好损坏。
 * - **step 末尾快照**：天然自洽点——所有 tool result 已回填，无悬空 tool_call。
 *
 * Diagrid 批判指出「仅 checkpoint 不等于 durable execution」——还需自动故障检测、
 * 编排重启、幂等性。本模块负责「状态持久化 + 恢复」这一层；编排重启由调用方
 * （CLI / workflow runner）负责；幂等性由「step 末尾快照」天然保证
 * （崩溃前已完成的 step 不会重跑，只有崩溃中途的 step 会从头执行）。
 *
 * 零依赖：仅用 node:fs/promises、node:path。
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { env } from './env.ts';
import type { Message, StopReason, TokenUsage } from './types.ts';

const SCHEMA_KEY = 'agentloop-checkpoint';
const CKPT_VERSION = 1;

/** 检查点目录环境变量名 */
export const LOOP_CHECKPOINT_DIR_ENV = 'LOOP_CHECKPOINT_DIR';

/**
 * 一份检查点快照：记录「已完成到哪一步」的完整可恢复状态。
 * 序列化为 JSON 存盘；恢复时直接还原（非事件重放）。
 */
export interface Checkpoint {
  /** schema 标识，加载时校验，防误读其他文件 */
  __schema: typeof SCHEMA_KEY;
  /** 序列化格式版本，便于未来迁移 */
  version: number;
  /** 本次运行的唯一 id（同一任务多次恢复共享同一 id） */
  runId: string;
  /** 已完成的最后一个 step 编号（恢复时从 step + 1 继续） */
  step: number;
  /** 配置的最大步数（恢复时沿用，保证边界一致） */
  maxSteps: number;
  /** 序列化的完整 memory（含 system + 全部消息），可直接重建 Memory */
  messages: Message[];
  /** 累计 token 用量（跨恢复累加，不重置） */
  totalUsage: TokenUsage;
  /** 停止原因；恢复时用于判断是否已完成 */
  stopReason?: StopReason;
  /** 最终答案（若已收敛） */
  answer?: string;
  /** 预算守卫快照（跨恢复延续累计 token 消耗，不重置） */
  budgetSnapshot?: { spent: number; warningIssued: boolean };
  /** 检查点写入时间（ISO） */
  savedAt: string;
}

/** 落盘记录的包装（与 FileSessionStore 风格一致） */
interface PersistedCheckpoint {
  __schema: typeof SCHEMA_KEY;
  version: number;
  data: Checkpoint;
}

/** 创建一份新的检查点（不含 __schema/version 包装，由 save 统一封装） */
export function makeCheckpoint(input: {
  runId: string;
  step: number;
  maxSteps: number;
  messages: Message[];
  totalUsage: TokenUsage;
  stopReason?: StopReason;
  answer?: string;
  budgetSnapshot?: { spent: number; warningIssued: boolean };
}): Checkpoint {
  return {
    __schema: SCHEMA_KEY,
    version: CKPT_VERSION,
    runId: input.runId,
    step: input.step,
    maxSteps: input.maxSteps,
    messages: input.messages,
    totalUsage: input.totalUsage,
    stopReason: input.stopReason,
    answer: input.answer,
    budgetSnapshot: input.budgetSnapshot,
    savedAt: new Date().toISOString(),
  };
}

/**
 * 检查点存储：基于文件的持久化后端。
 *
 * 文件布局（每个 runId 一组文件）：
 *   <dir>/<runId>.json        ← 最新检查点
 *   <dir>/<runId>.json.prev   ← 前一代（防最新损坏；save 时滚动产生）
 *
 * 零依赖、原子写、多代保留。未来可换 SQLite 后端，接口不变。
 */
export class CheckpointStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? env(LOOP_CHECKPOINT_DIR_ENV, '.agentloop/checkpoints');
  }

  /** 某 runId 的最新检查点路径 */
  private path(runId: string): string {
    return join(this.dir, `${runId}.json`);
  }

  /** 某 runId 的前一代检查点路径（回退用） */
  private prevPath(runId: string): string {
    return `${this.path(runId)}.prev`;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * 保存检查点：原子写 + 多代滚动。
   *
   * 流程：先把现有最新文件 rename 为 .prev（滚动），再原子写新文件。
   * 这样任一时刻崩溃，磁盘上至少有一份完整可用的检查点。
   */
  async save(ckpt: Checkpoint): Promise<void> {
    await this.ensureDir();
    const finalPath = this.path(ckpt.runId);
    const prevPath = this.prevPath(ckpt.runId);
    const tmpPath = `${finalPath}.tmp`;

    // 1. 滚动：现有最新 → 前一代（若存在）。先到 tmp 避免占用。
    //    rename 在同盘上是原子的；不存在则忽略错误。
    try {
      await rename(finalPath, prevPath);
    } catch {
      // 首次保存时 finalPath 不存在，忽略
    }

    // 2. 原子写新文件：先 tmp 再 rename
    const record: PersistedCheckpoint = { __schema: SCHEMA_KEY, version: CKPT_VERSION, data: ckpt };
    await writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmpPath, finalPath);
  }

  /**
   * 加载检查点：优先最新，损坏则回退前一代，再失败返回 null（视为全新开始）。
   *
   * 三层容错：
   * 1. 读最新文件 → 解析校验
   * 2. 失败 → 读前一代文件
   * 3. 再失败 → null（调用方全新启动）
   */
  async load(runId: string): Promise<Checkpoint | null> {
    const candidates = [this.path(runId), this.prevPath(runId)];
    for (const p of candidates) {
      const ckpt = await this.tryLoad(p);
      if (ckpt) return ckpt;
    }
    return null;
  }

  /** 尝试读取并解析单个文件，失败返回 null（不抛） */
  private async tryLoad(filePath: string): Promise<Checkpoint | null> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const record = JSON.parse(raw) as PersistedCheckpoint;
      if (record.__schema !== SCHEMA_KEY) return null;
      if (record.version !== CKPT_VERSION) return null;
      if (!record.data || record.data.runId !== record.data.runId) return null;
      return record.data;
    } catch {
      return null;
    }
  }

  /**
   * 判断是否存在未完成的检查点（可用于「是否有可恢复的运行」）。
   * stopReason 非 'final'/'max_steps' 视为未完成。
   */
  async hasResumable(runId: string): Promise<boolean> {
    const ckpt = await this.load(runId);
    if (!ckpt) return false;
    return ckpt.stopReason === undefined || ckpt.stopReason === 'error';
  }

  /** 删除某 runId 的全部检查点（任务彻底完成后清理，可选） */
  async delete(runId: string): Promise<void> {
    const paths = [this.path(runId), this.prevPath(runId), `${this.path(runId)}.tmp`];
    await Promise.all(
      paths.map(async (p) => {
        try {
          await unlink(p);
        } catch {
          // 不存在即忽略
        }
      }),
    );
  }

  /**
   * 列出所有 checkpoint 的 runId（去重，按 savedAt 降序）。
   * 用于诊断与 prune 决策。
   */
  async listRunIds(): Promise<Array<{ runId: string; savedAt: string; step: number; completed: boolean }>> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const seen = new Set<string>();
    const result: Array<{ runId: string; savedAt: string; step: number; completed: boolean }> = [];
    for (const name of names) {
      // 匹配 <runId>.json（排除 .prev 和 .tmp）
      if (!name.endsWith('.json') || name.endsWith('.prev') || name.endsWith('.tmp')) continue;
      const runId = name.slice(0, -5); // 去掉 .json
      if (seen.has(runId)) continue;
      seen.add(runId);
      const ckpt = await this.tryLoad(this.path(runId));
      if (ckpt) {
        result.push({
          runId,
          savedAt: ckpt.savedAt,
          step: ckpt.step,
          completed: isCompleted(ckpt),
        });
      }
    }
    return result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  /**
   * 清理旧 checkpoint：按时间（maxAgeMs）或数量（maxRuns）淘汰。
   * - maxAgeMs：删除 savedAt 早于 now - maxAgeMs 的 run（0=不限）
   * - maxRuns：只保留最近 maxRuns 个 run（按 savedAt 降序，0=不限）
   * - deleteCompleted：是否删除已完成的 checkpoint（默认 true）
   * 同时清理 .json.tmp 残留文件。
   */
  async prune(options: {
    maxAgeMs?: number;
    maxRuns?: number;
    deleteCompleted?: boolean;
  }): Promise<{ deleted: number }> {
    let deleted = 0;
    const runs = await this.listRunIds();
    const deleteCompleted = options.deleteCompleted ?? true;

    // 1. 删除已完成的 checkpoint（默认行为）
    if (deleteCompleted) {
      for (const r of runs) {
        if (r.completed) {
          await this.delete(r.runId);
          deleted++;
        }
      }
    }

    // 2. 按时间淘汰
    const maxAgeMs = options.maxAgeMs ?? 0;
    if (maxAgeMs > 0) {
      const cutoff = Date.now() - maxAgeMs;
      const remaining = deleteCompleted ? runs.filter((r) => !r.completed) : runs;
      for (const r of remaining) {
        if (new Date(r.savedAt).getTime() < cutoff) {
          await this.delete(r.runId);
          deleted++;
        }
      }
    }

    // 3. 按数量淘汰
    const maxRuns = options.maxRuns ?? 0;
    if (maxRuns > 0) {
      const freshRuns = deleteCompleted ? runs.filter((r) => !r.completed) : runs;
      if (freshRuns.length > maxRuns) {
        // freshRuns 已按 savedAt 降序，淘汰末尾的旧记录
        const toDelete = freshRuns.slice(maxRuns);
        for (const r of toDelete) {
          await this.delete(r.runId);
          deleted++;
        }
      }
    }

    // 4. 清理 .json.tmp 残留
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return { deleted };
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        await unlink(join(this.dir, name)).catch(() => {});
        deleted++;
      }
    }
    return { deleted };
  }
}

/**
 * 生成一个运行 id：时间戳 + 随机后缀。
 * 同一逻辑任务的多段执行（含恢复）共享同一 runId。
 */
export function newRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `run_${ts}_${rand}`;
}

/** 持久化校验：一个 messages 数组是否可安全重建 Memory（首条须为 system） */
export function isRecoverable(ckpt: Checkpoint): boolean {
  if (!ckpt.messages || ckpt.messages.length === 0) return false;
  const first = ckpt.messages[0];
  return !!first && first.role === 'system';
}

/**
 * 校验检查点是否「已完成」（恢复入口据此决定是续跑还是直接返回结果）。
 * final / max_steps 都视为完成；error / budget_exceeded / undefined 视为可续跑。
 */
export function isCompleted(ckpt: Checkpoint): boolean {
  return ckpt.stopReason === 'final' || ckpt.stopReason === 'max_steps';
}
