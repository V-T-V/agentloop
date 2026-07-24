#!/usr/bin/env tsx
/**
 * 长程任务运行器：目标 8 小时不中断执行。
 *
 * 这是 research/long-running-agents.md 第六节「8 小时任务执行架构」的落地实现。
 * 核心思路：把一个长程任务拆成多个**阶段（phase）**，每阶段是一个独立的 runLoop
 * （自带 checkpoint-and-resume），阶段间产出落盘。即使第 7 小时崩溃，也能从最近
 * checkpoint 续跑。
 *
 * 三层架构：
 *   1. 外层 supervisor：自动重试 + 崩溃恢复（runLoop 内部异常 → 等待 → 重试同 runId）
 *   2. 阶段编排：把大任务拆成阶段列表，逐个执行，每阶段产出入库
 *   3. runLoop + durable：单阶段内的逐步 checkpoint-and-resume
 *
 * 用法：
 *   # 定义长任务（见 long-tasks/ 目录）
 *   npx tsx src/long-task.ts long-tasks/example.json
 *
 *   # 崩溃后恢复（同 task id 自动检测 checkpoint 续跑）
 *   npx tsx src/long-task.ts long-tasks/example.json
 *
 *   # 强制全新开始（忽略已有 checkpoint）
 *   npx tsx src/long-task.ts long-tasks/example.json --fresh
 *
 * 关键设计：
 * - maxSteps 调到很大（默认 200/阶段），靠 auto-compact 控制上下文不爆。
 * - 每阶段产出存入 phase 结果目录，下阶段可读取上阶段产出作为输入。
 * - runLoop 异常（如 LLM 超时）自动重试 N 次，每次从 checkpoint 续跑。
 */

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CheckpointStore } from './checkpoint.ts';
import { runLoop } from './loop.ts';
import { prepareRuntime } from './runtime.ts';

/** 单个阶段的定义 */
export interface PhaseSpec {
  /** 阶段名（用于展示与结果文件名） */
  name: string;
  /** 本阶段的系统提示 */
  system: string;
  /** 本阶段的用户指令（可用 {{prevOutput}} 引用上一阶段产出） */
  prompt: string;
  /** 本阶段最大步数（默认 50） */
  maxSteps?: number;
  /**
   * 本阶段时间预算（毫秒）。Karpathy Rule 3「Fixed time window per iteration」。
   * 超时则中断本阶段,checkpoint 已保存的进度不丢（下次 resume 续跑剩余步骤）。
   * 不传则无时限（靠 maxSteps 兜底）。
   */
  timeoutMs?: number;
}

/** 长任务定义 */
export interface LongTaskSpec {
  /** 任务 id（用作 checkpoint runId 前缀，崩溃恢复的关键） */
  id: string;
  /** 任务名 */
  name: string;
  /** 总体描述（展示用） */
  description: string;
  /** 阶段列表（顺序执行） */
  phases: PhaseSpec[];
  /**
   * Karpathy Rule 4「Keep only improvements」：评分函数定义。
   * 传入则启用「最佳保留」——每次最终产出与历史 best 比分,仅当更优时覆盖 best-result.json。
   * scoreFn 是对答案打分的 JS 表达式（变量：answer, prevOutput）,返回数值。
   * 例: "answer.length" 或 "(answer.match(/\\d+/g)||[]).length"
   * 不传则禁用最佳保留（覆盖式保存）。
   */
  score?: {
    /** 打分表达式（new Function 求值，变量 answer/prevOutput 可用） */
    expr: string;
    /** 分数越高越优（true，默认）还是越低越优（false） */
    higherIsBetter?: boolean;
  };
}

/** 单个阶段的执行结果（落盘） */
interface PhaseResult {
  name: string;
  answer: string;
  steps: number;
  stopReason: string;
  phase: number;
  /** 是否因时间预算耗尽而中断（Karpathy Rule 3）——下次 resume 会重跑此阶段 */
  timedOut?: boolean;
}

/** 任务级结果（汇总落盘） */
interface TaskResult {
  taskId: string;
  taskName: string;
  startedAt: string;
  finishedAt: string;
  phases: PhaseResult[];
  finalAnswer: string;
}

const RESULTS_DIR = '.agentloop/long-task-results';

