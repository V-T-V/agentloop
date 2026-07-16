/**
 * 主循环 loop.ts 的测试。
 *
 * 用脚本化假 LLM 验证：完整回路 / 直接收敛 / 步数上限 / 工具异常不中断 /
 * 未知工具 / LLM 抛错 / schema 校验回填 / 触发压缩 / 流式收敛 / span 事件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Memory } from '../src/memory.ts';
import { runLoop } from '../src/loop.ts';
import { Tracer } from '../src/trace.ts';
import { calculatorTool } from '../src/tools/calculator.ts';
import { datetimeTool } from '../src/tools/datetime.ts';
import type { AnyToolDef, ChatResult, LLMClient, LoopEvent, Message, TokenUsage } from '../src/types.ts';

const U: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

/** 按预设脚本依次返回消息的假 LLM */
function scriptedLLM(scripts: Message[], opts: { stream?: boolean } = {}): LLMClient & { calls: number } {
  let i = 0;
  const stream = opts.stream ?? true;
  return {
    isStub: true,
    supportsStream: stream,
    calls: 0,
    async chat(): Promise<ChatResult> {
      this.calls++;
      const msg = scripts[i++] ?? throwEmpty();
      return { message: msg, usage: U };
    },
    async chatStream(input, o): Promise<ChatResult> {
      this.calls++;
      const msg = scripts[i++] ?? throwEmpty();
      // 模拟逐字推送 content（取纯文本）
      const text = typeof msg.content === 'string' ? msg.content : '';
      for (const ch of text) o?.onToken?.(ch);
      return { message: msg, usage: U };
    },
  } as LLMClient & { calls: number };
}

function throwEmpty(): Message {
  throw new Error('脚本已耗尽');
}

function toolCallMsg(name: string, args: Record<string, unknown>, id = 'call_1'): Message {
  return { role: 'assistant', content: null, toolCalls: [{ id, name, arguments: args }] };
}

const tools: AnyToolDef[] = [calculatorTool as AnyToolDef, datetimeTool as AnyToolDef];

test('完整回路：调两个工具后给出最终答案', async () => {
  const llm = scriptedLLM([
    toolCallMsg('calculator', { expression: '(1+2)*3' }, 'c1'),
    toolCallMsg('datetime', {}, 'c2'),
    { role: 'assistant', content: '计算结果是 9，时间已获取。' },
  ]);
  const events: LoopEvent[] = [];
  const { answer, steps, stopReason, totalUsage } = await runLoop({
    llm,
    tools,
    system: 'sys',
    user: '算 (1+2)*3 并告诉我时间',
    stream: false,
    onEvent: (e) => events.push(e),
  });
  assert.equal(stopReason, 'final');
  assert.equal(steps, 3);
  assert.equal(answer, '计算结果是 9，时间已获取。');
  assert.equal(events.filter((e) => e.type === 'tool_call').length, 2);
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 2);
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
  // 三次 LLM 调用累计 usage
  assert.equal(totalUsage.promptTokens, 30);
});

test('直接回答：一步收敛', async () => {
  const llm = scriptedLLM([{ role: 'assistant', content: '你好！' }]);
  const { stopReason, steps } = await runLoop({
    llm,
    tools,
    system: 'sys',
    user: '你好',
    stream: false,
  });
  assert.equal(stopReason, 'final');
  assert.equal(steps, 1);
});

test('步数上限：模型一直调工具时达上限收尾', async () => {
  const llm = scriptedLLM(Array.from({ length: 20 }, (_, i) => toolCallMsg('datetime', {}, `c${i}`)));
  const events: LoopEvent[] = [];
  const { stopReason, steps } = await runLoop({
    llm,
    tools,
    system: 'sys',
    user: '时间',
    maxSteps: 3,
    stream: false,
    onEvent: (e) => events.push(e),
  });
  assert.equal(stopReason, 'max_steps');
  assert.equal(steps, 3);
  assert.ok(events.some((e) => e.type === 'max_steps'));
});

test('工具异常不中断循环', async () => {
  const boom: AnyToolDef = {
    name: 'boom',
    description: '总是抛错',
    parameters: { type: 'object', properties: {} },
    execute() {
      throw new Error('故意爆炸');
    },
  };
  const llm = scriptedLLM([
    toolCallMsg('boom', {}),
    { role: 'assistant', content: '工具报错了，换种方式回答。' },
  ]);
  const { answer, stopReason } = await runLoop({
    llm,
    tools: [boom],
    system: 'sys',
    user: 'x',
    stream: false,
  });
  assert.equal(stopReason, 'final');
  assert.equal(answer, '工具报错了，换种方式回答。');
});

