#!/usr/bin/env tsx
/**
 * Agent Loop CLI 入口。
 *
 * 用法：
 *   npm run cli                          # 交互式 REPL
 *   npm run cli -- "你的问题"             # 单次问答
 *   npm run cli -- -q "问题"             # 显式单次问答
 *   npm run cli -- --no-stream "问题"    # 关闭流式
 *   npm run cli -- --export-trace        # 单次问答并把 trace 导出到 LOOP_OTEL_ENDPOINT
 *
 * REPL 命令：
 *   /help / /tools     帮助 / 列出工具
 *   /stats / /trace    最近一次运行的 token 耗时 / span 树
 *   /sessions          列出已保存会话
 *   /save [标题]       保存当前会话
 *   /load <id>         加载某个会话
 *   /new               新建空会话
 *   /export-trace      把最近一次 trace 导出到 OTel 端点
 *   /clear / /exit     清空记忆 / 退出
 *
 * 集成能力：流式 / 自动压缩 / span 可观测 / sub-agent 委派 / 会话持久化 / OTel 导出。
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { loadEnv, env } from './env.ts';
import { evaluateTrajectory, renderEval } from './eval.ts';
import { exportTrace } from './otel.ts';
import { renderTrajectory } from './trajectory.ts';
import { TraceStore, makeTraceRecord, newTraceId } from './trace-store.ts';
import { makeSession, newSessionId, FileSessionStore } from './storage-file.ts';
import { makeSubAgentTools, type SubAgentDeps } from './subagent.ts';
import { createLLM } from './llm.ts';
import { runLoop, type RunLoopOutput } from './loop.ts';
import { Memory } from './memory.ts';
import { costOf, renderSpanTree } from './trace.ts';
import { loadAllTools, registerCleanup } from './tools/load-all.ts';
import type { AnyToolDef, LLMClient, LoopEvent, ToolDef } from './types.ts';

const SYSTEM_PROMPT = [
  '你是一个通用助手，可以通过调用工具来获取信息或执行计算。',
  '遇到复杂任务时，可以用 delegate / delegate_parallel 把子任务委派给子 agent。',
  '遇到事实性问题（如当前时间、算术计算、网页内容）请优先使用工具。',
  '当已有足够信息时，直接给出最终答案，不要再调用工具。',
  '回答使用中文，简洁清晰。',
].join('\n');

/** 渲染单条循环事件为终端输出（流式增量单独累积打印，不在这里处理） */
function renderEvent(ev: LoopEvent): void {
  switch (ev.type) {
    case 'thinking':
      console.log(`\n  💭 [step ${ev.step}] ${ev.message}`);
      break;
    case 'tool_call':
      console.log(
        `  🔧 [step ${ev.step}] 调用工具 ${ev.call.name}(${JSON.stringify(ev.call.arguments)})`,
      );
      break;
    case 'tool_result':
      console.log(`  📋 [step ${ev.step}] 结果：${ev.result.ok ? '✅' : '❌'} ${ev.result.output}`);
      break;
    case 'compact':
      console.log(
        `  🗜️  [step ${ev.step}] 上下文压缩：${ev.beforeMessages}条→${ev.afterMessages}条，` +
          `${ev.beforeTokens}→${ev.afterTokens} token`,
      );
      break;
    case 'approval_request':
      console.log(
        `\n  🔐 [step ${ev.step}] 高风险工具 ${ev.call.name} 请求执行，参数：${JSON.stringify(ev.call.arguments)}`,
      );
      break;
    case 'approval_result':
      console.log(
        `  ${ev.decision.approved ? '✅ 已批准' : '❌ 已拒绝'}` +
          (ev.decision.approved ? '' : `（${ev.decision.reason}）`),
      );
      break;
    case 'max_steps':
      console.log(`  ⛔ 达到最大步数（${ev.steps}），未能给出最终答案。`);
      break;
    case 'error':
      console.log(`  ⛔ ${ev.message}`);
      break;
    case 'usage':
    case 'stream_delta':
    case 'final':
      break; // 静默或外层处理
  }
}

/** 构建本轮可用的工具集：传入的工具 + sub-agent 委派工具 */
function buildTools(baseTools: AnyToolDef[], llm: LLMClient, onApproval?: (req: import('./types.ts').ApprovalRequest) => Promise<import('./types.ts').ApprovalDecision>): AnyToolDef[] {
  const deps: SubAgentDeps = {
    llm,
    tools: baseTools as ToolDef[],
    system: SYSTEM_PROMPT,
    onApproval,
  };
  const subTools = makeSubAgentTools(deps);
  return [...baseTools, ...subTools];
}