/** 结果目录：每个任务一个子目录，存阶段产出 */
function taskResultsDir(taskId: string): string {
  return join(RESULTS_DIR, taskId);
}

/** 渲染带变量替换的 prompt（{{prevOutput}} → 上一阶段答案） */
function renderPrompt(prompt: string, prevOutput: string): string {
  return prompt.replaceAll('{{prevOutput}}', prevOutput);
}

/**
 * Karpathy Rule 4「Keep only improvements」：最佳结果追踪器。
 *
 * 贪心爬山：每次任务产出经验证后打分,与历史 best 比,仅当更优时覆盖 best-result.json。
 * 这是「跑一夜还能持续改进」的核心——避免迭代中劣化结果覆盖掉之前的最佳。
 */
export class BestTracker {
  private readonly path: string;
  private readonly higherIsBetter: boolean;

  constructor(resultsDir: string, taskId: string, higherIsBetter = true) {
    this.path = join(resultsDir, 'best-result.json');
    this.higherIsBetter = higherIsBetter;
  }

  /** 对答案打分（执行用户提供的 score.expr） */
  static score(expr: string, answer: string, prevOutput: string): number {
    try {
      const fn = new Function('answer', 'prevOutput', `"use strict"; return (${expr});`);
      const val = fn(answer, prevOutput);
      return typeof val === 'number' && Number.isFinite(val) ? val : 0;
    } catch {
      return 0;
    }
  }

  /** 当前最佳（无则 null） */
  async current(): Promise<{ answer: string; score: number; updatedAt: string } | null> {
    if (!existsSync(this.path)) return null;
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * 尝试更新最佳：仅当新分数优于历史最佳（或无历史）时覆盖。
   * 返回是否更新成功。
   */
  async maybeUpdate(answer: string, score: number): Promise<boolean> {
    const best = await this.current();
    const isBetter =
      !best || (this.higherIsBetter ? score > best.score : score < best.score);
    if (isBetter) {
      const record = { answer, score, updatedAt: new Date().toISOString() };
      await writeFile(this.path, JSON.stringify(record, null, 2), 'utf8');
      return true;
    }
    return false;
  }
}

/**
 * 带自动重试的 runLoop 执行器：runLoop 内部异常（LLM 超时等）自动重试。
 * 每次重试复用同 runId，从 checkpoint 续跑——这就是「崩溃不丢进度」的核心。
 *
 * 支持 Karpathy Rule 3「Fixed time window」：传入 timeoutMs 则用 Promise.race
 * 限时。超时后 runLoop 被「放弃等待」（JS 无法强杀 Promise），但已落盘的 checkpoint
 * 保留进度——下次 resume 自动续跑。超时视为本阶段未完成，抛 TimeoutError。
 */
export async function runLoopWithRetry(
  input: Parameters<typeof runLoop>[0],
  opts: { maxRetries?: number; retryDelayMs?: number; timeoutMs?: number } = {},
): ReturnType<typeof runLoop> {
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 5000;
  const timeoutMs = opts.timeoutMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (timeoutMs && timeoutMs > 0) {
        // Karpathy Rule 3:时间预算竞速。超时抛 TimeoutError,checkpoint 已保存。
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new TimeoutError(`阶段超时（${timeoutMs}ms）`)), timeoutMs);
        });
        return await Promise.race([runLoop(input), timeout]);
      }
      return await runLoop(input);
    } catch (e) {
      lastError = e;
      // 超时不再重试（时间预算已耗尽）——直接向上抛,让调用方决定是否 resume
      if (e instanceof TimeoutError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < maxRetries) {
        console.error(`  ⚠️ 阶段执行失败（第${attempt}次）：${msg}`);
        console.error(`  🔄 ${retryDelayMs / 1000}s 后从 checkpoint 续跑（第${attempt + 1}次尝试）…`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
      } else {
        console.error(`  ❌ 重试 ${maxRetries} 次仍失败：${msg}`);
      }
    }
  }
  throw lastError;
}

/** 时间预算超时错误（Karpathy Rule 3） */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

