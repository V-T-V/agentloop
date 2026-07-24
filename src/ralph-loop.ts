#!/usr/bin/env tsx
/**
 * Ralph Loop：真正的长任务引擎（文件系统即状态）。
 *
 * 来源：Addy Osmani《Long-running Agents》的「Ralph Loop」模式——
 *   agent 是失忆的，但文件系统不是。
 *
 * 核心区别于 long-task.ts 的多阶段模式：
 *   - long-task：固定 N 个阶段，阶段间串文本 → 有天花板，context 会爆
 *   - ralph-loop：动态子任务队列，每次迭代全新 context reset → 无上限
 *
 * 三阶段架构：
 *   1. Planner：把大任务拆成 N 个子任务（写入 todo.md）
 *   2. Worker 循环：每次取一个 pending 子任务 → 全新 runLoop 执行 → 写结果 → 标记 done
 *   3. Finalizer：全部完成后汇总成最终报告
 *
 * 为什么能跑 8 小时：
 *   - 子任务数量由 Planner 动态决定（50/100/500 都行）
 *   - 每次迭代是全新 runLoop（零历史对话）→ context 永远不爆
 *   - 崩溃恢复 = 重新读 todo.md，天然支持（文件是唯一状态源）
 *
 * 用法：
 *   npx tsx src/ralph-loop.ts ralph-tasks/research-20-companies.json
 *   npx tsx src/ralph-loop.ts ralph-tasks/research-20-companies.json --status
 *   # 崩溃后重跑同命令即自动 resume（读 todo.md 继续）
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { runLoop } from './loop.ts';
import { prepareRuntime } from './runtime.ts';
import { BudgetGuard, type BudgetConfig } from './budget.ts';
import { verifyTask, type Assertion } from './verify.ts';
import { evaluateTrajectory } from './eval.ts';
import { reflectionLoop, DEFAULT_REFLECTION } from './reflection.ts';
import { getMemoryStore } from './tools/recall.ts';
import { env } from './env.ts';
import type { LoopEvent, TokenUsage } from './types.ts';

/** M5: Dashboard 事件推送（可选——LOOP_DASHBOARD=1 时启用） */
let dashboardPush: ((e: LoopEvent) => void) | null = null;
if (env('LOOP_DASHBOARD', '0') === '1') {
  try {
    const dash = await import('./dashboard.ts');
    dash.startDashboard();
    dashboardPush = dash.pushEvent;
    console.log(`📊 Dashboard 已启动`);
  } catch {
    // dashboard 可选，加载失败不阻塞
  }
}

// —————————— 类型定义 ——————————

/** Ralph Loop 任务定义（JSON 配置文件） */
export interface RalphTaskSpec {
  /** 任务 id（用作工作目录名） */
  id: string;
  /** 任务名（展示用） */
  name: string;
  /** 大任务描述（写入 task.md，不可变） */
  description: string;
  /** 完成条件（写入 done-condition.md，不可变） */
  doneCondition: string;
  /** Planner 的指令：如何拆分大任务。可用 {{description}} 引用大任务描述 */
  plannerPrompt: string;
  /** Worker 的系统提示 */
  workerSystem: string;
  /** 单次 Worker 迭代最大步数（默认 12） */
  workerMaxSteps?: number;
  /**
   * 并行度：同时执行的子任务数（默认 1=串行）。
   * Claude Code Workflows 式的 Map 扇出——同一批次的子任务并行执行。
   * 利用 concurrency.ts 的 Semaphore 防止 LLM 限流。
   */
  parallelism?: number;
  /** Finalizer 的指令：如何汇总 */
  finalizerPrompt: string;
  /** 成本预算（可选，防失控） */
  budget?: BudgetConfig;
  /** 客观断言：每个子任务产出必须通过的确定性检查（answer_length 等） */
  assertions?: Assertion[];
  /** 是否对每个子任务产出跑 LLM-judge（默认 false） */
  judge?: boolean;
  /** judge 合格阈值（默认 70，0-100） */
  judgeThreshold?: number;
  /** 不合格时的最大重试次数（默认 2，不含首次） */
  maxRetries?: number;
  /**
   * 总时间上限（秒）。M1: wall-clock deadline——超时则优雅终止。
   * 防止卡死任务无限运行。0=不限（默认）。
   */
  maxDurationSec?: number;
  /** Reflection Loop：在 verify 前对 Worker 产出做批评→修订（自我改进，+34% 准确率） */
  reflection?: { enabled?: boolean; maxRevisions?: number; minSeverityToRevise?: 'low' | 'medium' | 'high' };
}

