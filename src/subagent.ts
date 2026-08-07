/**
 * Sub-agent：把「跑一个子 runLoop」包装成工具，让主 agent 能委派与并行扇出。
 *
 * 架构（philschmid 的 inline 模式 + 并行扇出）：
 *   - delegate(task)：启动一个独立子 runLoop（独立记忆、受控步数），结果回填。
 *   - delegate_parallel(tasks)：用 fanOut 并发跑多个子 agent，聚合后回填。
 *
 * Trace 嵌套：子 runLoop 复用主 loop 的 Tracer 实例，且在父 tool span 仍 open 时
 * 启动——由于 Tracer 用「当前 span 栈」自动建立父子关系，子 runLoop 的 root span
 * 会自然成为父 tool span 的 child，形成「主 loop → tool(delegate) → 子 run → 子 step」层级。
 * OTel 导出后可在 Jaeger 看到完整调用树。
 *
 * 递归深度护栏：每个子 agent 携带 depth，达 LOOP_SUBAGENT_MAX_DEPTH 则拒绝再委派，
 * 防止子 agent 无限递归 delegate 把栈/成本打爆。
 */

import { env, envInt } from './env.ts';
import { fanOut } from './fanout.ts';
import { runLoop } from './loop.ts';
import type { Tracer } from './trace.ts';
import type { AnyToolDef, ApprovalDecision, ApprovalRequest, LLMClient, LoopEvent, ToolDef } from './types.ts';

/** 子 agent 运行所需的依赖（由主 loop 注入，通过闭包捕获） */
export interface SubAgentDeps {
  llm: LLMClient;
  /** 子 agent 可用的工具（通常去掉 delegate 自身以辅助限流递归） */
  tools: ToolDef[];
  system: string;
  /** 主 loop 的 tracer，用于 trace 嵌套 */
  tracer?: Tracer;
  /** 主 loop 的事件广播（子 agent 的事件冒泡给上层） */
  onEvent?: (e: LoopEvent) => void;
  /** 主 loop 的审批钩子：传递给子 agent，使其调需审批工具时能正常审批（否则 auto 模式放行、strict 模式被拒） */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

function resolveSubMaxSteps(): number {
  // 默认 8：经验证，子 agent 需「调 1+ 工具 + 读结果 + 总结」至少 3-4 步，
  // 若涉及多次工具调用（如逐步计算）会更多。4 步过紧会导致子任务退化为主 agent 手动补救
  // （见全梯度任务 A 的 judge 诊断）。8 步给子任务留足空间，又不过度消耗 token。
  // 用 envInt 而非 Number(env)||8：后者会把合法的 0（=子 agent 立即停止）当 falsy 吞掉。
  return envInt('LOOP_SUBAGENT_MAX_STEPS', 8, 1);
}
function resolveSubMaxDepth(): number {
  // maxDepth=0 表示禁止子 agent 再 delegate（叶子节点）；envInt 正确保留 0。
  return envInt('LOOP_SUBAGENT_MAX_DEPTH', 3, 0);
}

/** 子 agent 的系统提示模板 */
function subSystemPrompt(parentSystem: string, depth: number): string {
  return [
    parentSystem,
    '',
    `你是一个被委派的子助手（递归深度 ${depth}）。专注于完成给你的具体子任务，`,
    '用尽量少的步骤给出答案。如非必要，不要再委派其他子 agent。',
  ].join('\n');
}

/**
 * 跑一个子 agent。
 * 独立记忆（不复用父记忆）、受控步数、复用父 tracer 以嵌套 trace。
 */
async function runSubAgent(
  deps: SubAgentDeps,
  task: string,
  depth: number,
  signal?: AbortSignal,
): Promise<string> {
  if (depth >= resolveSubMaxDepth()) {
    return `已达最大委派深度（${resolveSubMaxDepth()}），无法再委派子 agent。`;
  }
  // 子 agent 的工具：若仍含 delegate，传入更深的 depth 以辅助限流
  const childTools = makeSubAgentTools(deps, depth + 1);
  const tools = [...deps.tools.filter((t) => !t.name.startsWith('delegate')), ...childTools];

  const { answer, stopReason } = await runLoop({
    llm: deps.llm,
    tools,
    system: subSystemPrompt(deps.system, depth),
    user: task,
    maxSteps: resolveSubMaxSteps(),
    stream: false, // 子 agent 不流式，结果整体回填给父
    tracer: deps.tracer,
    onEvent: deps.onEvent,
    onApproval: deps.onApproval, // 传递审批钩子，使子 agent 调需审批工具时能正常审批
  });
  void signal;
  return stopReason === 'final' ? answer : `子 agent 未能给出最终答案（${stopReason}）：${answer}`;
}

/**
 * 创建 delegate / delegate_parallel 工具。
 * depth 用于递归限流：主 loop 注入 depth=1，子 agent 注入更深的 depth。
 */
export function makeSubAgentTools(deps: SubAgentDeps, depth = 1): AnyToolDef[] {
  const delegateTool: AnyToolDef = {
    name: 'delegate',
    description:
      '把一个子任务委派给一个子 agent 独立完成。适合需要多步推理、但不值得你亲自展开的子问题。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给子 agent 的具体子任务描述' },
      },
      required: ['task'],
    },
    async execute({ task }) {
      try {
        const result = await runSubAgent(deps, String(task), depth);
        return { ok: true, output: result };
      } catch (e) {
        return { ok: false, output: `子 agent 执行异常：${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };

  const delegateParallelTool: AnyToolDef = {
    name: 'delegate_parallel',
    description:
      '并行委派多个子任务给多个子 agent（扇出/收集）。适合同时查多个独立来源、或对多个输入分别处理。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '子任务列表',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '子任务标识' },
              task: { type: 'string', description: '子任务描述' },
            },
            required: ['task'],
          },
        },
      },
      required: ['tasks'],
    },
    async execute({ tasks }) {
      const list = (tasks as Array<{ id?: string; task: string }>) ?? [];
      if (list.length === 0) {
        return { ok: false, output: 'tasks 不能为空' };
      }
      const fanTasks = list.map((t, i) => ({ id: t.id ?? `t${i + 1}`, input: t.task }));
      const timeoutMs = Number(env('LOOP_SUBAGENT_TIMEOUT_MS', '30000')) || 30000;
      const maxConcurrency = Number(env('LOOP_SUBAGENT_MAX_CONCURRENT', '0')) || 0;
      const result = await fanOut(
        fanTasks,
        async (task) => runSubAgent(deps, task.input, depth),
        { timeoutMs, maxConcurrency: maxConcurrency || undefined },
      );
      return { ok: result.failed === 0, output: result.summary };
    },
  };

  return [delegateTool, delegateParallelTool];
}
