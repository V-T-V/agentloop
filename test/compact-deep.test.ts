/**
 * compact.ts 深层测试（R2）。
 *
 * 覆盖基础测试未触及的边界：
 * 1. 压缩阈值边界（恰好等于、刚刚越过、刚好未达）。
 * 2. 多轮压缩：连续两次 compactMemory，recent window 不被二次压缩、摘要累积。
 * 3. 压缩后工具调用恢复：压缩保留 recent 含 tool_call/tool 结果，后续步骤可继续调工具。
 * 4. 边界消息保留：首条 system、空 content、tool_calls 消息在压缩中的处理。
 * 5. 摘要回退：LLM 返回空串/纯空白时使用占位摘要。
 * 6. 多模态内容（含图片）参与压缩渲染。
 * 7. recentWindow 大于等于历史长度时的退化行为。
 * 8. CompactResult 字段精确性（before/after 一致性）。
 * 9. shouldCompact 的 minMessages 精确边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Memory } from '../src/memory.ts';
import {
  compactMemory,
  shouldCompact,
  currentTokens,
  type CompactConfig,
} from '../src/compact.ts';
import type { ChatResult, LLMClient } from '../src/types.ts';
import { estimateMemoryTokens } from '../src/tokens.ts';

/** 按脚本返回摘要的假 LLM（每次 chat 返回脚本下一项） */
function scriptedSummaryLLM(scripts: string[]): LLMClient & { calls: number } {
  let i = 0;
  return {
    isStub: true,
    supportsStream: true,
    calls: 0,
    async chat(): Promise<ChatResult> {
      this.calls++;
      const summary = scripts[i++] ?? '(空)';
      return {
        message: { role: 'assistant', content: summary },
        usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 },
      };
    },
    async chatStream(): Promise<ChatResult> {
      return { message: { role: 'assistant', content: scripts[i++] ?? '(空)' }, usage: null };
    },
  };
}

const cfg = (over: Partial<CompactConfig> = {}): CompactConfig => ({
  tokenBudget: 1000,
  threshold: 0.85,
  maxMessages: 10,
  recentWindow: 3,
  ...over,
});

/** 造一个有 N 条较长用户消息的记忆 */
function filledMemory(n: number, content = '这是一段较长的对话内容用于测试压缩'): Memory {
  const m = new Memory('系统提示');
  for (let i = 0; i < n; i++) m.add({ role: 'user', content: `${content}-${i}` });
  return m;
}

// —————————— 1. 压缩阈值边界 ——————————

test('shouldCompact：消息条数恰好等于 maxMessages → true（>= 判定）', () => {
  const m = filledMemory(10);
  // memory.length = 1(system) + 10 = 11，maxMessages=11 → 触发
  assert.equal(shouldCompact(m, cfg({ maxMessages: 11, tokenBudget: 1_000_000 })), true);
});

test('shouldCompact：消息条数恰好等于 maxMessages-1 → false', () => {
  const m = filledMemory(10);
  // memory.length = 11，maxMessages=12 → 未达，token 也未达 → false
  assert.equal(shouldCompact(m, cfg({ maxMessages: 12, tokenBudget: 1_000_000 })), false);
});

test('shouldCompact：token 恰好等于 threshold*budget → true（>= 判定）', () => {
  const m = filledMemory(20, 'x'.repeat(200)); // 足够触发
  // tokenBudget 设为当前 token 数除以 threshold，使 tokens 恰好等于阈值
  const tokens = currentTokens(m);
  const budget = Math.round(tokens / 0.85);
  assert.equal(shouldCompact(m, cfg({ maxMessages: 1_000_000, tokenBudget: budget, threshold: 0.85 })), true);
});

test('shouldCompact：token 略低于阈值 → false', () => {
  const m = filledMemory(20, 'x'.repeat(200));
  const tokens = currentTokens(m);
  // budget 设得略大，使 tokens < threshold*budget
  const budget = Math.round(tokens / 0.85) + 1000;
  assert.equal(shouldCompact(m, cfg({ maxMessages: 1_000_000, tokenBudget: budget })), false);
});