/** todo.md 中的一行子任务 */
interface TodoItem {
  /** 序号（从 1 开始） */
  index: number;
  /** 子任务描述（checklist 文本） */
  text: string;
  /** 状态 */
  status: 'pending' | 'done' | 'skip';
  /** 已尝试次数（用于重试追踪，从 todo.md 注释行恢复） */
  attempts?: number;
  /** 上次失败原因（注入重试 prompt，让 agent 修正） */
  lastFailReason?: string;
}

/** progress.json 结构 */
interface Progress {
  taskId: string;
  totalSubtasks: number;
  completed: number;
  skipped: number;
  totalSteps: number;
  totalUsage: TokenUsage;
  startedAt: string;
  updatedAt: string;
  /** Worker 迭代次数 */
  iterations: number;
  /** 停止原因（budget_exceeded 等） */
  stopReason?: string;
  /** 通过校验的子任务数 */
  verified: number;
  /** 被重试过的子任务数 */
  retried: number;
  /** 最终被拒绝（重试耗尽仍不合格）的子任务数 */
  rejected: number;
}

// —————————— 工作目录管理 ——————————

const WORK_DIR = '.agentloop/ralph';

function taskDir(taskId: string): string {
  return join(WORK_DIR, taskId);
}

function resultsDir(taskId: string): string {
  return join(taskDir(taskId), 'results');
}

// —————————— todo.md 解析与更新 ——————————

/** Markdown checklist 行的正则：- [ ] / - [x] / - [-] */
const TODO_LINE_RE = /^\s*-\s*\[([ xX-])\]\s*(.+)$/;

/** 解析 todo.md 为 TodoItem 列表（支持 attempts/failReason 注释行） */
function parseTodo(content: string): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = content.split('\n');
  let index = 0;
  let currentItem: TodoItem | null = null;
  for (const line of lines) {
    const m = line.match(TODO_LINE_RE);
    if (m) {
      index++;
      const mark = m[1]!.toLowerCase();
      const status: TodoItem['status'] = mark === 'x' ? 'done' : mark === '-' ? 'skip' : 'pending';
      currentItem = { index, text: m[2]!.trim(), status, attempts: 0 };
      items.push(currentItem);
    } else {
      // attempts 注释行
      const am = line.match(/<!--\s*attempts:\s*(\d+)\s*-->/);
      if (am && currentItem) {
        currentItem.attempts = Number(am[1]);
      }
      // failReason 注释行（C1: 跨崩溃保持失败原因）
      const fm = line.match(/<!--\s*failReason:\s*(.+?)\s*-->/);
      if (fm && currentItem) {
        currentItem.lastFailReason = fm[1];
      }
    }
  }
  return items;
}

/** 把 TodoItem 列表渲染回 markdown checklist（含 attempts/failReason 注释） */
function renderTodo(items: TodoItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const mark = item.status === 'done' ? 'x' : item.status === 'skip' ? '-' : ' ';
    lines.push(`- [${mark}] ${item.text}`);
    // pending 且有重试记录时，持久化 attempts + failReason（跨崩溃恢复）
    if (item.status === 'pending' && item.attempts && item.attempts > 0) {
      lines.push(`<!-- attempts: ${item.attempts} -->`);
      if (item.lastFailReason) {
        lines.push(`<!-- failReason: ${item.lastFailReason.replace(/-->/g, '')} -->`);
      }
    }
  }
  return `# 子任务清单\n\n${lines.join('\n')}\n`;
}