/**
 * 构造 HITL 审批钩子：用给定 readline 在终端问 y/n。
 * 单次问答与 REPL 共用此工厂，逻辑一致。
 */
function makeApproval(
  rl: import('node:readline/promises').Interface,
): (req: import('./types.ts').ApprovalRequest) => Promise<import('./types.ts').ApprovalDecision> {
  return async (req) => {
    const prompt = `  🤔 是否允许执行工具「${req.toolName}」？(y/N) › `;
    try {
      const ans = (await rl.question(prompt)).trim().toLowerCase();
      if (ans === 'y' || ans === 'yes') return { approved: true };
      return { approved: false, reason: ans ? `用户回答 ${ans}` : '用户未确认' };
    } catch {
      // readline 出错（如被中断）视为拒绝，安全优先
      return { approved: false, reason: '审批被中断' };
    }
  };
}

/** 一次 ask 的返回：runLoop 结果 + 本次轨迹持久化 id（供 /replay /eval 引用） */
interface AskResult {
  result: RunLoopOutput;
  traceId: string | null;
}

/** 运行一轮循环，流式实时打印最终答案文本 */
async function ask(
  llm: LLMClient,
  memory: Memory,
  user: string,
  stream: boolean,
  tools: AnyToolDef[],
  onApproval?: (req: import('./types.ts').ApprovalRequest) => Promise<import('./types.ts').ApprovalDecision>,
): Promise<AskResult> {
  let streamingAnswer = false;
  const onEvent = (ev: LoopEvent) => {
    if (ev.type === 'stream_delta') {
      if (!streamingAnswer) {
        streamingAnswer = true;
        process.stdout.write('\n🤖 Agent：');
      }
      process.stdout.write(ev.text);
      return;
    }
    if (ev.type === 'final' && streamingAnswer) {
      process.stdout.write('\n\n');
      return;
    }
    renderEvent(ev);
  };

  const result = await runLoop({ llm, tools, system: SYSTEM_PROMPT, user, memory, stream, onEvent, onApproval });

  // 轨迹持久化：默认开启，把含内容捕获的完整 trace 落盘，供 /replay /eval 离线使用
  let traceId: string | null = null;
  if (env('LOOP_TRACE_PERSIST', '1') !== '0' && result.trace) {
    try {
      traceId = newTraceId();
      const record = makeTraceRecord(traceId, result, user);
      if (record) await new TraceStore().save(record);
      else traceId = null;
    } catch {
      traceId = null; // 持久化失败不影响主流程
    }
  }

  if (!streamingAnswer) {
    const tag =
      result.stopReason === 'final'
        ? `${result.steps} 步`
        : result.stopReason === 'max_steps'
          ? '步数耗尽'
          : '出错';
    console.log(`\n🤖 Agent（${tag}）：\n${result.answer}\n`);
  }
  return { result, traceId };
}

// —————————— 会话持久化 ——————————

const store = new FileSessionStore();

async function cmdSessions(): Promise<void> {
  const list = await store.list();
  if (list.length === 0) {
    console.log('（暂无已保存会话）\n');
    return;
  }
  console.log('\n已保存会话：');
  for (const m of list) {
    console.log(`  ${m.id}  [${m.messageCount}条]  ${m.title}  (${m.updatedAt.slice(0, 19)})`);
  }
  console.log('');
}

async function cmdSave(memory: Memory, currentId: string, title?: string): Promise<string> {
  const session = makeSession(currentId, memory.systemPrompt, memory, title);
  await store.save(currentId, session);
  console.log(`💾 已保存会话 ${currentId}（${session.title}）\n`);
  return currentId;
}

async function cmdLoad(id: string): Promise<Memory | null> {
  const session = await store.load(id);
  if (!session) {
    console.log(`⚠️  找不到会话 ${id}\n`);
    return null;
  }
  const mem = Memory.fromMessages(session.messages);
  console.log(`📂 已加载会话 ${id}（${session.title}，${session.messages.length} 条消息）\n`);
  return mem;
}