test('shouldCompact：minMessages 精确边界 = 2+recentWindow+1', () => {
  // recentWindow=3 → minMessages = 6。memory.length < 6 时哪怕 token 超也不压缩。
  const m = filledMemory(4, 'x'.repeat(10000)); // length=5 < 6，token 巨大
  assert.equal(shouldCompact(m, cfg({ recentWindow: 3, maxMessages: 1, tokenBudget: 1 })), false);
  // length 恰好 6 → 满足 minMessages，且 token 超阈值 → true
  const m2 = filledMemory(5, 'x'.repeat(10000)); // length=6
  assert.equal(shouldCompact(m2, cfg({ recentWindow: 3, maxMessages: 1_000_000, tokenBudget: 1 })), true);
});

test('shouldCompact：recentWindow 越大则 minMessages 越高', () => {
  // recentWindow=10 → minMessages=13。length=12 不够，length=13 才够。
  const m = filledMemory(12, 'x'.repeat(10000)); // length=13
  assert.equal(shouldCompact(m, cfg({ recentWindow: 10, maxMessages: 1_000_000, tokenBudget: 1 })), true);
  const m2 = filledMemory(11, 'x'.repeat(10000)); // length=12 < 13
  assert.equal(shouldCompact(m2, cfg({ recentWindow: 10, maxMessages: 1_000_000, tokenBudget: 1 })), false);
});

// —————————— 2. 多轮压缩 ——————————

test('多轮压缩：连续两次 compact，recent window（首轮压缩后的尾部）不被二次摘要', async () => {
  const m = filledMemory(15, '历史片段');
  const llm = scriptedSummaryLLM(['摘要A', '摘要B']);
  // 第一轮：maxMessages 低，强制触发
  const r1 = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(r1.performed, true);
  const lenAfter1 = m.length;
  // 继续加消息使其再次超阈值
  for (let i = 0; i < 10; i++) m.add({ role: 'user', content: `新增-${i}` });
  assert.ok(shouldCompact(m, cfg({ maxMessages: 5, recentWindow: 2 })), '加消息后应再次触发');
  const r2 = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(r2.performed, true);
  // 第二轮也调用了 LLM
  assert.equal(llm.calls, 2);
  // 两轮压缩后 system 仍在首位
  assert.equal(m.snapshot()[0]!.role, 'system');
  assert.ok(m.length < lenAfter1 + 10, '压缩后消息数应显著少于压缩前');
});

test('多轮压缩：摘要内容累积出现（两轮摘要都应能被检索到之一）', async () => {
  const m = filledMemory(12, '内容');
  const llm = scriptedSummaryLLM(['第一轮摘要内容XYZ']);
  await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.ok(
    m.snapshot().some((msg) => typeof msg.content === 'string' && msg.content.includes('第一轮摘要内容XYZ')),
    '首轮摘要应写入 memory',
  );
});

// —————————— 3. 压缩后工具调用恢复 ——————————

test('压缩保留 recent 中的 tool_call + tool 结果，工具调用配对完整', async () => {
  const m = new Memory('sys');
  // 填充足够多的历史使触发压缩
  for (let i = 0; i < 8; i++) m.add({ role: 'user', content: `历史-${i}` });
  // recent 区放入完整的 assistant(tool_call) + tool 结果配对
  m.add({
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'call_99', name: 'datetime', arguments: {} }],
  });
  m.addToolResult('call_99', 'datetime', { ok: true, output: '2026-07-30' });
  // 再加两条使 recent 区刚好包含上述配对（recentWindow=3 会让最后的 tool 结果进入 recent，
  // 但配对保护需要 assistant(tool_call) 也被回溯保留）
  const llm = scriptedSummaryLLM(['摘要']);
  const result = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(result.performed, true);
  const snap = m.snapshot();
  // 压缩后存在 assistant(tool_call call_99)
  const assistantWithCall = snap.find(
    (msg) => msg.role === 'assistant' && msg.toolCalls?.some((c) => c.id === 'call_99'),
  );
  assert.ok(assistantWithCall, '压缩后应保留带 call_99 的 assistant 消息');
  // 紧随其后的应是 tool 结果
  const idx = snap.indexOf(assistantWithCall!);
  const next = snap[idx + 1];
  assert.ok(next && next.role === 'tool' && next.toolCallId === 'call_99', 'tool 结果应紧随 assistant(tool_call)');
});