/** 从子任务文本生成文件名安全的 slug */
function slugify(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${String(index).padStart(3, '0')}-${slug || 'task'}`;
}

// —————————— 核心：Ralph Loop 执行器 ——————————

/**
 * 运行 Ralph Loop 长任务。
 *
 * 流程：Planner（若 todo.md 不存在）→ Worker 循环 → Finalizer
 * 崩溃恢复：若 todo.md 已存在，跳过 Planner，直接继续 Worker 循环。
 */
export async function runRalphLoop(spec: RalphTaskSpec): Promise<void> {
  // M2: 使用共享运行时抽象（替代重复的初始化代码）
  const { llm, tools, onApproval, budgetConfig: envBudget, budgetGuard: envGuard } = await prepareRuntime(spec.workerSystem);

  // 预算：spec.budget 优先，否则用环境变量加载的
  const budgetConfig = spec.budget ?? envBudget;
  const budgetGuard = spec.budget ? new BudgetGuard(spec.budget) : envGuard;

  // C5: 优雅取消——SIGINT/SIGTERM 时设标志，当前批次完成后干净退出
  let cancelled = false;
  const cancelHandler = () => {
    if (!cancelled) {
      cancelled = true;
      console.log('\n\n⚠️ 收到取消信号，等待当前批次完成后优雅退出…（再按一次强制退出）');
    } else {
      console.log('\n💥 强制退出');
      process.exit(1);
    }
  };
  process.on('SIGINT', cancelHandler);
  process.on('SIGTERM', cancelHandler);

  // M1: 总时间限制（wall-clock deadline）
  const maxDurationSec = spec.maxDurationSec ?? 0;
  const taskStartMs = Date.now();
  const deadlineMs = maxDurationSec > 0 ? taskStartMs + maxDurationSec * 1000 : 0;

  // 工作目录
  const dir = taskDir(spec.id);
  const rdir = resultsDir(spec.id);
  await mkdir(rdir, { recursive: true });

  const taskMdPath = join(dir, 'task.md');
  const todoMdPath = join(dir, 'todo.md');
  const doneCondPath = join(dir, 'done-condition.md');
  const progressPath = join(dir, 'progress.json');

  // —— Phase 0：初始化不可变文件（首次运行）——
  if (!existsSync(taskMdPath)) {
    await writeFile(taskMdPath, `# ${spec.name}\n\n${spec.description}\n`, 'utf8');
    await writeFile(doneCondPath, `# 完成条件\n\n${spec.doneCondition}\n`, 'utf8');
  }

  const taskStart = Date.now();

  // —— Phase 1：Planner（若 todo.md 不存在）——
  if (!existsSync(todoMdPath)) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📋 Ralph Loop：${spec.name}`);
    console.log(`   Phase 1/3: Planner — 拆分大任务为子任务`);
    console.log(`${'═'.repeat(70)}\n`);

    const plannerSystem =
      '你是任务规划专家。把大任务拆分成具体的、可独立执行的子任务。\n' +
      '输出格式：markdown checklist，每行一个子任务：\n' +
      '- [ ] 子任务1描述\n' +
      '- [ ] 子任务2描述\n' +
      '...\n\n' +
      '要求：\n' +
      '1. 每个子任务应该能在单次执行中完成（不要太大）\n' +
      '2. 子任务之间应尽量独立\n' +
      '3. 拆分粒度要细——宁可多拆也不要少拆\n' +
      '4. 只输出 checklist，不要额外解释';

    const plannerUser =
      spec.plannerPrompt.replaceAll('{{description}}', spec.description) +
      `\n\n大任务描述：\n${spec.description}\n\n完成条件：\n${spec.doneCondition}`;

    // C2: Planner 保护——重试 3 次，失败则降级为单任务
    let plannerResult = null as Awaited<ReturnType<typeof runLoop>> | null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        plannerResult = await runLoop({
          llm,
          tools: [],
          system: plannerSystem,
          user: plannerUser,
          stream: false,
          maxSteps: 3,
        });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < 3) {
          console.log(`   ⚠️ Planner 第${attempt}次失败：${msg}，${5 * attempt}s 后重试…`);
          await new Promise((r) => setTimeout(r, 5000 * attempt));
        } else {
          console.error(`   ❌ Planner 3次重试均失败：${msg}`);
          console.log(`   🔄 降级：将大任务作为单个子任务执行`);
        }
      }
    }

    if (plannerResult) {
      const todoContent = extractChecklist(plannerResult.answer);
      await writeFile(todoMdPath, todoContent, 'utf8');
      const items = parseTodo(todoContent);
      console.log(`   ✅ Planner 完成：拆出 ${items.length} 个子任务\n`);
      if (budgetGuard) budgetGuard.add(plannerResult.totalUsage);
    } else {
      // 降级：整个任务作为单个子任务
      const fallbackTodo = `# 子任务清单\n\n- [ ] ${spec.description.slice(0, 100)}\n`;
      await writeFile(todoMdPath, fallbackTodo, 'utf8');
      console.log(`   ✅ 降级模式：1 个子任务\n`);
    }
  }

  // —— Phase 2：Worker 循环 ——
  const progress = await loadProgress(progressPath, spec.id);
  if (!existsSync(todoMdPath)) {
    console.error('❌ todo.md 不存在，Planner 可能失败');
    return;
  }

  console.log(`\n${'═'.repeat(70)}`);
  const parallelism = spec.parallelism ?? 1;
  console.log(`🔄 Ralph Loop：${spec.name}`);
  console.log(`   Phase 2/3: Worker 循环 — ${parallelism > 1 ? `并行×${parallelism}` : '逐个'}执行子任务`);
  console.log(`${'═'.repeat(70)}\n`);

  while (true) {
    // 读 todo.md（每次迭代都重读——文件是唯一状态源）
    const todoContent = await readFile(todoMdPath, 'utf8');
    const items = parseTodo(todoContent);

    // C5: 优雅取消检查——信号触发后，批次边界处干净退出（todo.md 已是最新的）
    if (cancelled) {
      console.log(`\n   🛑 优雅退出：已完成 ${progress.completed}/${items.length} 子任务`);
      console.log(`   重跑同命令即可 resume 继续剩余子任务`);
      progress.stopReason = 'cancelled';
      await saveProgress(progressPath, progress);
      process.off('SIGINT', cancelHandler);
      process.off('SIGTERM', cancelHandler);
      return; // 干净退出，不跑 Finalizer
    }

    const pendingItems = items.filter((i) => i.status === 'pending');

    if (pendingItems.length === 0) {
      console.log(`\n   ✅ 所有子任务已完成（或跳过）`);
      break;
    }

    // 预算检查
    if (budgetGuard?.exhausted()) {
      console.log(`\n   ⛔ 预算耗尽（${budgetGuard.current}/${budgetGuard.config.maxTotalTokens} tokens），优雅终止`);
      progress.stopReason = 'budget_exceeded';
      break;
    }

    // M1: 总时间限制检查
    if (deadlineMs > 0 && Date.now() >= deadlineMs) {
      const elapsed = Math.round((Date.now() - taskStartMs) / 1000);
      console.log(`\n   ⏰ 总时间耗尽（${elapsed}s ≥ ${maxDurationSec}s），优雅终止`);
      progress.stopReason = 'timeout';
      break;
    }

    // 取本批次（并行度个 pending 子任务）
    const batch = pendingItems.slice(0, parallelism);

    // C6: doneSummary 截断——只保留最近 N 条已完成标题（防 context 爆）
    const DONE_SUMMARY_CAP = 20;
    const doneItems = items.filter((i) => i.status === 'done');
    const recentDone = doneItems.slice(-DONE_SUMMARY_CAP);
    const doneSummary = recentDone.length > 0
      ? `\n\n## 已完成的子任务（最近${recentDone.length}条，共${doneItems.length}条；供参考，不要重复）\n${recentDone.map((i) => `  ${i.index}. ${i.text}`).join('\n')}`
      : '';

    const batchNum = Math.ceil(progress.completed / parallelism) + 1;
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`   📦 批次 #${batchNum}：${batch.length} 个子任务${batch.length > 1 ? '（并行）' : ''}`);
    batch.forEach((t) => console.log(`      ${t.index}/${items.length}: ${t.text.slice(0, 50)}${t.attempts ? ` (重试${t.attempts})` : ''}`));
    console.log(`   已完成: ${progress.completed}/${items.length}`);
    console.log(`${'─'.repeat(70)}`);

    const batchT0 = Date.now();

    // 并行执行本批次（或串行执行单个）
    const batchResults = await Promise.allSettled(
      batch.map(async (todoItem) => {
        // C1: 重试时注入上次失败原因——让 agent 能修正而非盲跑
        const retryHint = todoItem.attempts && todoItem.attempts > 0
          ? `\n\n## ⚠️ 上次尝试未通过校验（第${todoItem.attempts}次），请注意修正：\n${todoItem.lastFailReason ?? '未知原因'}\n请针对以上问题改进你的回答。`
          : '';

        const workerSystem =
          spec.workerSystem +
          `\n\n## 全局任务\n${spec.description}` +
          `\n\n## 当前子任务\n${todoItem.text}` +
          doneSummary +
          retryHint +
          await recallRelevantMemory(todoItem.text) +
          `\n\n执行当前子任务，完成后直接给出你的发现/分析结果。`;

        // H3 修复：不再向内部 runLoop 传 budget（避免创建全新 BudgetGuard 导致双重计数）
        // 预算由外部 budgetGuard 在批次边界检查（ralph-loop.ts 的 while 循环顶部）
        const result = await runLoop({
          llm,
          tools,
          system: workerSystem,
          user: `请执行子任务：${todoItem.text}`,
          stream: false,
          maxSteps: spec.workerMaxSteps ?? 12,
          onApproval,
          onEvent: dashboardPush ?? undefined,
        });
        return { todoItem, result };
      }),
    );

    const batchElapsed = ((Date.now() - batchT0) / 1000).toFixed(1);

    // 处理本批次结果
    for (const settled of batchResults) {
      progress.iterations++;
      if (settled.status === 'fulfilled') {
        const { todoItem, result } = settled.value;
        progress.totalSteps += result.steps;
        progress.totalUsage = addUsage(progress.totalUsage, result.totalUsage);
        if (budgetGuard) budgetGuard.add(result.totalUsage);

        // —— Reflection Loop：在 verify 前批评→修订（自我改进）——
        const reflConfig = spec.reflection
          ? { ...DEFAULT_REFLECTION, ...spec.reflection }
          : DEFAULT_REFLECTION;
        if (reflConfig.enabled) {
          const reflResult = await reflectionLoop(llm, result.answer, todoItem.text, reflConfig);
          if (reflResult.revised) {
            // 用修订后的答案替换原始答案
            result.answer = reflResult.answer;
            console.log(`   🔍 #${todoItem.index} Reflection: 修订${reflResult.critiques.length}次（${reflResult.critiques[reflResult.critiques.length - 1]?.severity ?? '?'}→合格）`);
          }
        }

        // —— 双层校验 ——
        const verdict = await verifySubtaskResult(spec, result, todoItem, llm);
        if (verdict.passed) {
          // ✅ 校验通过：写结果文件 + 标记 done
          const resultFile = join(rdir, `${slugify(todoItem.text, todoItem.index)}.md`);
          await writeFile(resultFile, result.answer, 'utf8');
          todoItem.status = 'done';
          progress.completed++;
          progress.verified++;
          // P1: 验证通过 → 存为高置信度事实（跨任务学习）
          try {
            const store = getMemoryStore();
            store.addTyped(result.answer.slice(0, 500), 'fact', 0.8, { task: todoItem.text.slice(0, 80), taskId: spec.id });
            await store.persist();
          } catch { /* 记忆存储失败不阻塞 */ }
          console.log(`   ✅ #${todoItem.index} ${todoItem.text.slice(0, 40)}：${result.steps}步，${verdict.detail}`);
        } else {
          // ❌ 校验失败：重试或放弃
          const attempts = (todoItem.attempts ?? 0) + 1;
          todoItem.attempts = attempts;
          todoItem.lastFailReason = verdict.detail; // C1: 保存失败原因供重试注入
          const maxRetries = spec.maxRetries ?? 2;
          if (attempts <= maxRetries) {
            // 重新排队：保持 pending，下个批次重跑（携带失败原因）
            if (attempts === 1) progress.retried++;
            console.log(`   🔁 #${todoItem.index} 未通过校验（${verdict.detail}），重试 ${attempts}/${maxRetries}（携带失败反馈）`);
          } else {
            // 重试耗尽：标记 skip，保留结果但标注
            const resultFile = join(rdir, `${slugify(todoItem.text, todoItem.index)}.md`);
            await writeFile(resultFile, `> ⚠️ 未通过校验（${verdict.detail}）\n\n${result.answer}`, 'utf8');
            todoItem.status = 'skip';
            todoItem.attempts = 0; // 清除注释
            todoItem.lastFailReason = undefined;
            progress.skipped++;
            progress.rejected++;
            console.log(`   ⚠️ #${todoItem.index} 重试耗尽，标记 skip：${verdict.detail}`);
          }
        }
      } else {
        // 异常失败：标记 skip
        const failedIdx = batch[batchResults.indexOf(settled)]!.index;
        const failedItem = items.find((i) => i.index === failedIdx);
        if (failedItem) failedItem.status = 'skip';
        progress.skipped++;
        const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        console.error(`   ❌ #${failedIdx} 失败：${msg}`);
      }
    }

    // 批次结束后统一更新 todo.md 和 progress
    await writeFile(todoMdPath, renderTodo(items), 'utf8');
    progress.updatedAt = new Date().toISOString();
    await saveProgress(progressPath, progress);

    console.log(`   ⏱️ 批次耗时：${batchElapsed}s`);
  }

  // —— Phase 3：Finalizer ——
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📝 Ralph Loop：${spec.name}`);
  console.log(`   Phase 3/3: Finalizer — 汇总最终报告`);
  console.log(`${'═'.repeat(70)}\n`);

  // 读全部结果文件（C4: 截断防 context 爆——超过 50 个文件时每个只取前 500 字符）
  const resultFiles = await readdir(rdir).catch(() => []);
  const mdFiles = resultFiles.filter((f) => f.endsWith('.md')).sort();
  const MAX_FINALIZER_CHARS = mdFiles.length > 50 ? 500 : 2000; // 大任务截断每个结果
  const allResults: string[] = [];
  for (const f of mdFiles) {
    let content = await readFile(join(rdir, f), 'utf8');
    if (content.length > MAX_FINALIZER_CHARS) {
      content = content.slice(0, MAX_FINALIZER_CHARS) + '…（已截断）';
    }
    allResults.push(`### ${f.replace('.md', '')}\n\n${content}`);
  }

  const finalizerSystem =
    '你是报告撰写专家。把多个子任务的产出汇总成一份连贯的最终报告。\n' +
    '要求：结构清晰、内容完整、去除冗余、保留关键发现。';

  // C4: Finalizer 预算保护
  const finalizerBudget = budgetGuard && budgetConfig
    ? { ...budgetConfig, maxTotalTokens: Math.max(budgetGuard.remaining(), budgetConfig.maxTotalTokens * 0.1) }
    : undefined;

  const finalResult = await runLoop({
    llm,
    tools: [],
    system: finalizerSystem,
    user:
      spec.finalizerPrompt +
      `\n\n以下是各子任务的产出：\n\n${allResults.join('\n\n---\n\n')}`,
    stream: false,
    maxSteps: 5,
    budget: finalizerBudget,
  });

  await writeFile(join(dir, 'final-report.md'), finalResult.answer, 'utf8');
  if (budgetGuard) budgetGuard.add(finalResult.totalUsage);
  progress.totalUsage = addUsage(progress.totalUsage, finalResult.totalUsage);
  progress.updatedAt = new Date().toISOString();
  await saveProgress(progressPath, progress);

  // —— 总结 ——
  const totalElapsed = ((Date.now() - taskStart) / 1000).toFixed(0);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🎉 Ralph Loop 完成：${spec.name}`);
  console.log(`   子任务：${progress.completed} 完成 / ${progress.skipped} 跳过 / ${progress.totalSubtasks} 总计`);
  console.log(`   校验：${progress.verified} 通过 / ${progress.retried} 重试 / ${progress.rejected} 拒绝`);
  console.log(`   迭代次数：${progress.iterations} | 总步数：${progress.totalSteps}`);
  console.log(`   总耗时：${totalElapsed}s | 总 token：${progress.totalUsage.totalTokens}`);
  console.log(`   最终报告：${resolve(join(dir, 'final-report.md'))}`);
  console.log(`${'═'.repeat(70)}\n`);
}

// —————————— 辅助函数 ——————————

/**
 * P1: 从记忆存储检索与子任务相关的已验证记忆，注入 Worker context。
 * 只返回高置信度（≥0.5）的记忆，避免注入低质内容。
 */
async function recallRelevantMemory(taskText: string): Promise<string> {
  try {
    const store = getMemoryStore();
    const results = store.searchRelevant(taskText, 3, 0.5);
    if (results.length === 0) return '';
    const memoryText = results.map((r, i) =>
      `  ${i + 1}. [confidence=${((r.record.confidence ?? 1) * 100).toFixed(0)}%] ${r.record.text.slice(0, 120)}`,
    ).join('\n');
    return `\n\n## 相关记忆（从历史任务中学习，供参考）\n${memoryText}`;
  } catch {
    return ''; // 记忆检索失败不阻塞
  }
}