async function runLongTask(spec: LongTaskSpec, fresh: boolean): Promise<void> {
  // H7: 复用共享运行时抽象（M2 完成——消除与 ralph-loop 的初始化重复）
  const { llm, tools, onApproval, budgetConfig: envBudget } = await prepareRuntime('');
  const budget = envBudget ?? undefined;

  const store = new CheckpointStore();
  const resultsDir = taskResultsDir(spec.id);
  await mkdir(resultsDir, { recursive: true });

  // 检测是否有未完成的阶段（崩溃恢复入口）
  let resumeFromPhase = 0;
  let prevOutput = '';
  if (fresh) {
    // --fresh：清理旧结果 + checkpoint，全新开始
    if (existsSync(resultsDir)) {
      const oldFiles = await readdir(resultsDir).catch(() => []);
      for (const f of oldFiles) {
        await rm(join(resultsDir, f), { force: true }).catch(() => {});
      }
      console.log(`  🧹 --fresh：已清理 ${oldFiles.length} 个旧结果文件`);
    }
    for (let i = 0; i < spec.phases.length; i++) {
      await store.delete(`${spec.id}-phase${i + 1}`);
    }
  }
  if (!fresh) {
    for (let i = 0; i < spec.phases.length; i++) {
      const phaseName = spec.phases[i]!.name;
      const resultPath = join(resultsDir, `phase-${i + 1}-${phaseName}.json`);
      if (existsSync(resultPath)) {
        try {
          const raw = await readFile(resultPath, 'utf8');
          const result = JSON.parse(raw) as PhaseResult;
          // 超时阶段不算完成（Karpathy Rule 3）——checkpoint 已存盘，resume 会续跑
          if (result.timedOut) {
            console.log(`  ⏱️ 阶段 ${i + 1}「${phaseName}」上次超时中断，将续跑`);
            break;
          }
          prevOutput = result.answer;
          resumeFromPhase = i + 1;
          console.log(`  ✓ 阶段 ${i + 1}「${phaseName}」已完成（恢复检测），跳过`);
        } catch {
          break;
        }
      } else {
        break;
      }
    }
    if (resumeFromPhase > 0) {
      console.log(`\n🔄 检测到已完成的阶段，从阶段 ${resumeFromPhase + 1} 续跑\n`);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🚀 长程任务：${spec.name}`);
  console.log(`   ${spec.description}`);
  console.log(`   阶段数：${spec.phases.length} | 从阶段 ${resumeFromPhase + 1} 开始`);
  console.log(`${'═'.repeat(70)}\n`);

  const phaseResults: PhaseResult[] = [];
  const taskStart = Date.now();

  for (let i = resumeFromPhase; i < spec.phases.length; i++) {
    const phase = spec.phases[i]!;
    const phaseNum = i + 1;
    const runId = `${spec.id}-phase${phaseNum}`;
    const prompt = renderPrompt(phase.prompt, prevOutput);

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`📦 阶段 ${phaseNum}/${spec.phases.length}：${phase.name}`);
    const timeBudget = phase.timeoutMs ? `${phase.timeoutMs / 1000}s` : '无时限';
    console.log(`   runId: ${runId} | maxSteps: ${phase.maxSteps ?? 50} | 时间预算: ${timeBudget}`);
    console.log(`${'─'.repeat(70)}`);

    const phaseT0 = Date.now();
    let timedOut = false;
    let result;
    try {
      result = await runLoopWithRetry(
        {
          llm,
          tools,
          system: phase.system,
          user: prompt,
          stream: false,
          maxSteps: phase.maxSteps ?? 50,
          onApproval,
          budget,
          durable: {
            runId,
            store,
            onCheckpoint: (info) => {
              process.stdout.write(`\r   🔒 已存盘到 step ${info.step}`);
            },
          },
        },
        { maxRetries: 3, retryDelayMs: 5000, timeoutMs: phase.timeoutMs },
      );
    } catch (e) {
      // Karpathy Rule 3:时间预算耗尽——checkpoint 已保存,本阶段标记超时,不中断整个任务
      if (e instanceof TimeoutError) {
        timedOut = true;
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
        console.log(`   ⏱️ 阶段时间预算耗尽（已存盘进度保留,下次 resume 可续跑）`);
        // 用当前 memory 的最新状态作为产出（超时前的最后进度）
        result = {
          answer: `(阶段因时间预算 ${timeBudget} 耗尽而中断；已存盘 checkpoint 可续跑)`,
          steps: 0,
          stopReason: 'error' as const,
          memory: null,
          trace: null,
          totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      } else {
        throw e;
      }
    }
    const phaseElapsed = ((Date.now() - phaseT0) / 1000).toFixed(1);
    // 清掉进度行
    process.stdout.write('\r' + ' '.repeat(40) + '\r');

    if (!timedOut) {
      console.log(`   ✅ 完成：${result.steps}步，${result.stopReason}，${phaseElapsed}s`);
    }

    const phaseResult: PhaseResult = {
      name: phase.name,
      answer: result.answer,
      steps: result.steps,
      stopReason: result.stopReason,
      phase: phaseNum,
      timedOut,
    };
    phaseResults.push(phaseResult);
    prevOutput = result.answer;

    // 阶段产出落盘（下一阶段可读，崩溃后可跳过；超时阶段也存盘以便诊断）
    const resultPath = join(resultsDir, `phase-${phaseNum}-${phase.name}.json`);
    await writeFile(resultPath, JSON.stringify(phaseResult, null, 2), 'utf8');
    console.log(`   💾 已保存阶段产出${timedOut ? '（标记超时，下次 resume 会重跑）' : ''}`);

    // 展示阶段答案摘要
    const summary = result.answer.slice(0, 200);
    console.log(`   📝 答案摘要：${summary}${result.answer.length > 200 ? '…' : ''}`);
  }

  // 任务级汇总
  const taskResult: TaskResult = {
    taskId: spec.id,
    taskName: spec.name,
    startedAt: new Date(taskStart).toISOString(),
    finishedAt: new Date().toISOString(),
    phases: phaseResults,
    finalAnswer: prevOutput,
  };
  await writeFile(join(resultsDir, 'final-result.json'), JSON.stringify(taskResult, null, 2), 'utf8');

  // —— Karpathy Rule 4:Keep only improvements ——
  // 若配置了评分函数,对本次最终产出打分,仅当更优时更新 best-result.json
  let bestInfo = '';
  if (spec.score && !phaseResults.some((p) => p.timedOut)) {
    const higherIsBetter = spec.score.higherIsBetter !== false;
    const tracker = new BestTracker(resultsDir, spec.id, higherIsBetter);
    const score = BestTracker.score(spec.score.expr, prevOutput, prevOutput);
    const updated = await tracker.maybeUpdate(prevOutput, score);
    const best = await tracker.current();
    if (updated) {
      bestInfo = ` | 🏆 新最佳 score=${score}`;
    } else if (best) {
      bestInfo = ` | 当前最佳 score=${best.score}（本次 score=${score} 未超越）`;
    }
  }

  // —— 任务完成后清理 checkpoint（已无续跑需要，释放磁盘）——
  if (!phaseResults.some((p) => p.timedOut)) {
    let cleaned = 0;
    for (let i = 0; i < spec.phases.length; i++) {
      await store.delete(`${spec.id}-phase${i + 1}`);
      cleaned++;
    }
    if (cleaned > 0) {
      console.log(`   🧹 已清理 ${cleaned} 个阶段的 checkpoint`);
    }
  }

  const totalElapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🎉 长程任务完成：${spec.name}`);
  console.log(`   总阶段：${phaseResults.length} | 总耗时：${totalElapsed}s${bestInfo}`);
  console.log(`   结果目录：${resolve(resultsDir)}`);
  console.log(`${'═'.repeat(70)}\n`);
}

// —————————— Karpathy Loop 迭代模式 ——————————

/**
 * 迭代型任务定义：agent 反复编辑同一产物文件，用指标筛选保留最佳。
 * 复刻 Karpathy autoresearch 的 program.md → train.py → best.py 三文件架构。
 *
 * 流程：
 *   for i in 1..maxIterations:
 *     agent 读取 artifact → 提出改进 → 输出新版 artifact
 *     metric 对新版打分 → 仅当更优时覆盖 best → 否则保留旧版
 *     达到 target 或耗尽迭代则停
 */
export interface IterativeTaskSpec {
  /** 任务 id */
  id: string;
  /** 任务名 */
  name: string;
  /** 描述 */
  description: string;
  /** 系统提示：指导 agent 如何改进 artifact */
  system: string;
  /** 初始 artifact 内容（agent 在此基础上迭代改进） */
  initialArtifact: string;
  /** 打分表达式（变量：artifact。higherIsBetter 时越大越优） */
  metric: { expr: string; target: number; maximize?: boolean };
  /** 最大迭代次数 */
  maxIterations: number;
  /** 每次迭代的步数上限 */
  stepsPerIteration?: number;
}

/** 迭代结果记录 */
interface IterationRecord {
  iteration: number;
  score: number;
  accepted: boolean;
  answer: string;
}

/** 对 artifact 打分（与 BestTracker.score 同源逻辑） */
export function scoreArtifact(expr: string, artifact: string): number {
  try {
    const fn = new Function('artifact', `"use strict"; return (${expr});`);
    const val = fn(artifact);
    return typeof val === 'number' && Number.isFinite(val) ? val : 0;
  } catch {
    return 0;
  }
}

/**
 * 运行 Karpathy Loop 迭代任务。
 *
 * agent 在每次迭代中读取当前最佳 artifact，尝试改进，产出新版本。
 * 新版本经 metric 打分，仅当更优时更新 best（贪心爬山），否则丢弃。
 * 达到 target 或耗尽 maxIterations 则停止。
 */
export async function runIterativeLoop(spec: IterativeTaskSpec): Promise<void> {
  // H7: 复用共享运行时
  const { llm, tools } = await prepareRuntime(spec.system);

  const resultsDir = taskResultsDir(spec.id);
  await mkdir(resultsDir, { recursive: true });

  // M3: 崩溃恢复——若已有 best-artifact.txt，从上次最佳状态续跑（而非从初始值重新开始）
  let bestArtifact = spec.initialArtifact;
  let startIteration = 1;
  const bestArtifactPath = join(resultsDir, 'best-artifact.txt');
  const historyPath = join(resultsDir, 'iteration-history.json');
  if (existsSync(bestArtifactPath)) {
    try {
      bestArtifact = await readFile(bestArtifactPath, 'utf8');
      // 也恢复迭代历史
      if (existsSync(historyPath)) {
        const hist = JSON.parse(await readFile(historyPath, 'utf8')) as { records?: IterationRecord[]; bestScore?: number };
        if (hist.records?.length) {
          startIteration = hist.records.length + 1;
          console.log(`  🔄 检测到上次运行（${hist.records.length} 次迭代），从迭代 ${startIteration} 续跑`);
        }
      }
    } catch {
      // 读取失败则用初始值
    }
  }
  let bestScore = scoreArtifact(spec.metric.expr, bestArtifact);
  const maximize = spec.metric.maximize ?? true;
  const records: IterationRecord[] = [];
  const taskStart = Date.now();

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🔁 迭代任务：${spec.name}`);
  console.log(`   ${spec.description}`);
  console.log(`   初始 score=${bestScore} | 目标=${spec.metric.target} | 最大迭代=${spec.maxIterations}`);
  console.log(`${'═'.repeat(70)}\n`);

  for (let iter = startIteration; iter <= spec.maxIterations; iter++) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`🔄 迭代 ${iter}/${spec.maxIterations} | 当前最佳 score=${bestScore}`);
    console.log(`${'─'.repeat(70)}`);

    // agent 读取当前 artifact 并尝试改进
    const prompt =
      `当前 artifact（你的改进基础）：\n\n${bestArtifact}\n\n` +
      `请改进这个 artifact。只输出改进后的完整版本，不要解释。` +
      (maximize ? `目标是让指标值更大（当前 ${bestScore}）。` : `目标是让指标值更小（当前 ${bestScore}）。`);

    const iterT0 = Date.now();
    const result = await runLoopWithRetry(
      {
        llm,
        tools,
        system: spec.system,
        user: prompt,
        stream: false,
        maxSteps: spec.stepsPerIteration ?? 5,
      },
      { maxRetries: 2, retryDelayMs: 3000 },
    );
    const iterElapsed = ((Date.now() - iterT0) / 1000).toFixed(1);

    const candidateArtifact = result.answer.trim();
    const candidateScore = scoreArtifact(spec.metric.expr, candidateArtifact);

    // 贪心爬山：仅当更优时接受
    const accepted = maximize ? candidateScore > bestScore : candidateScore < bestScore;
    if (accepted) {
      bestArtifact = candidateArtifact;
      bestScore = candidateScore;
      console.log(`   ✅ 接受：score ${result.answer ? candidateScore : '?'} > 旧 ${bestScore}（${iterElapsed}s）`);
    } else {
      console.log(`   ❌ 拒绝：score=${candidateScore} 未超越 ${bestScore}（${iterElapsed}s）`);
    }

    records.push({ iteration: iter, score: candidateScore, accepted, answer: candidateArtifact });

    // M3: 每次迭代后增量保存（崩溃恢复的基石）
    await writeFile(join(resultsDir, 'best-artifact.txt'), bestArtifact, 'utf8');
    await writeFile(
      join(resultsDir, 'iteration-history.json'),
      JSON.stringify({ taskId: spec.id, bestScore, target: spec.metric.target, records }, null, 2),
      'utf8',
    );

    // 达到目标则停
    const reachedTarget = maximize ? bestScore >= spec.metric.target : bestScore <= spec.metric.target;
    if (reachedTarget) {
      console.log(`\n🎯 达到目标 score=${bestScore}（target=${spec.metric.target}），停止迭代`);
      break;
    }
  }

  // 最终保存（确保即使 0 次接受也有产出）
  await writeFile(join(resultsDir, 'best-artifact.txt'), bestArtifact, 'utf8');
  await writeFile(
    join(resultsDir, 'iteration-history.json'),
    JSON.stringify({ taskId: spec.id, bestScore, target: spec.metric.target, records }, null, 2),
    'utf8',
  );

  const totalElapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🏁 迭代任务完成：${spec.name}`);
  console.log(`   迭代次数：${records.length} | 最佳 score：${bestScore} | 总耗时：${totalElapsed}s`);
  console.log(`   最佳产物：${resolve(join(resultsDir, 'best-artifact.txt'))}`);
  console.log(`${'═'.repeat(70)}\n`);
}

