/**
 * M3 嵌入式 SDK 示例 —— 把 agentloop 当库嵌入业务代码
 * =====================================================
 * 对应 PRODUCT.md M3：「补一个"嵌入式 SDK 示例"：外部业务传工具 + 审批钩子 + trace 导出」。
 *
 * 本示例演示外部业务如何把 agentloop 作为运行时嵌入：
 *   1. 传入自定义业务工具（defineTool）
 *   2. 接 HITL 审批钩子（onApproval：高风险工具执行前要人审）
 *   3. 导出 trace（可观测性 / 审计 / 调试）
 *   4. 监听事件（onEvent：流式展示 agent 的 Think/Act/Observe）
 *
 * 离线可跑：未设 LOOP_LLM_API_KEY 时 createLLM() 自动回退 StubLLM，
 * 仍能跑通工具调用 + 审批 + trace 全链路。
 *
 * 运行：
 *   npx tsx examples/m3-embedded-sdk.ts
 *   # 或配了 key：LOOP_LLM_API_KEY=... npx tsx examples/m3-embedded-sdk.ts
 */

import { runLoop } from '../src/loop.ts';
import { createLLM } from '../src/llm.ts';
import { defineTool } from '../src/tools/registry.ts';
import { Tracer, renderSpanTree } from '../src/trace.ts';
import type { LoopEvent } from '../src/loop.ts';
import type { LLMClient, ChatResult, Message, ToolDef, TokenUsage, ResponseFormat } from '../src/types.ts';

// ============================================================
// 1. 业务自定义工具
// ============================================================

/** 低风险工具：查订单状态（直接执行，不需审批） */
const getOrderStatus = defineTool({
  name: 'get_order_status',
  description: '查询订单状态。入参：orderId。',
  parameters: {
    type: 'object',
    properties: { orderId: { type: 'string', description: '订单号' } },
    required: ['orderId'],
    additionalProperties: false,
  },
  async execute(args) {
    // 真实业务这里查数据库；示例用假数据
    const status = args.orderId === 'A001' ? '已发货' : '处理中';
    // ToolResult 要求 { ok, output: string }——output 是喂给 LLM 的序列化文本
    return { ok: true, output: JSON.stringify({ orderId: args.orderId, status }) };
  },
});

/**
 * 高风险工具：退款（requiresApproval=true → 触发 onApproval 钩子）。
 * 业务在审批钩子里决定是否放行（例如金额超阈值要人审）。
 */
const refundOrder = defineTool({
  name: 'refund_order',
  description: '给订单退款。高风险操作，执行前需人工审批。入参：orderId, amount。',
  parameters: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: '订单号' },
      amount: { type: 'number', description: '退款金额（元）' },
    },
    required: ['orderId', 'amount'],
    additionalProperties: false,
  },
  requiresApproval: true,
  async execute(args) {
    // 真实业务这里调支付网关；示例直接返回成功
    return {
      ok: true,
      output: JSON.stringify({ refunded: true, orderId: args.orderId, amount: args.amount }),
    };
  },
});

// ============================================================
// 2. HITL 审批钩子
// ============================================================

/**
 * 业务自定义审批策略：
 *   - 金额 ≤ 100：自动放行（小额免审）
 *   - 金额 > 100：拒绝（示例中"模拟"人审拒绝；真实场景可接 IM/邮件/审批台）
 * 这就是"对齐工程化"在运行时的一环：把高风险动作关进审批笼子。
 */
async function approvalHook(req: {
  toolName: string;
  arguments: Record<string, unknown>;
  step: number;
}): Promise<{ approved: boolean; reason?: string }> {
  const amount = (req.arguments.amount as number) ?? 0;
  console.log(`   [HITL] 审批请求：${req.toolName}(${JSON.stringify(req.arguments)}) @ step ${req.step}`);
  if (amount <= 100) {
    console.log(`   [HITL] → 自动放行（金额 ${amount} ≤ 100，小额免审）`);
    return { approved: true };
  }
  console.log(`   [HITL] → 拒绝（金额 ${amount} > 100，需人工二审，示例中直接拒）`);
  return { approved: false, reason: `退款金额 ${amount} 元超阈值，需人工二审` };
}

// ============================================================
// 3. 事件监听（流式展示 Think/Act/Observe）
// ============================================================

function eventLogger(event: LoopEvent): void {
  // LoopEvent 是 union；按 type 分发打印。对 args/result 做安全序列化。
  // 注意：tool_call 事件结构是 { type, step, call: ToolCall }，ToolCall 用 call.arguments（非 args）。
  const safe = (v: unknown): string => {
    try {
      return JSON.stringify(v).slice(0, 60);
    } catch {
      return String(v).slice(0, 60);
    }
  };
  switch (event.type) {
    case 'think':
      console.log(`  🧠 Think: ${(event.text ?? '').slice(0, 80)}`);
      break;
    case 'tool_call':
      console.log(`  🛠  Act:   调用 ${event.call.name}(${safe(event.call.arguments)})`);
      break;
    case 'tool_result':
      console.log(`  👁  Observe: ${event.result.ok ? '✓' : '✗'} ${safe(event.result.output)}`);
      break;
    case 'approval':
      console.log(`  🔒 Approval: ${event.call.name} ${event.approved ? '已批准' : '已拒绝'}`);
      break;
    default:
      // 其他事件类型（如 final）按需处理
      break;
  }
}