/**
 * 双层校验子任务产出：客观断言（硬门槛）+ LLM-judge（质量分）。
 * 返回 { passed, detail }——passed=true 才标记 done。
 */
async function verifySubtaskResult(
  spec: RalphTaskSpec,
  result: { answer: string; trace: import('./trace.ts').Span | null; stopReason: string },
  todoItem: TodoItem,
  llm: import('./types.ts').LLMClient,
): Promise<{ passed: boolean; detail: string }> {
  const parts: string[] = [];

  // ① 客观断言层（硬门槛）
  if (spec.assertions && spec.assertions.length > 0) {
    const verify = verifyTask(result as import('./loop.ts').RunLoopOutput, spec.assertions);
    if (!verify.allPassed) {
      const failed = verify.results.filter((r) => !r.passed).map((r) => r.description);
      return { passed: false, detail: `断言未全过(${verify.passed}/${verify.total})：${failed.join('; ')}` };
    }
    parts.push(`断言${verify.total}条全过`);
  }

  // ② LLM-judge 层（质量分）
  if (spec.judge) {
    const threshold = spec.judgeThreshold ?? 70;
    try {
      const evalResult = await evaluateTrajectory(result.trace, { llm });
      if (evalResult.overall < threshold) {
        return { passed: false, detail: `judge=${evalResult.overall}<${threshold}：${evalResult.reasoning.slice(0, 60)}` };
      }
      parts.push(`judge=${evalResult.overall}`);
    } catch (e) {
      // judge 失败不阻塞（降级为通过——断言已过）
      const msg = e instanceof Error ? e.message.slice(0, 30) : String(e);
      parts.push(`judge跳过(${msg})`);
    }
  }

  return { passed: true, detail: parts.join('，') || '无校验' };
}