test('schema 校验：参数不符回填友好错误，不抛出', async () => {
  // calculator 需要 {expression: string}，故意给错类型
  const llm = scriptedLLM([
    toolCallMsg('calculator', { expression: 123 }, 'c1'), // 类型不符
    { role: 'assistant', content: '参数错了，已修正。' },
  ]);
  const events: LoopEvent[] = [];
  const { stopReason } = await runLoop({
    llm,
    tools,
    system: 'sys',
    user: 'x',
    stream: false,
    onEvent: (e) => events.push(e),
  });
  assert.equal(stopReason, 'final');
  // 第一次工具结果应是校验失败（ok:false，含「校验失败」）
  const tr = events.find(
    (e): e is Extract<LoopEvent, { type: 'tool_result' }> => e.type === 'tool_result',
  );
  assert.ok(tr);
  assert.equal(tr!.result.ok, false);
  assert.match(tr!.result.output, /校验失败/);
});

test('LLM 调用抛错时优雅中止', async () => {
  const llm: LLMClient = {
    isStub: false,
    supportsStream: false,
    async chat() {
      throw new Error('网络炸了');
    },
    async chatStream() {
      throw new Error('网络炸了');
    },
  };
  const { stopReason, answer } = await runLoop({
    llm,
    tools,
    system: 'sys',
    user: 'x',
    stream: false,
  });
  assert.equal(stopReason, 'error');
  assert.match(answer, /网络炸了/);
});

test('流式：最终答案通过 stream_delta 广播（工具步骤的思考不广播）', async () => {
  const llm = scriptedLLM([toolCallMsg('datetime', {}, 'c1'), { role: 'assistant', content: 'ABC' }], {
    stream: true,
  });
  const events: LoopEvent[] = [];
  await runLoop({
    llm,
    tools,
    system: 'sys',
    user: 'x',
    stream: true,
    onEvent: (e) => events.push(e),
  });
  const deltas = events.filter((e) => e.type === 'stream_delta');
  // 仅最终答案（ABC）广播一次；工具调用步骤的「思考」不广播
  assert.equal(deltas.length, 1);
  const text = (deltas[0] as Extract<LoopEvent, { type: 'stream_delta' }>).text;
  assert.equal(text, 'ABC');
});

test('span trace：runLoop 返回完整 span 树', async () => {
  const tracer = new Tracer(true);
  const llm = scriptedLLM([toolCallMsg('datetime', {}, 'c1'), { role: 'assistant', content: '完成' }]);
  const { trace } = await runLoop({
    llm,
    tools,
    system: 'sys',
    user: 'x',
    stream: false,
    tracer,
  });
  assert.ok(trace);
  assert.equal(trace!.name, 'run');
  assert.ok(trace!.children.length >= 1); // 至少一个 step
  // step 下应有 llm + tool 子 span
  const stepChildren = trace!.children[0]!.children.map((c) => c.name);
  assert.ok(stepChildren.includes('llm'));
  assert.ok(stepChildren.includes('tool'));
});

test('usage 事件：每次 LLM 调用上报 usage', async () => {
  const llm = scriptedLLM([toolCallMsg('datetime', {}), { role: 'assistant', content: 'ok' }]);
  const events: LoopEvent[] = [];
  await runLoop({
    llm,
    tools,
    system: 'sys',
    user: 'x',
    stream: false,
    onEvent: (e) => events.push(e),
  });
  const usages = events.filter((e) => e.type === 'usage');
  assert.equal(usages.length, 2); // 两次 LLM 调用
});

test('复用记忆：传入的 memory 引用被使用并增长', async () => {
  const llm = scriptedLLM([{ role: 'assistant', content: '好的' }]);
  const memory = new Memory('sys');
  const before = memory.length;
  await runLoop({ llm, tools, system: 'sys', user: '继续', memory, stream: false });
  assert.equal(memory.length, before + 2);
});

// —————————— HITL 审批门 ——————————

/** 造一个标记高风险的工具，记录是否真的被执行 */
function riskyTool(executed: { count: number }): AnyToolDef {
  return {
    name: 'risky',
    description: '高风险工具',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute() {
      executed.count++;
      return { ok: true, output: '已执行' };
    },
  };
}

