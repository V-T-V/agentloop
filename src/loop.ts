/**
 * Agent 主循环：Think → Act → Observe，串行往复直到收敛或触及步数上限。
 *
 * 本模块集成了三大前沿能力（均可关闭，关闭后退化回朴素 loop）：
 * 1. 上下文工程：每步 LLM 调用前检查双重阈值，达阈则 auto-compact。
 * 2. 流式输出：默认流式，逐 token 通过 onEvent(stream_delta) 广播。
 * 3. 可观测性：每步/每次 LLM/工具/压缩都包成 span，结束时返回完整 trace 树。
 * 外加健壮性：工具入参 schema 校验（失败回填友好错误而非抛出）。
 *
 * 设计原则（Anthropic《Building Effective Agents》、Claude Code 架构）：
 * - 单线程主循环，平坦消息历史。
 * - 工具错误永不抛出：失败也作为结果回填。
 * - 同一步内多个独立工具调用并发执行，回填顺序按 tool_calls 原顺序。
 */

import { compactMemory, loadCompactConfig, shouldCompact, type CompactConfig } from './compact.ts';
import { CheckpointStore, isCompleted, isRecoverable, makeCheckpoint, newRunId } from './checkpoint.ts';
import { BudgetGuard, type BudgetConfig } from './budget.ts';
import { env } from './env.ts';
import { extractText } from './multimodal.ts';
import { Memory } from './memory.ts';
import { formatValidationErrors, validateToolArgs } from './schema.ts';
import { Tracer, ZERO_USAGE, type Span } from './trace.ts';
import { estimateMemoryTokens } from './tokens.ts';
import type {
  AnyToolDef,
  ApprovalDecision,
  ApprovalRequest,
  LLMClient,
  LoopEvent,
  Message,
  StopReason,
  TokenUsage,
  ToolDef,
  ToolResult,
} from './types.ts';

export interface RunLoopInput {
  llm: LLMClient;
  tools: ToolDef[];
  system: string;
  user: string;
  memory?: Memory;
  maxSteps?: number;
  onEvent?: (event: LoopEvent) => void;
  /** 是否使用流式（默认按 LOOP_STREAM，再默认 true） */
  stream?: boolean;
  /** 传入自定义 tracer（否则内部新建；LOOP_TRACE=0 可关闭） */
  tracer?: Tracer;
  /** 传入自定义压缩配置 */
  compactConfig?: CompactConfig;
  /**
   * HITL 审批钩子：高风险工具（requiresApproval）执行前调用。
   * - 不传（undefined）：默认放行（向后兼容；LOOP_HITL_MODE=strict 时改为拒绝）。
   * - 传了：返回 approved:false 则跳过执行并把拒绝原因回填给 LLM。
   */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /**
   * Durable 执行配置：启用后，每个 step 末尾落盘检查点；进程崩溃重启时，
   * 传入相同 runId 即可从最近检查点续跑，不丢已完成步骤。
   * - 不传（undefined）：纯内存态，行为与原版完全一致（向后兼容）。
   * - 传入：激活 checkpoint-and-resume（长程任务专用）。
   */
  durable?: DurableConfig;
  /**
   * 成本预算控制：限制单次 runLoop 的总 token 消耗，防长任务费用失控。
   * - 不传（undefined）：无预算限制（向后兼容）。
   * - 传入：每次 LLM 调用后累加，达 maxTotalTokens 则优雅终止（stopReason='budget_exceeded'）。
   */
  budget?: BudgetConfig;
}

/**
 * Durable 执行配置：控制检查点持久化与崩溃恢复。
 *
 * 设计依据 research/long-running-agents.md：
 * - runId：同一逻辑任务跨多次进程共享，崩溃后续跑时传入相同值。
 * - store：检查点存储后端（默认文件实现）。
 * - resume：true=检测到未完成检查点则续跑；false=忽略检查点全新开始。
 * - onCheckpoint：每次落盘后回调，供可观测性/日志使用。
 */