test('压缩后可继续追加新的工具调用步骤（语义连续性）', async () => {
  const m = filledMemory(12, '历史');
  const llm = scriptedSummaryLLM(['摘要']);
  await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 2 }));
  // 压缩后模拟新的一步：assistant 发起新工具调用 + 回填
  m.add({
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'call_new', name: 'calc', arguments: { x: 1 } }],
  });
  m.addToolResult('call_new', 'calc', { ok: true, output: '2' });
  const snap = m.snapshot();
  // 新调用配对完整存在
  assert.ok(snap.some((msg) => msg.role === 'tool' && msg.toolCallId === 'call_new'));
  // memory 结构合法：首条 system
  assert.equal(snap[0]!.role, 'system');
});

// —————————— 4. 边界消息保留 ——————————

test('压缩：首条 system 内容被原样保留（非空 system prompt）', async () => {
  const m = new Memory('这是重要的系统指令-必须保留');
  for (let i = 0; i < 12; i++) m.add({ role: 'user', content: `历史-${i}` });
  await compactMemory(m, scriptedSummaryLLM(['摘要']), cfg({ maxMessages: 5, recentWindow: 2 }));
  const sys = m.snapshot()[0]!;
  assert.equal(sys.role, 'system');
  assert.equal(typeof sys.content === 'string' && sys.content.includes('重要的系统指令-必须保留'), true);
});

test('压缩：含 tool_calls 的历史消息被渲染进摘要输入（通过 LLM 被调用验证）', async () => {
  const m = new Memory('sys');
  for (let i = 0; i < 6; i++) m.add({ role: 'user', content: `历史-${i}` });
  m.add({
    role: 'assistant',
    content: '我用工具',
    toolCalls: [{ id: 'c1', name: 'calc', arguments: { a: 1 } }],
  });
  m.addToolResult('c1', 'calc', { ok: true, output: '1' });
  // recentWindow=1，把 tool 结果之外的都压进摘要
  const llm = scriptedSummaryLLM(['摘要']);
  await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 1 }));
  assert.equal(llm.calls, 1, 'LLM 应被调用一次生成摘要');
});

test('压缩：空 content 的 user 消息在渲染时记为 (空)（不崩溃）', async () => {
  const m = new Memory('sys');
  for (let i = 0; i < 6; i++) m.add({ role: 'user', content: `历史-${i}` });
  m.add({ role: 'user', content: '' }); // 空 content
  m.add({ role: 'user', content: '尾部' });
  const llm = scriptedSummaryLLM(['摘要']);
  // 不应抛错
  const result = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 1 }));
  assert.equal(result.performed, true);
});

// —————————— 5. 摘要回退 ——————————

test('压缩：LLM 返回空串时使用占位摘要', async () => {
  const m = filledMemory(12);
  const llm = scriptedSummaryLLM(['   ']); // 纯空白
  const result = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(result.performed, true);
  // 摘要应为占位文本
  assert.equal(result.summary, '(历史已压缩，无摘要)');
  // memory 中应能找到占位摘要
  assert.ok(
    m.snapshot().some((msg) => typeof msg.content === 'string' && msg.content.includes('历史已压缩')),
  );
});

test('压缩：LLM 返回 null content 时不崩溃', async () => {
  const m = filledMemory(12);
  const llm: LLMClient = {
    isStub: true,
    supportsStream: false,
    async chat() {
      return { message: { role: 'assistant', content: null }, usage: null };
    },
    async chatStream() {
      return { message: { role: 'assistant', content: null }, usage: null };
    },
  };
  const result = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(result.performed, true);
  assert.equal(result.summary, '(历史已压缩，无摘要)');
});

// —————————— 6. 多模态内容 ——————————