/** 列出所有阶段结果（诊断用） */
export async function listResults(taskId?: string): Promise<void> {
  const base = RESULTS_DIR;
  if (!existsSync(base)) {
    console.log('（暂无长任务结果）');
    return;
  }
  const dirs = taskId ? [taskId] : await readdir(base);
  for (const d of dirs) {
    const dir = join(base, d);
    const finalPath = join(dir, 'final-result.json');
    if (existsSync(finalPath)) {
      const raw = await readFile(finalPath, 'utf8');
      const result = JSON.parse(raw) as TaskResult;
      console.log(`\n📋 ${result.taskName} (${result.taskId})`);
      console.log(`   完成：${result.finishedAt}`);
      console.log(`   阶段：${result.phases.length}`);
      for (const p of result.phases) {
        console.log(`     ${p.phase}. ${p.name} — ${p.steps}步，${p.stopReason}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith('-'));
  const fresh = args.includes('--fresh');
  const list = args.includes('--list');
  const iterate = args.includes('--iterate');

  if (list) {
    await listResults();
    return;
  }

  if (paths.length === 0) {
    console.error('用法:');
    console.error('  npx tsx src/long-task.ts <long-task.json>           # 运行/恢复长任务');
    console.error('  npx tsx src/long-task.ts <long-task.json> --fresh    # 强制全新开始');
    console.error('  npx tsx src/long-task.ts <iterative-task.json> --iterate  # Karpathy Loop 迭代');
    console.error('  npx tsx src/long-task.ts --list                      # 列出已完成的长任务');
    process.exit(1);
  }

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf8');
      if (iterate) {
        const spec = JSON.parse(raw) as IterativeTaskSpec;
        await runIterativeLoop(spec);
      } else {
        const spec = JSON.parse(raw) as LongTaskSpec;
        await runLongTask(spec, fresh);
      }
    } catch (e) {
      console.error(`长任务 ${p} 失败：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
}

// ESM 入口守卫：仅当作为主模块直接运行时执行 main()，被 import 时不执行
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('long-task.ts');
if (isMain) {
  main().catch((e) => {
    console.error(`致命错误：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