export interface DurableConfig {
  /** 运行 id；不传则自动生成（但崩溃恢复需调用方记住它，故一般显式传入） */
  runId?: string;
  /** 检查点存储；不传则用默认 CheckpointStore（LOOP_CHECKPOINT_DIR） */
  store?: CheckpointStore;
  /** 是否启用恢复：true 则入口处加载未完成检查点并续跑（默认 true） */
  resume?: boolean;
  /** 每次落盘后的回调（用于日志/进度展示；如 step=5 已存盘） */
  onCheckpoint?: (info: { runId: string; step: number; savedAt: string }) => void;
}

export interface RunLoopOutput {
  answer: string;
  steps: number;
  stopReason: StopReason;
  memory: Memory;
  /** 完整 trace（若启用）；未启用则 null */
  trace: Span | null;
  /** 本次运行的累计 token 用量 */
  totalUsage: TokenUsage;
}

/** 解析 maxSteps：优先入参，其次环境变量，默认 8 */
function resolveMaxSteps(explicit?: number): number {
  const candidates = [explicit, Number(env('LOOP_MAX_STEPS', '8'))];
  for (const c of candidates) {
    if (Number.isFinite(c) && (c as number) > 0) return c as number;
  }
  return 8;
}

/** 解析是否流式：优先入参，其次环境变量，默认 true */
function resolveStream(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return env('LOOP_STREAM', '1') !== '0';
}

/**
 * 执行单个工具调用的上下文：含 HITL 审批相关回调。
 * 审批门逻辑集中在此，所有工具（含 sub-agent delegate）自动受益。
 */
interface ExecuteContext {
  step: number;
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  emit: (e: LoopEvent) => void;
  /** 当前工具的 span（用于把审批决策等内容写回 trace，实现轨迹级捕获） */
  tracer: Tracer;
  toolSpan: Span | null;
}

/**
 * 执行单个工具调用：先 HITL 审批（若标记高风险）→ schema 校验 → 执行；捕获一切异常，永不抛出。
 * 全程把审批决策、参数、结果写入 toolSpan（若有），供轨迹回放与评估。
 */
async function executeTool(
  tools: AnyToolDef[],
  call: { name: string; arguments: unknown },
  ctx: ExecuteContext,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return { ok: false, output: `错误：未知工具「${call.name}」` };
  }

  // 捕获工具入参（供轨迹回放）
  ctx.tracer.setAttribute(ctx.toolSpan, 'input.arguments', call.arguments);
  ctx.tracer.setAttribute(ctx.toolSpan, 'requiresApproval', !!tool.requiresApproval);

  // —— HITL 审批门：高风险工具执行前先请求人确认 ——
  const callId = (call as { id?: string }).id ?? '';
  if (tool.requiresApproval) {
    const strict = env('LOOP_HITL_MODE', 'auto') === 'strict';
    // 无钩子时：auto 模式放行（向后兼容），strict 模式拒绝（更安全）
    if (ctx.onApproval) {
      ctx.emit({ type: 'approval_request', step: ctx.step, call: { id: callId, name: call.name, arguments: call.arguments as Record<string, unknown> } });
      const decision = await ctx.onApproval({
        toolName: call.name,
        arguments: call.arguments as Record<string, unknown>,
        step: ctx.step,
      });
      // 捕获审批决策（轨迹级：事后能回放「人为什么拒绝/批准」）
      ctx.tracer.setAttribute(ctx.toolSpan, 'approval.decision', decision);
      ctx.tracer.setAttribute(ctx.toolSpan, 'approval.mode', 'interactive');
      ctx.emit({ type: 'approval_result', step: ctx.step, callId, decision });
      if (!decision.approved) {
        return { ok: false, output: `用户拒绝执行工具「${call.name}」：${decision.reason}` };
      }
    } else if (strict) {
      ctx.tracer.setAttribute(ctx.toolSpan, 'approval.decision', { approved: false, reason: 'strict 模式无钩子' });
      return { ok: false, output: `安全策略拒绝执行高风险工具「${call.name}」（未配置审批钩子，strict 模式）` };
    }
    // auto + 无钩子 → 放行，继续执行
  }

  // —— schema 校验：失败回填友好错误，让 LLM 能据此修正 ——
  const validation = validateToolArgs(call.arguments, tool.parameters);
  if (!validation.ok) {
    return { ok: false, output: formatValidationErrors(validation) };
  }
  try {
    return await tool.execute(call.arguments as Record<string, unknown>);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: `工具「${call.name}」执行异常：${msg}` };
  }
}