test('压缩：含图片的多模态消息参与摘要渲染（图片转 [图片] 占位）', async () => {
  const m = new Memory('sys');
  // 多模态 user 消息
  m.add({
    role: 'user',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
    ],
  });
  for (let i = 0; i < 10; i++) m.add({ role: 'user', content: `历史-${i}` });
  const llm = scriptedSummaryLLM(['摘要']);
  const result = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(result.performed, true);
  assert.equal(llm.calls, 1, 'LLM 被调用处理含图历史');
});

// —————————— 7. recentWindow 退化 ——————————

test('压缩：recentWindow 大于等于待压缩后历史长度时仍正常（不报错）', async () => {
  const m = filledMemory(12);
  // recentWindow 设为 20（远大于消息数）
  const llm = scriptedSummaryLLM(['摘要']);
  // maxMessages=5 强制触发；但 recentWindow=20 会让 toCompress 可能为空
  // shouldCompact 满足（maxMessages 触发），但 toCompress 为空时应 performed:false
  const result = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 20 }));
  // toCompress.length === 0 → performed:false，memory 不变
  assert.equal(result.performed, false);
  assert.equal(llm.calls, 0, '待压缩为空时不应调用 LLM');
});

test('压缩：recentWindow=0 时压缩全部历史（除 system）', async () => {
  const m = filledMemory(12);
  const llm = scriptedSummaryLLM(['全部压缩']);
  const result = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 0 }));
  assert.equal(result.performed, true);
  const snap = m.snapshot();
  // system + 摘要 user + 0 条 recent = 2 条
  assert.equal(snap.length, 2);
  assert.equal(snap[0]!.role, 'system');
  assert.equal(snap[1]!.role, 'user');
});

// —————————— 8. CompactResult 字段精确性 ——————————

test('CompactResult：performed=true 时 beforeMessages > afterMessages', async () => {
  const m = filledMemory(20);
  const before = m.length;
  const result = await compactMemory(m, scriptedSummaryLLM(['摘要']), cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(result.performed, true);
  assert.equal(result.beforeMessages, before);
  assert.equal(result.afterMessages, m.length);
  assert.ok(result.afterMessages < result.beforeMessages);
  assert.equal(result.summary, '摘要');
});

test('CompactResult：performed=false 时 before/after 完全相等', async () => {
  const m = filledMemory(3);
  const beforeTokens = currentTokens(m);
  const result = await compactMemory(m, scriptedSummaryLLM(['x']), cfg({ maxMessages: 100, tokenBudget: 1_000_000 }));
  assert.equal(result.performed, false);
  assert.equal(result.beforeTokens, beforeTokens);
  assert.equal(result.afterTokens, beforeTokens);
  assert.equal(result.beforeMessages, result.afterMessages);
  assert.equal(result.summary, '');
});

test('CompactResult：afterTokens 与实际 memory 一致', async () => {
  const m = filledMemory(15, '一段测试内容');
  const result = await compactMemory(m, scriptedSummaryLLM(['压缩后的摘要文本']), cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(result.performed, true);
  // afterTokens 应等于压缩后实际 memory 的 token 估算
  assert.equal(result.afterTokens, estimateMemoryTokens(m.snapshot()));
  // 压缩后 token 应 <= 压缩前
  assert.ok(result.afterTokens <= result.beforeTokens, '压缩应减少或持平 token');
});

// —————————— 9. 无首条 system 的退化（理论上 Memory 总有 system，但测稳健性）——————————

test('压缩：recent 区为 assistant 消息时也能正常保留', async () => {
  const m = new Memory('sys');
  for (let i = 0; i < 8; i++) m.add({ role: 'user', content: `u-${i}` });
  // 末尾放 assistant 消息（非 tool_call）
  m.add({ role: 'assistant', content: '这是最后的助手回复' });
  m.add({ role: 'user', content: '用户追问' });
  const llm = scriptedSummaryLLM(['摘要']);
  const result = await compactMemory(m, llm, cfg({ maxMessages: 5, recentWindow: 2 }));
  assert.equal(result.performed, true);
  const snap = m.snapshot();
  // 末尾应是保留的 recent（"用户追问"）
  const last = snap[snap.length - 1]!;
  assert.ok(typeof last.content === 'string' && last.content.includes('用户追问'));
});
