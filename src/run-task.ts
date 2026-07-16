#!/usr/bin/env tsx
/**
 * 任务运行器：读取 tasks/*.json 任务定义（含断言），执行 → 双层验证 → 报告。
 *
 * 任务定义格式（见 tasks/l1-days.json）：
 *   { id, name, level, system, question, maxSteps, assertions[] }
 *
 * 用法：
 *   npx tsx src/run-task.ts tasks/l1-days.json        # 跑单个任务（客观验证）
 *   npx tsx src/run-task.ts tasks/l1-days.json --judge  # 加 LLM-judge 双层
 *   npx tsx src/run-task.ts tasks/*.json                # 批量（shell 展开）
 *
 * 输出：答案 + 客观验证逐条 + 可选 LLM-judge + 综合判定。
 */

import { readFile } from 'node:fs/promises';
import { loadEnv } from './env.ts';
import { createLLM } from './llm.ts';
import { runLoop } from './loop.ts';
import { Memory } from './memory.ts';
import { makeSubAgentTools, type SubAgentDeps } from './subagent.ts';
import { loadAllTools, registerCleanup } from './tools/load-all.ts';
import { verifyTask, renderVerify, type Assertion } from './verify.ts';
import { evaluateTrajectory, renderEval } from './eval.ts';
import { aggregateMetrics, flattenSpans, renderMetrics } from './metrics.ts';
import { loadBudgetConfig } from './budget.ts';
import { TraceStore, makeTraceRecord, newTraceId } from './trace-store.ts';
import { env } from './env.ts';
import type { AnyToolDef, ApprovalRequest, ApprovalDecision, ToolDef } from './types.ts';

interface TaskDef {
  id: string;
  name: string;
  level: string;
  system: string;
  question: string;
  maxSteps: number;
  assertions: Assertion[];
}

async function runOne(path: string, withJudge: boolean, withMetrics: boolean, withDashboard: boolean): Promise<void> {
  const raw = await readFile(path, 'utf8');
  const task = JSON.parse(raw) as TaskDef;
  loadEnv();
  const llm = createLLM();

  // A1: 统一加载工具（内置 + MCP 若配置了 mcp-servers.json）
  const { tools: loadedTools, closeAll } = await loadAllTools();
  registerCleanup(closeAll);

  // 自动批准（脚本场景；生产用交互审批）
  const onApproval = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ approved: true });
  const deps: SubAgentDeps = { llm, tools: loadedTools as ToolDef[], system: task.system, onApproval };
  const tools: AnyToolDef[] = [...loadedTools, ...makeSubAgentTools(deps)];

  // A2: 加载成本预算配置（若 LOOP_COST_BUDGET_TOKENS 配置了）
  const budget = loadBudgetConfig();

  // B2: 仪表盘（可选）
  let onEvent: ((e: import('./types.ts').LoopEvent) => void) | undefined;
  if (withDashboard) {
    const { startDashboard, pushEvent } = await import('./dashboard.ts');
    startDashboard();
    onEvent = pushEvent;
  }

  console.log(`\n${'═'.repeat(64)}\n📋 ${task.name}  [${task.level}]\n${'═'.repeat(64)}`);
  console.log(`\n${task.question}\n`);

  const t0 = Date.now();
  const result = await runLoop({
    llm,
    tools,
    system: task.system,
    user: task.question,
    memory: new Memory(task.system),
    stream: false,
    maxSteps: task.maxSteps,
    onApproval,
    budget: budget ?? undefined,
    onEvent,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n🤖 答案（${result.steps}步，${result.stopReason}，${elapsed}s）：\n`);
  console.log(result.answer.split('\n').map((l) => '   ' + l).join('\n'));

  // A2: 若启用了预算，展示消耗
  if (budget) {
    const guard = result.totalUsage;
    const pct = ((guard.totalTokens / budget.maxTotalTokens) * 100).toFixed(1);
    console.log(`\n💰 预算：${guard.totalTokens}/${budget.maxTotalTokens} tokens（${pct}%）`);
  }

  // A3: trace 持久化（供离线 /replay /eval 使用）
  if (env('LOOP_TRACE_PERSIST', '1') !== '0') {
    const traceId = newTraceId();
    const record = makeTraceRecord(traceId, result, task.question);
    if (record) {
      await new TraceStore().save(record);
      console.log(`\n💾 trace 已保存：${traceId}（可用 /replay ${traceId} 回放）`);
    }
  }

  // —— 客观验证（确定性硬判定）——
  console.log(`\n${'─'.repeat(64)}`);
  const verify = verifyTask(result, task.assertions);
  console.log(renderVerify(verify));

  // —— 指标聚合（可选）——
  if (withMetrics && result.trace) {
    console.log(`\n📊 运行指标：`);
    const report = aggregateMetrics(flattenSpans(result.trace));
    console.log(renderMetrics(report).split('\n').map((l) => '   ' + l).join('\n'));
  }

  // —— LLM-judge（主观质量分，可选）——
  let judgeScore = -1;
  if (withJudge) {
    console.log(`\n📊 LLM-as-judge 评估：`);
    const judge = await evaluateTrajectory(result.trace, { llm });
    judgeScore = judge.overall;
    console.log(renderEval(judge).split('\n').map((l) => '   ' + l).join('\n'));
  }

  // —— 综合判定（双层）——
  console.log(`\n${'─'.repeat(64)}`);
  let verdict: string;
  if (!verify.allPassed) {
    verdict = '❌ 客观断言未全过（不论 judge 多高，客观是硬门槛）';
  } else if (judgeScore >= 0) {
    verdict = judgeScore >= 80 ? '✅ 完全合格（客观全过 + judge≥80）' : '⚠️ 客观通过但质量待提升（judge<80）';
  } else {
    verdict = `✅ 客观验证通过（${verify.passRate}%）`;
  }
  console.log(`🎯 综合判定：${verdict}`);
  console.log('─'.repeat(64));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith('-'));
  const withJudge = args.includes('--judge');
  const withMetrics = args.includes('--metrics');
  const withDashboard = args.includes('--dashboard');
  if (paths.length === 0) {
    console.error('用法: npx tsx src/run-task.ts <task.json> [--judge] [--metrics] [--dashboard]');
    process.exit(1);
  }
  for (const p of paths) {
    try {
      await runOne(p, withJudge, withMetrics, withDashboard);
    } catch (e) {
      console.error(`任务 ${p} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(`致命错误：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