// ============================================================
// 3.5 脚本化演示 LLM（保证示例离线可演示完整链路）
// ============================================================

/**
 * 内置 StubLLM 只识别 datetime/calculator/http_get，不会调本示例的自定义工具。
 * 为了在无 API key 时仍能演示"工具调用 → 审批 → trace"全链路，
 * 这里注入一个极简脚本 LLM：第一回合调 get_order_status，拿到结果后收尾。
 *
 * 真实场景把 demoLLM 换成 createLLM()（接 OpenAI 兼容端点）即可——
 * runLoop 的工具/审批/trace 接口对真实与脚本 LLM 完全一致。
 */
function createDemoLLM(): LLMClient {
  // 0=调 get_order_status；1=拿到状态后调 refund_order（触发审批）；2=收尾
  let phase = 0;
  const usage = (): TokenUsage => ({ promptTokens: 10, completionTokens: 10, totalTokens: 20 });
  return {
    isStub: true,
    supportsStream: false,
    async chat(input: { messages: Message[]; tools: ToolDef[]; responseFormat?: ResponseFormat }): Promise<ChatResult> {
      const last = input.messages[input.messages.length - 1];
      // 上一条是 tool 结果
      if (last?.role === 'tool') {
        if (phase === 1) {
          // 拿到订单状态后，尝试退款（小额 50 元 → 触发审批 → 自动放行）
          phase = 2;
          return {
            message: {
              role: 'assistant',
              content: '[DemoLLM] 订单已发货，客户要退款，我发起 50 元退款（将触发审批）。',
              toolCalls: [{ id: 'call_2', name: 'refund_order', arguments: { orderId: 'A001', amount: 50 } }],
            },
            usage: usage(),
          };
        }
        // 退款结果 → 收尾
        return {
          message: { role: 'assistant', content: `[DemoLLM] 退款已处理：${JSON.stringify(last.content).slice(0, 60)}` },
          usage: usage(),
        };
      }
      // 第一回合 → 调 get_order_status
      if (phase === 0) {
        phase = 1;
        return {
          message: {
            role: 'assistant',
            content: '[DemoLLM] 我先查一下订单状态。',
            toolCalls: [{ id: 'call_1', name: 'get_order_status', arguments: { orderId: 'A001' } }],
          },
          usage: usage(),
        };
      }
      return {
        message: { role: 'assistant', content: '[DemoLLM] 完成。' },
        usage: usage(),
      };
    },
    async chatStream() {
      throw new Error('demoLLM 不支持流式');
    },
  };
}

// ============================================================
// 4. 主流程：组装并运行
// ============================================================

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('M3 嵌入式 SDK 示例：自定义工具 + 审批钩子 + trace 导出');
  console.log('═'.repeat(60));

  // 4.1 准备 tracer（trace 导出 = 可观测性 / 审计）
  const tracer = new Tracer({ enabled: true });

  // 4.2 调 runLoop，把业务工具、审批钩子、事件监听、tracer 全注入
  // 真实场景用 createLLM()（接 OpenAI 兼容端点）；这里用 demoLLM 保证离线可演示完整链路。
  const useRealLLM = Boolean(process.env.LOOP_LLM_API_KEY);
  const result = await runLoop({
    llm: useRealLLM ? createLLM() : createDemoLLM(),
    system: '你是客服 agent。可查订单状态、退款。退款是高风险操作。',
    user: '帮我查一下订单 A001 的状态。',
    tools: [getOrderStatus, refundOrder],
    maxSteps: 8,
    onEvent: eventLogger,
    onApproval: approvalHook,
    tracer,
  });

  // 4.3 结果
  console.log('\n─'.repeat(60));
  console.log(`✅ 完成：${result.steps} 步，stopReason=${result.stopReason}`);
  console.log(`📝 答案：${result.answer.slice(0, 120)}`);
  console.log(`💰 token 用量：${JSON.stringify(result.totalUsage)}`);

  // 4.4 trace 导出（审计 / 调试 / 可观测性后端）
  console.log('─'.repeat(60));
  console.log('📊 trace 导出（span 树节选）：');
  if (result.trace) {
    const traceText = renderSpanTree(result.trace);
    console.log(traceText.split('\n').slice(0, 20).join('\n'));
    console.log('  (... 完整 trace 可导出到 OTel/文件做审计)');
  } else {
    console.log('  (trace 未启用；设 LOOP_TRACE=1 或保留 tracer 入参可开启)');
  }

  console.log('═'.repeat(60));
  console.log('要点：');
  console.log('  1. 业务工具用 defineTool 注册，高风险的标 requiresApproval=true。');
  console.log('  2. onApproval 钩子是"对齐工程化"的运行时抓手：把高风险动作关进审批笼子。');
  console.log('  3. tracer + onEvent 提供 trace 导出与事件流，支撑可观测性/审计/调试。');
  console.log('  4. 无 key 也能跑（StubLLM），适合 CI 与本地开发。');
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('示例运行失败：', err);
  process.exit(1);
});