export async function runLoop(input: RunLoopInput): Promise<RunLoopOutput> {
  const emit = input.onEvent ?? (() => {});
  const maxSteps = resolveMaxSteps(input.maxSteps);
  const stream = resolveStream(input.stream);
  const tracer = input.tracer ?? new Tracer();
  const compactConfig = input.compactConfig ?? loadCompactConfig();

  // —— Durable 执行：解析配置 + 准备检查点存储 ——
  const durable = input.durable;
  const store = durable?.store ?? (durable ? new CheckpointStore() : undefined);
  const runId = durable?.runId ?? (durable ? newRunId() : '');
  const wantResume = durable?.resume !== false; // 默认 true

  const memory = input.memory ?? new Memory(input.system);
  memory.add({ role: 'user', content: input.user });

  const runSpan = tracer.startSpan('run');
  let totalUsage: TokenUsage = { ...ZERO_USAGE };

  const accumulate = (u: TokenUsage | null) => {
    if (!u) return;
    totalUsage = {
      promptTokens: totalUsage.promptTokens + u.promptTokens,
      completionTokens: totalUsage.completionTokens + u.completionTokens,
      totalTokens: totalUsage.totalTokens + u.totalTokens,
    };
  };

  let stopReason: RunLoopOutput['stopReason'] = 'final';
  let answer = '';
  let lastStep = 0;
  /** 循环起始 step（恢复时 > 1，全新开始时 = 1） */
  let startStep = 1;
  /** 是否本次执行为崩溃后恢复 */
  let resumed = false;

  // —— 预算守卫：创建累加器（配置传入时才启用）——
  const budgetGuard = input.budget ? new BudgetGuard(input.budget) : null;

  // —— Durable：入口恢复检测 ——
  if (durable && store && wantResume) {
    const ckpt = await store.load(runId);
    if (ckpt) {
      // 已完成的检查点：直接返回结果，不重复执行
      if (isCompleted(ckpt) && ckpt.answer) {
        emit({ type: 'final', answer: ckpt.answer } as LoopEvent);
        return {
          answer: ckpt.answer,
          steps: ckpt.step,
          stopReason: ckpt.stopReason!,
          memory: Memory.fromMessages(ckpt.messages),
          trace: tracer.getRoot(),
          totalUsage: ckpt.totalUsage,
        };
      }
      // 未完成且可恢复：从 checkpoint 续跑
      if (isRecoverable(ckpt)) {
        const recovered = Memory.fromMessages(ckpt.messages);
        // 用恢复的 memory 替换当前（保留重建的对话历史）
        memory.clear(recovered.systemPrompt);
        for (const m of recovered.serializeMessages()) {
          if (m.role !== 'system') memory.add(m);
        }
        totalUsage = { ...ckpt.totalUsage };
        startStep = ckpt.step + 1;
        lastStep = ckpt.step;
        resumed = true;
        // 恢复预算快照：跨恢复延续累计 token 消耗（不重置）
        if (budgetGuard && ckpt.budgetSnapshot) {
          // 用快照重建 guard，使 spent 从崩溃前的值继续
          budgetGuard.restore(ckpt.budgetSnapshot.spent, ckpt.budgetSnapshot.warningIssued);
        }
        // 恢复后若已超出 maxSteps，视作 max_steps
        if (startStep > maxSteps) {
          return {
            answer: ckpt.answer || '已达到最大推理步数，Agent 未能给出最终答案。',
            steps: ckpt.step,
            stopReason: 'max_steps',
            memory,
            trace: tracer.getRoot(),
            totalUsage,
          };
        }
      }
    }
  }

  // —— Durable：每步落盘的内部辅助 ——
  const saveCheckpoint = async (step: number, finalReason?: StopReason, finalAnswer?: string) => {
    if (!durable || !store) return;
    const ckpt = makeCheckpoint({
      runId,
      step,
      maxSteps,
      messages: memory.serializeMessages(),
      totalUsage,
      stopReason: finalReason,
      answer: finalAnswer,
      // 预算快照：跨恢复延续累计 token 消耗
      budgetSnapshot: budgetGuard
        ? { spent: budgetGuard.current, warningIssued: false }
        : undefined,
    });
    await store.save(ckpt);
    durable.onCheckpoint?.({ runId, step, savedAt: ckpt.savedAt });
  };

  try {
    tracer.setAttribute(runSpan, 'durable.resumed', resumed);
    tracer.setAttribute(runSpan, 'durable.runId', durable ? runId : '');
    for (let step = startStep; step <= maxSteps; step++) {
      lastStep = step;
      const stepSpan = tracer.startSpan('step', { step });

      // —— 上下文工程：每步前检查是否需要压缩 ——
      if (shouldCompact(memory, compactConfig)) {
        const compactSpan = tracer.startSpan('compact', { step });
        const beforeTokens = estimateMemoryTokens(memory.snapshot());
        const result = await compactMemory(memory, input.llm, compactConfig);
        // 捕获压缩摘要（轨迹级：能回放历史被压成了什么）
        tracer.endSpan(compactSpan, {
          before: beforeTokens,
          after: estimateMemoryTokens(memory.snapshot()),
          performed: result.performed,
          summary: result.summary,
          beforeMessages: result.beforeMessages,
          afterMessages: result.afterMessages,
        });
        if (result.performed) {
          emit({
            type: 'compact',
            step,
            beforeTokens: result.beforeTokens,
            afterTokens: result.afterTokens,
            beforeMessages: result.beforeMessages,
            afterMessages: result.afterMessages,
          });
        }
      }

      // —— Think：调用 LLM（流式或非流式）——
      const llmSpan = tracer.startSpan('llm', { step });
      let assistantMessage: Message;
      let usage: TokenUsage | null;
      const messages = memory.snapshot();
      // 捕获 LLM 输入（轨迹级：能看到模型每步「看到了什么」）
      tracer.setAttribute(llmSpan, 'input.tools', input.tools.map((t) => t.name));
      tracer.setAttribute(llmSpan, 'input.messages', messages);
      try {
        if (stream && input.llm.supportsStream) {
          const res = await input.llm.chatStream(
            { messages, tools: input.tools },
            {
              // 仅当本回合不产生工具调用时才广播流式增量——
              // 但此处还无法预知，故先用标志位：若结果含 toolCalls，则撤销已推送的增量。
              // 简化处理：工具调用步骤的 content 是内部思考，不流式广播。
              onToken: () => {
                /* 默认不广播，下方按是否收敛决定 */
              },
            },
          );
          assistantMessage = res.message;
          usage = res.usage;
          // 仅最终答案（无工具调用）才把内容流式广播。多模态：提取纯文本
          if (!assistantMessage.toolCalls?.length && assistantMessage.content) {
            emit({ type: 'stream_delta', step, text: extractText(assistantMessage.content) });
          }
        } else {
          const res = await input.llm.chat({ messages, tools: input.tools });
          assistantMessage = res.message;
          usage = res.usage;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 捕获错误信息（轨迹级：能看到哪步失败、为何失败）
        tracer.setAttribute(llmSpan, 'error', msg);
        tracer.setError(llmSpan);
        tracer.endSpan(llmSpan);
        tracer.endSpan(stepSpan);
        emit({ type: 'error', message: msg });
        stopReason = 'error';
        answer = `循环因 LLM 调用失败而中止：${msg}`;
        // 🔒 Durable：LLM 失败也落盘（标记 error），下次 resume 从本 step 重试
        // 注意：此时尚未 add assistantMessage，故 checkpoint 的 step = step - 1（上一成功步），
        // resume 时从 step 重新开始，LLM 调用会被重试。
        await saveCheckpoint(step - 1, 'error');
        break;
      }
      tracer.setUsage(llmSpan, usage ?? ZERO_USAGE);
      // 捕获 LLM 输出（轨迹级：能看到模型每步「决定做什么」）
      tracer.setAttribute(llmSpan, 'output.content', assistantMessage.content);
      tracer.setAttribute(llmSpan, 'output.toolCalls', assistantMessage.toolCalls ?? []);
      tracer.endSpan(llmSpan);
      if (usage) {
        accumulate(usage);
        // 预算守卫：累加并检测是否超限
        budgetGuard?.add(usage);
        emit({ type: 'usage', step, usage });
      }

      // —— 预算检查：超限则优雅终止（落盘 checkpoint，下次可调预算续跑）——
      if (budgetGuard?.exhausted()) {
        tracer.endSpan(stepSpan);
        answer = `预算耗尽（已用 ${budgetGuard.current}/${budgetGuard.config.maxTotalTokens} tokens），Agent 优雅终止。`;
        stopReason = 'budget_exceeded';
        // M6: 专用事件类型（不被 dashboard/消费者误计为 error）
        emit({ type: 'budget_exceeded', spent: budgetGuard.current, limit: budgetGuard.config.maxTotalTokens, answer });
        await saveCheckpoint(step, 'budget_exceeded', answer);
        break;
      }

      // —— Act & Observe：有工具调用则执行并回填 ——
      // 注意：assistantMessage.toolCalls?.length 为 0 时（空数组）也落入「无调用」分支，
      // 视为模型给出最终答案——空数组等同未发起调用。
      if (assistantMessage.toolCalls?.length) {
        memory.add(assistantMessage);
        const calls = [...assistantMessage.toolCalls];
        // 同一步的多个工具调用彼此独立，并发执行以提升吞吐。每个调用一完成就立即
        // 广播 tool_call/tool_result 事件（并就地 start/end 自己的 span，让 trace 的
        // 工具耗时统计准确反映并发重叠，而非全部完成后串行补记）——这对 http_get 这类
        // 慢工具尤其重要：调用方不必等全部工具跑完就能拿到实时反馈。
        const settled = await Promise.all(
          calls.map(async (call) => {
            const toolSpan = tracer.startSpan('tool', { step, tool: call.name });
            const ctx: ExecuteContext = { step, onApproval: input.onApproval, emit, tracer, toolSpan };
            const result = await executeTool(input.tools, call, ctx);
            // 捕获工具结果（轨迹级：能看到工具返回了什么）
            tracer.setAttribute(toolSpan, 'output.result', result.output);
            tracer.setAttribute(toolSpan, 'output.ok', result.ok);
            tracer.endSpan(toolSpan, { ok: result.ok });
            emit({ type: 'tool_call', step, call });
            emit({ type: 'tool_result', step, callId: call.id, result });
            return result;
          }),
        );
        // 回填到 memory 严格按 tool_calls 原顺序，保证 LLM 上下文一致
        for (let i = 0; i < calls.length; i++) {
          memory.addToolResult(calls[i]!.id, calls[i]!.name, settled[i]!);
        }
        emit({ type: 'thinking', step, message: '工具调用完成，继续推理…' });
        tracer.endSpan(stepSpan);
        // 🔒 Durable：工具调用步骤完成（memory 已自洽），落盘检查点
        await saveCheckpoint(step);
        continue;
      }

      // —— 收敛：无工具调用，content 即最终答案 ——
      // 模型偶尔返回 content 为 null 或空串（如「仅给出 tool_calls 但数组为空」），
      // 此时给一个明确的占位，避免下游拿到空答案造成困惑。
      answer = extractText(assistantMessage.content).trim() || '(模型未返回内容)';
      memory.add({ role: 'assistant', content: answer });
      emit({ type: 'final', answer });
      tracer.endSpan(stepSpan);
      stopReason = 'final';
      // 🔒 Durable：任务收敛，落盘最终检查点（含 answer，下次同 runId 直接返回）
      await saveCheckpoint(step, 'final', answer);
      break;
    }

    // 循环正常结束但未收敛（达到步数上限）
    if (stopReason === 'final' && answer === '') {
      answer = '已达到最大推理步数，Agent 未能给出最终答案。';
      stopReason = 'max_steps';
      emit({ type: 'max_steps', steps: maxSteps });
      // 🔒 Durable：达上限也落盘（标记 max_steps，下次同 runId 视为完成）
      await saveCheckpoint(lastStep, 'max_steps', answer);
    }
  } finally {
    // 捕获运行级结论（轨迹级：能看到最终答案与停止原因）
    tracer.endSpan(runSpan, { answer, stopReason });
  }

  return {
    answer,
    steps: lastStep,
    stopReason,
    memory,
    trace: tracer.getRoot(),
    totalUsage,
  };
}