/** 从 agent 输出中提取 markdown checklist */
function extractChecklist(text: string): string {
  const lines = text.split('\n');
  const checklist = lines.filter((l) => TODO_LINE_RE.test(l));
  if (checklist.length === 0) {
    // agent 没用 checklist 格式，把每行当一个子任务
    const tasks = lines.filter((l) => l.trim() && !l.startsWith('#')).slice(0, 50);
    return `# 子任务清单\n\n${tasks.map((t) => `- [ ] ${t.trim()}`).join('\n')}\n`;
  }
  return `# 子任务清单\n\n${checklist.join('\n')}\n`;
}

/** 加载进度文件 */
async function loadProgress(path: string, taskId: string): Promise<Progress> {
  try {
    const raw = await readFile(path, 'utf8');
    const p = JSON.parse(raw) as Progress;
    // 向后兼容：旧进度文件没有新字段
    if (p.verified === undefined) p.verified = 0;
    if (p.retried === undefined) p.retried = 0;
    if (p.rejected === undefined) p.rejected = 0;
    return p;
  } catch {
    return {
      taskId,
      totalSubtasks: 0,
      completed: 0,
      skipped: 0,
      totalSteps: 0,
      totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      iterations: 0,
      verified: 0,
      retried: 0,
      rejected: 0,
    };
  }
}