async function cmdExportTrace(result: RunLoopOutput | null): Promise<void> {
  if (!result || !result.trace) {
    console.log('（没有可导出的 trace）\n');
    return;
  }
  const r = await exportTrace(result.trace);
  if (r.exported) {
    console.log(`📤 已导出 ${r.spanCount} 个 span 到 OTel 端点\n`);
  } else {
    console.log(`⚠️  未导出：${r.error ?? '未配置 LOOP_OTEL_ENDPOINT'}\n`);
  }
}

// —————————— 轨迹回放与评估 ——————————

const traceStore = new TraceStore();

async function cmdTraces(): Promise<void> {
  const list = await traceStore.list();
  if (list.length === 0) {
    console.log('（暂无历史轨迹）\n');
    return;
  }
  console.log('\n历史轨迹：');
  for (const m of list) {
    console.log(
      `  ${m.id}  [${m.steps}步]  ${m.userQuestion || '(无问题)'} → ${m.answer || '(无答案)'}  (${m.createdAt.slice(0, 19)})`,
    );
  }
  console.log('');
}

async function cmdReplay(id: string | null): Promise<void> {
  if (!id) {
    console.log('（请指定轨迹 id：/replay <id>，或先问一个问题）\n');
    return;
  }
  const record = await traceStore.load(id);
  if (!record) {
    console.log(`⚠️  找不到轨迹 ${id}\n`);
    return;
  }
  console.log(`\n🎬 回放轨迹 ${id}（${record.steps}步，${record.stopReason}）：`);
  console.log(`   问题：${record.userQuestion}`);
  console.log(`   答案：${record.answer}\n`);
  console.log(renderTrajectory(record.trace));
  console.log('');
}

async function cmdEval(llm: LLMClient, traceId: string | null): Promise<void> {
  if (!traceId) {
    console.log('（请先用 /replay 指定轨迹，或先问一个问题产生轨迹）\n');
    return;
  }
  const record = await traceStore.load(traceId);
  if (!record) {
    console.log(`⚠️  找不到轨迹 ${traceId}\n`);
    return;
  }
  console.log(`\n🔍 用 LLM 评估轨迹 ${traceId}…`);
  try {
    const result = await evaluateTrajectory(record.trace, { llm });
    console.log(renderEval(result));
    console.log('');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`⚠️  评估失败：${msg}\n`);
  }
}

function printHelp(): void {
  console.log(`
可用命令：
  /help              查看本帮助
  /tools             列出可用工具
  /stats             最近一次运行的 token 与耗时
  /trace             最近一次运行的 span 树
  /sessions          列出已保存会话
  /save [标题]       保存当前会话
  /load <id>         加载某个会话
  /new               新建空会话
  /export-trace      把最近一次 trace 导出到 OTel 端点
  /traces            列出历史运行轨迹
  /replay [id]       回放某次运行（含每步决策），默认最近一次
  /eval              用 LLM 评估最近一次轨迹（多维打分）
  /clear             清空当前会话记忆
  /exit              退出（等同 Ctrl+C）
其它输入将作为问题发送给 Agent。
`);
}

function printTools(tools: AnyToolDef[]): void {
  console.log('\n可用工具：');
  for (const t of tools) {
    const params = Object.keys(t.parameters.properties).join(', ') || '(无参数)';
    const flag = t.requiresApproval ? ' ⚠️需审批' : '';
    console.log(`  • ${t.name}(${params}) — ${t.description}${flag}`);
  }
  console.log('');
}

function printStats(result: RunLoopOutput | null): void {
  if (!result) {
    console.log('（还没有运行记录，先问一个问题吧）\n');
    return;
  }
  const u = result.totalUsage;
  const inPrice = Number(env('LOOP_PRICE_INPUT_PER_1K', '0'));
  const outPrice = Number(env('LOOP_PRICE_OUTPUT_PER_1K', '0'));
  const cost = costOf(u, inPrice, outPrice);
  console.log(
    `\n📊 最近一次运行：` +
      `\n   步数：${result.steps}（${result.stopReason}）` +
      `\n   Token：输入 ${u.promptTokens} + 输出 ${u.completionTokens} = ${u.totalTokens}` +
      (inPrice || outPrice ? `\n   估算成本：$${cost.toFixed(6)}` : '') +
      `\n`,
  );
}

