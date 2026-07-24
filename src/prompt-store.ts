/**
 * Meta-Prompting：版本化 prompt 存储 + 选择优化。
 *
 * ⚠️ STANDALONE — 模块已实现并测试，但尚未接入 ralph-loop/long-task 引擎。
 * 接入需要：在 runRalphLoop 中 initPromptStore() + getBest() 替换静态 prompt，
 * 批次后 recordOutcome() + metaOptimize()。这是后续工作。
 *
 * 来源：BuildMVPFast Meta-Prompting 模式——prompt 不再是静态字符串，
 * 而是版本化的、由性能反馈驱动的可进化资产。
 *
 * 架构：
 *   prompt-store.json: {
 *     worker: [
 *       { version: 1, text: "...", evalScore: 72, parentVersion: null },
 *       { version: 2, text: "...", evalScore: 81, parentVersion: 1 },
 *     ],
 *     planner: [...],
 *     finalizer: [...]
 *   }
 *
 * 流程：
 *   1. 读当前最佳版本（evalScore 最高）用于实际执行
 *   2. 跑完任务后，收集 verify passRate + judge score 作为 evalScore
 *   3. meta-optimizer LLM 调用：基于 outcome 提议 prompt delta
 *   4. 新版本加入存储，保留 top-K，回退退步版本
 *
 * 零依赖，文件持久化。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.ts';
import { extractText } from './multimodal.ts';
import type { LLMClient, Message } from './types.ts';

/** prompt 角色 */
export type PromptRole = 'worker' | 'planner' | 'finalizer' | 'critic';

/** 单个版本化的 prompt */
export interface PromptVersion {
  /** 版本号（递增） */
  version: number;
  /** prompt 文本 */
  text: string;
  /** 评估分数（verify passRate + judge overall 的加权平均，0-100） */
  evalScore: number;
  /** 父版本号（用于 lineage 追踪） */
  parentVersion: number | null;
  /** 创建时间（ISO） */
  createdAt: string;
  /** 累积使用次数 */
  useCount: number;
}

/** 存储结构 */
interface PromptStoreData {
  __schema: string;
  version: number;
  prompts: Record<PromptRole, PromptVersion[]>;
}

const SCHEMA_KEY = 'agentloop-prompt-store';
const MAX_VERSIONS_PER_ROLE = 5; // 每个角色保留 top-K 版本

const META_OPTIMIZER_SYSTEM = `你是一个 prompt 优化专家。你的任务是改进一个 AI agent 的系统提示词。

你会收到：
1. 当前的 prompt
2. 最近的任务表现数据（通过率、质量分、常见失败原因）

请基于性能数据提议一个改进版的 prompt。改进应该：
- 针对失败原因修正指令
- 保留有效的部分
- 使指令更明确、更可执行

直接输出改进后的完整 prompt，不要解释。`;

/**
 * 版本化 prompt 存储。文件持久化在 LOOP_PROMPT_DIR（默认 .agentloop/prompts）。
 */
export class PromptStore {
  private readonly dir: string;
  private data: PromptStoreData;

  constructor(dir?: string) {
    this.dir = dir ?? env('LOOP_PROMPT_DIR', '.agentloop/prompts');
    this.data = {
      __schema: SCHEMA_KEY,
      version: 1,
      prompts: { worker: [], planner: [], finalizer: [], critic: [] },
    };
  }

  private get path(): string {
    return join(this.dir, 'prompt-store.json');
  }

  /** 从磁盘加载 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as PromptStoreData;
      if (parsed.__schema === SCHEMA_KEY) {
        this.data = parsed;
      }
    } catch {
      // 文件不存在或损坏，从空开始
    }
  }

  /** 持久化到磁盘（原子写） */
  async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tmp, this.path);
  }

  /**
   * 获取当前最佳版本（evalScore 最高）。
   * 若无版本则返回 fallback（原始静态 prompt）。
   */
  getBest(role: PromptRole, fallback: string): string {
    const versions = this.data.prompts[role] ?? [];
    if (versions.length === 0) return fallback;
    const best = versions.reduce((a, b) => (a.evalScore >= b.evalScore ? a : b));
    best.useCount++;
    return best.text;
  }

  /**
   * 记录一次任务的评估结果，创建新版本（若 score 有改进）。
   */
  recordOutcome(role: PromptRole, promptText: string, evalScore: number): void {
    const versions = this.data.prompts[role] ?? [];
    const lastVersion = versions.length > 0 ? Math.max(...versions.map((v) => v.version)) : 0;
    const bestScore = versions.length > 0 ? Math.max(...versions.map((v) => v.evalScore)) : 0;

    // 只在 score 有改进时记录新版本（选择压力）
    if (evalScore > bestScore || versions.length === 0) {
      versions.push({
        version: lastVersion + 1,
        text: promptText,
        evalScore,
        parentVersion: lastVersion > 0 ? lastVersion : null,
        createdAt: new Date().toISOString(),
        useCount: 0,
      });
      // 保留 top-K（按 evalScore 降序）
      versions.sort((a, b) => b.evalScore - a.evalScore);
      this.data.prompts[role] = versions.slice(0, MAX_VERSIONS_PER_ROLE);
    }
  }

  /** 获取某角色的版本历史（诊断用） */
  getHistory(role: PromptRole): PromptVersion[] {
    return [...(this.data.prompts[role] ?? [])].sort((a, b) => b.version - a.version);
  }

  /** 所有角色的统计摘要 */
  getSummary(): Record<PromptRole, { versions: number; bestScore: number; currentText: string }> {
    const result = {} as Record<PromptRole, { versions: number; bestScore: number; currentText: string }>;
    for (const role of ['worker', 'planner', 'finalizer', 'critic'] as PromptRole[]) {
      const versions = this.data.prompts[role] ?? [];
      result[role] = {
        versions: versions.length,
        bestScore: versions.length > 0 ? Math.max(...versions.map((v) => v.evalScore)) : 0,
        currentText: versions.length > 0 ? versions[0]!.text.slice(0, 80) : '(空)',
      };
    }
    return result;
  }
}

/**
 * Meta-Optimizer：基于任务表现数据提议 prompt 改进。
 */
export async function metaOptimize(
  llm: LLMClient,
  currentPrompt: string,
  outcomes: { passRate: number; avgScore: number; commonFailures: string[] },
  role: PromptRole,
): Promise<string> {
  const userContent =
    `角色：${role}\n\n` +
    `当前 prompt：\n${currentPrompt}\n\n` +
    `最近表现：\n` +
    `  通过率：${outcomes.passRate}%\n` +
    `  平均质量分：${outcomes.avgScore}/100\n` +
    `  常见失败原因：\n${outcomes.commonFailures.map((f) => `    - ${f}`).join('\n')}\n\n` +
    `请基于以上表现数据，改进这个 prompt。`;

  const messages: Message[] = [
    { role: 'system', content: META_OPTIMIZER_SYSTEM },
    { role: 'user', content: userContent },
  ];

  try {
    const result = await llm.chat({ messages, tools: [] });
    return extractText(result.message.content).trim() || currentPrompt;
  } catch {
    return currentPrompt; // 优化失败返回原 prompt
  }
}

/** 单例 PromptStore */
let globalStore: PromptStore | null = null;

export function getPromptStore(): PromptStore {
  if (!globalStore) {
    globalStore = new PromptStore();
  }
  return globalStore;
}

/** 初始化全局 store（入口点调用一次） */
export async function initPromptStore(): Promise<PromptStore> {
  const store = getPromptStore();
  await store.load();
  return store;
}