test('HITL：批准后工具正常执行', async () => {
  const executed = { count: 0 };
  const llm = scriptedLLM([
    toolCallMsg('risky', {}),
    { role: 'assistant', content: '完成' },
  ]);
  const events: LoopEvent[] = [];
  const { stopReason } = await runLoop({
    llm,
    tools: [riskyTool(executed)],
    system: 'sys',
    user: 'x',
    stream: false,
    onEvent: (e) => events.push(e),
    onApproval: async () => ({ approved: true }),
  });
  assert.equal(stopReason, 'final');
  assert.equal(executed.count, 1); // 批准 → 真的执行了
  assert.ok(events.some((e) => e.type === 'approval_request'));
  assert.ok(events.some((e) => e.type === 'approval_result'));
});

test('HITL：拒绝则跳过执行，回填拒绝原因，循环继续', async () => {
  const executed = { count: 0 };
  const llm = scriptedLLM([
    toolCallMsg('risky', {}),
    { role: 'assistant', content: '用户不让做，算了' },
  ]);
  const events: LoopEvent[] = [];
  const { stopReason } = await runLoop({
    llm,
    tools: [riskyTool(executed)],
    system: 'sys',
    user: 'x',
    stream: false,
    onEvent: (e) => events.push(e),
    onApproval: async () => ({ approved: false, reason: '太危险' }),
  });
  assert.equal(stopReason, 'final');
  assert.equal(executed.count, 0); // 拒绝 → 没执行
  // 回填的工具结果含拒绝原因
  const tr = events.find(
    (e): e is Extract<LoopEvent, { type: 'tool_result' }> => e.type === 'tool_result',
  );
  assert.ok(tr);
  assert.equal(tr!.result.ok, false);
  assert.match(tr!.result.output, /拒绝/);
  assert.match(tr!.result.output, /太危险/);
});

test('HITL：无钩子时默认放行（向后兼容）', async () => {
  const executed = { count: 0 };
  const llm = scriptedLLM([
    toolCallMsg('risky', {}),
    { role: 'assistant', content: '完成' },
  ]);
  // 注意：不传 onApproval
  const { stopReason } = await runLoop({
    llm,
    tools: [riskyTool(executed)],
    system: 'sys',
    user: 'x',
    stream: false,
  });
  assert.equal(stopReason, 'final');
  assert.equal(executed.count, 1); // auto 模式无钩子 → 放行执行
});