async function repl(llm: LLMClient, stream: boolean): Promise<void> {
  let memory = new Memory(SYSTEM_PROMPT);
  let currentSessionId = newSessionId();
  let lastResult: RunLoopOutput | null = null;
  let lastTraceId: string | null = null;
  const rl = createInterface({ input, output });

  // HITL 审批钩子：高风险工具执行前在终端问 y/n。同步阻塞，符合「高后果动作」语义。
  const onApproval = makeApproval(rl);
  // A1: 加载工具（内置 + MCP 若配置了）
  const { tools: loadedTools, closeAll } = await loadAllTools();
  registerCleanup(closeAll);
  // 工具集含 sub-agent 委派，且把审批钩子透传给子 agent
  const tools = buildTools(loadedTools, llm, onApproval);

  console.log('🤖 Agent Loop 交互模式已启动。输入 /help 查看命令，Ctrl+C 退出。\n');

  while (true) {
    let answer: string;
    try {
      answer = await rl.question('你 › ');
    } catch {
      break;
    }
    const line = answer.trim();
    if (!line) continue;

    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') {
      printHelp();
      continue;
    }
    if (line === '/tools') {
      printTools(tools);
      continue;
    }
    if (line === '/stats') {
      printStats(lastResult);
      continue;
    }
    if (line === '/trace') {
      if (!lastResult?.trace) console.log('（没有 trace）\n');
      else {
        console.log('\n🌳 Span 树：');
        console.log(renderSpanTree(lastResult.trace));
        console.log('');
      }
      continue;
    }
    if (line === '/sessions') {
      await cmdSessions();
      continue;
    }
    if (line.startsWith('/save')) {
      const title = line.slice(5).trim() || undefined;
      currentSessionId = await cmdSave(memory, currentSessionId, title);
      continue;
    }
    if (line.startsWith('/load ')) {
      const id = line.slice(6).trim();
      const loaded = await cmdLoad(id);
      if (loaded) {
        memory = loaded;
        currentSessionId = id;
      }
      continue;
    }
    if (line === '/new') {
      memory = new Memory(SYSTEM_PROMPT);
      currentSessionId = newSessionId();
      lastResult = null;
      lastTraceId = null;
      console.log('🆕 已新建空会话。\n');
      continue;
    }
    if (line === '/export-trace') {
      await cmdExportTrace(lastResult);
      continue;
    }
    if (line === '/traces') {
      await cmdTraces();
      continue;
    }
    if (line.startsWith('/replay')) {
      const id = line.slice(7).trim() || lastTraceId;
      await cmdReplay(id);
      continue;
    }
    if (line === '/eval') {
      await cmdEval(llm, lastTraceId);
      continue;
    }
    if (line === '/clear') {
      memory.clear(SYSTEM_PROMPT);
      lastResult = null;
      lastTraceId = null;
      console.log('🧹 已清空会话记忆。\n');
      continue;
    }

    try {
      const askResult = await ask(llm, memory, line, stream, tools, onApproval);
      lastResult = askResult.result;
      lastTraceId = askResult.traceId;
      // runLoop 结束后若开启自动导出，best-effort 导出
      if (lastResult.trace && env('LOOP_OTEL_EXPORT', '0') === '1') {
        await exportTrace(lastResult.trace);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\n⛔ 运行出错：${msg}\n`);
    }
  }

  rl.close();
}

async function main(): Promise<void> {
  loadEnv();
  const llm = createLLM();
  const argv = process.argv.slice(2);
  const noStream = argv.includes('--no-stream');
  const stream = !noStream;
  const questionArgs = argv.filter((a) => !a.startsWith('-'));

  if (questionArgs.length > 0) {
    const question = argv.includes('-q') || argv.includes('--once') ? questionArgs[0] ?? '' : questionArgs.join(' ');
    // 单次问答模式也支持 HITL 审批（创建临时 readline），并把钩子透传给 sub-agent
    const onceRl = createInterface({ input, output });
    const onApproval = makeApproval(onceRl);
    const { tools: onceLoaded, closeAll: onceClose } = await loadAllTools();
    registerCleanup(onceClose);
    const tools = buildTools(onceLoaded, llm, onApproval);
    const memory = new Memory(SYSTEM_PROMPT);
    const askResult = await ask(llm, memory, question, stream, tools, onApproval);
    onceRl.close();
    // 单次问答模式：若指定 --export-trace 则导出
    if (argv.includes('--export-trace') && askResult.result.trace) {
      await cmdExportTrace(askResult.result);
    }
  } else {
    await repl(llm, stream);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`致命错误：${msg}`);
  process.exit(1);
});