/** 保存进度文件（原子写） */
async function saveProgress(path: string, progress: Progress): Promise<void> {
  // 更新 totalSubtasks（todo.md 可能在运行中被 Planner 改了）
  try {
    const todoContent = await readFile(join(dirname(path), 'todo.md'), 'utf8');
    progress.totalSubtasks = parseTodo(todoContent).length;
  } catch {
    // ignore
  }
  await writeFile(path, JSON.stringify(progress, null, 2), 'utf8');
}

/** token 用量累加 */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

// —————————— CLI ——————————

async function showStatus(taskId: string): Promise<void> {
  const dir = taskDir(taskId);
  const progressPath = join(dir, 'progress.json');
  if (!existsSync(progressPath)) {
    console.log(`任务 ${taskId} 无进度记录`);
    return;
  }
  const p = JSON.parse(await readFile(progressPath, 'utf8')) as Progress;
  const todoContent = await readFile(join(dir, 'todo.md'), 'utf8').catch(() => '');
  const items = parseTodo(todoContent);
  const pending = items.filter((i) => i.status === 'pending').length;
  const done = items.filter((i) => i.status === 'done').length;

  console.log(`\n📋 ${taskId}`);
  console.log(`   进度：${done}/${items.length} 完成，${pending} 待执行`);
  console.log(`   校验：${p.verified ?? 0} 通过 / ${p.retried ?? 0} 重试 / ${p.rejected ?? 0} 拒绝`);
  console.log(`   迭代：${p.iterations} | 步数：${p.totalSteps} | token：${p.totalUsage.totalTokens}`);
  console.log(`   开始：${p.startedAt} | 更新：${p.updatedAt}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith('-'));
  const status = args.includes('--status');

  if (status) {
    if (paths.length === 0) {
      console.error('用法: npx tsx src/ralph-loop.ts --status <task-id>');
      process.exit(1);
    }
    await showStatus(paths[0]!);
    return;
  }

  if (paths.length === 0) {
    console.error('用法:');
    console.error('  npx tsx src/ralph-loop.ts <ralph-task.json>     # 运行/恢复');
    console.error('  npx tsx src/ralph-loop.ts --status <task-id>    # 查看进度');
    process.exit(1);
  }

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf8');
      const spec = JSON.parse(raw) as RalphTaskSpec;
      await runRalphLoop(spec);
    } catch (e) {
      console.error(`Ralph Loop ${p} 失败：${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ralph-loop.ts');
if (isMain) {
  main().catch((e) => {
    console.error(`致命错误：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