test('HITL：strict 模式下无钩子拒绝高风险工具', async () => {
  const prev = process.env.LOOP_HITL_MODE;
  process.env.LOOP_HITL_MODE = 'strict';
  try {
    const executed = { count: 0 };
    const llm = scriptedLLM([
      toolCallMsg('risky', {}),
      { role: 'assistant', content: '被安全策略拦了' },
    ]);
    const events: LoopEvent[] = [];
    const { stopReason } = await runLoop({
      llm,
      tools: [riskyTool(executed)],
      system: 'sys',
      user: 'x',
      stream: false,
      onEvent: (e) => events.push(e),
      // 不传 onApproval → strict 模式应拒绝
    });
    assert.equal(stopReason, 'final');
    assert.equal(executed.count, 0); // strict + 无钩子 → 拒绝，没执行
    const tr = events.find(
      (e): e is Extract<LoopEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    assert.ok(tr);
    assert.match(tr!.result.output, /strict/);
  } finally {
    if (prev === undefined) delete process.env.LOOP_HITL_MODE;
    else process.env.LOOP_HITL_MODE = prev;
  }
});

test('HITL：低风险工具不触发审批', async () => {
  const executed = { count: 0 };
  const llm = scriptedLLM([
    toolCallMsg('datetime', {}), // datetime 无 requiresApproval
    { role: 'assistant', content: '完成' },
  ]);
  let approvalCalled = false;
  await runLoop({
    llm,
    tools,
    system: 'sys',
    user: 'x',
    stream: false,
    onApproval: async () => {
      approvalCalled = true;
      return { approved: true };
    },
  });
  assert.equal(approvalCalled, false); // 低风险工具不应触发审批
  void executed;
});

test('并发工具实时广播：每个 tool_result 紧随其 tool_call（同 callId 配对）', async () => {
  // 一个慢工具 + 一个快工具，同一步并发。无论谁先完成，事件流必须满足：
  // 每个 tool_call 紧跟「同 callId」的 tool_result（不能交错成 X-的call → Y-的call → ... 的批量后置）。
  const slow: AnyToolDef = {
    name: 'slow',
    description: '慢工具',
    parameters: { type: 'object', properties: {} },
    async execute() {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, output: 'slow-done' };
    },
  };
  const fast: AnyToolDef = {
    name: 'fast',
    description: '快工具',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, output: 'fast-done' };
    },
  };
  // 同一步返回两个工具调用
  const dualCall: Message = {
    role: 'assistant',
    content: null,
    toolCalls: [
      { id: 's1', name: 'slow', arguments: {} },
      { id: 'f1', name: 'fast', arguments: {} },
    ],
  };
  const llm = scriptedLLM([dualCall, { role: 'assistant', content: '完成' }]);
  const events: LoopEvent[] = [];
  await runLoop({
    llm,
    tools: [slow, fast],
    system: 'sys',
    user: 'x',
    stream: false,
    onEvent: (e) => events.push(e),
  });

  // 抽取 tool 相关事件序列
  const toolEvents = events.filter(
    (e) => e.type === 'tool_call' || e.type === 'tool_result',
  ) as Array<{ type: 'tool_call' | 'tool_result'; callId?: string; call?: { id: string } }>;

  // 不变量：相邻的 (call, result) 必须同 callId，且 result 紧随 call
  for (let i = 0; i < toolEvents.length; i += 2) {
    const callEv = toolEvents[i];
    const resultEv = toolEvents[i + 1];
    assert.ok(callEv && callEv.type === 'tool_call', `第 ${i} 个事件应为 tool_call`);
    assert.ok(resultEv && resultEv.type === 'tool_result', `第 ${i + 1} 个事件应为 tool_result`);
    assert.equal(callEv!.call!.id, resultEv!.callId, 'tool_result 必须紧随同 callId 的 tool_call');
  }
});

// —————————— 轨迹内容捕获 ——————————

test('轨迹捕获：span 含 LLM 输入输出原文与工具结果', async () => {
  const llm = scriptedLLM([
    toolCallMsg('calculator', { expression: '(1+2)*3' }, 'c1'),
    { role: 'assistant', content: '答案是 9' },
  ]);
  const { trace } = await runLoop({
    llm,
    tools,
    system: 'sys',
    user: '算 (1+2)*3',
    stream: false,
  });
  assert.ok(trace);
  // run span 含最终答案与停止原因
  assert.equal(trace!.attributes['stopReason'], 'final');
  assert.match(String(trace!.attributes['answer']), /9/);

  // 找到带工具调用的 step 下的 llm span 与 tool span
  const step1 = trace!.children.find((c) => c.name === 'step');
  assert.ok(step1);
  const llmSpans = step1!.children.filter((s) => s.name === 'llm');
  const toolSpans = step1!.children.filter((s) => s.name === 'tool');

  // llm span 含输入 messages（数组）和输出 content/toolCalls
  const firstLlm = llmSpans[0];
  assert.ok(firstLlm);
  assert.ok(Array.isArray(firstLlm!.attributes['input.messages']));
  assert.ok((firstLlm!.attributes['output.toolCalls'] as unknown[]).length > 0);

  // tool span 含入参与结果
  const toolSpan = toolSpans[0];
  assert.ok(toolSpan);
  assert.deepEqual(toolSpan!.attributes['input.arguments'], { expression: '(1+2)*3' });
  assert.match(String(toolSpan!.attributes['output.result']), /= 9/);
});

test('轨迹捕获：LLM 错误信息写入 span', async () => {
  const errLlm: LLMClient = {
    isStub: false,
    supportsStream: false,
    async chat() {
      throw new Error('网络超时');
    },
    async chatStream() {
      throw new Error('网络超时');
    },
  };
  const { trace } = await runLoop({
    llm: errLlm,
    tools,
    system: 'sys',
    user: 'x',
    stream: false,
  });
  assert.ok(trace);
  const step1 = trace!.children.find((c) => c.name === 'step');
  const llmSpan = step1?.children.find((s) => s.name === 'llm');
  assert.ok(llmSpan);
  assert.equal(llmSpan!.status, 'error');
  assert.match(String(llmSpan!.attributes['error']), /网络超时/);
});
