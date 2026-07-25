/**
 * M2 库级 API 示例 —— trace 三路导出（可观测性 / 审计 / 调试）
 * =====================================================
 * 对应 PRODUCT.md M2：「整理库级 API 文档，给 trace store 提供最小集成示例」。
 *
 * 本示例演示 agentloop 运行后，trace 的三种导出路径：
 *   1. 文本 span 树（renderSpanTree）→ 控制台调试 / 日志
 *   2. OTLP/JSON（toOTLP）→ OpenTelemetry 兼容后端（Jaeger/Tempo/Datadog）
 *   3. 扁平 JSON 落盘 → 审计 / 长期存储 / 离线分析
 *
 * trace 是"运行时对齐工程"的核心原语（见 ai-world-research/applied/K）：
 * 每一步 Think/Act/Observe 都可重建，支撑合规审计与调试。
 *
 * 离线可跑：用脚本化 demoLLM 触发工具调用，产出真实 span 树后导出。
 *
 * 运行：npx tsx examples/m2-trace-export.ts
 */

import { writeFileSync } from 'node:fs';
import { runLoop } from '../src/loop.ts';
import { defineTool } from '../src/tools/registry.ts';
import { Tracer, renderSpanTree } from '../src/trace.ts';
import { toOTLP } from '../src/otel.ts';
import type { LLMClient, ChatResult, Message, ToolDef, TokenUsage, ResponseFormat } from '../src/types.ts';

// ============================================================
// 1. 一个会调工具的 demo LLM（保证离线产出真实 span 树）
// ============================================================

const echoTool = defineTool({
  name: 'echo',
  description: '回显输入文本。入参：text。',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
    additionalProperties: false,
  },
  async execute(args) {
    return { ok: true, output: `echo: ${args.text}` };
  },
});

function createDemoLLM(): LLMClient {
  let called = false;
  const usage = (): TokenUsage => ({ promptTokens: 8, completionTokens: 8, totalTokens: 16 });
  return {
    isStub: true,
    supportsStream: false,
    async chat(input: { messages: Message[]; tools: ToolDef[]; responseFormat?: ResponseFormat }): Promise<ChatResult> {
      const last = input.messages[input.messages.length - 1];
      if (last?.role === 'tool') {
        return {
          message: { role: 'assistant', content: `[DemoLLM] 完成：${String(last.content).slice(0, 50)}` },
          usage: usage(),
        };
      }
      if (!called) {
        called = true;
        return {
          message: {
            role: 'assistant',
            content: '[DemoLLM] 调用 echo 工具。',
            toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hello-trace' } }],
          },
          usage: usage(),
        };
      }
      return { message: { role: 'assistant', content: '[DemoLLM] done' }, usage: usage() };
    },
    async chatStream() {
      throw new Error('demoLLM 不支持流式');
    },
  };
}

// ============================================================
// 2. 扁平化 span 树 → JSON（审计落盘用）
// ============================================================

interface FlatSpan {
  id: string;
  name: string;
  parentId: string | null;
  status: string;
  durationMs: number;
  attributes: Record<string, unknown>;
}

/** 把 span 树拍平成数组（DFS），便于 JSON 序列化与审计存储。 */
function flattenSpans(root: unknown): FlatSpan[] {
  const out: FlatSpan[] = [];
  const visit = (s: any): void => {
    if (!s || typeof s !== 'object') return;
    const start = typeof s.start === 'number' ? s.start : 0;
    const end = typeof s.end === 'number' ? s.end : start;
    out.push({
      id: String(s.id ?? ''),
      name: String(s.name ?? ''),
      parentId: s.parentId ?? null,
      status: String(s.status ?? 'ok'),
      durationMs: end > start ? Number((end - start).toFixed(3)) : 0,
      attributes: (s.attributes as Record<string, unknown>) ?? {},
    });
    for (const c of s.children ?? []) visit(c);
  };
  visit(root);
  return out;
}

// ============================================================
// 3. 主流程：跑一次 → 三路导出
// ============================================================

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('M2 trace 三路导出示例：文本树 / OTLP / 审计 JSON');
  console.log('═'.repeat(60));

  const tracer = new Tracer({ enabled: true });

  const result = await runLoop({
    llm: createDemoLLM(),
    system: '你是回显 agent。',
    user: '请回显 hello-trace',
    tools: [echoTool],
    maxSteps: 4,
    tracer,
  });

  console.log(`\n✅ 运行完成：${result.steps} 步\n`);

  // —— 路径 1：文本 span 树（调试）——
  console.log('─'.repeat(60));
  console.log('路径 1 · 文本 span 树（renderSpanTree）→ 控制台调试');
  console.log('─'.repeat(60));
  console.log(renderSpanTree(result.trace));

  // —— 路径 2：OTLP/JSON（OpenTelemetry 后端）——
  console.log('\n─'.repeat(60));
  console.log('路径 2 · OTLP/JSON（toOTLP）→ Jaeger/Tempo/Datadog');
  console.log('─'.repeat(60));
  const otlp = toOTLP(result.trace!, { serviceName: 'agentloop-demo' });
  const otlpJson = JSON.stringify(otlp, null, 2);
  console.log(`OTLP payload（节选前 600 字符）：`);
  console.log(otlpJson.slice(0, 600));
  console.log(`...(共 ${otlpJson.length} 字符，含 ${otlp.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0} 个 OTLP span)`);

  // —— 路径 3：扁平 JSON 落盘（审计）——
  console.log('\n─'.repeat(60));
  console.log('路径 3 · 扁平 JSON 落盘（flattenSpans）→ 审计 / 长期存储');
  console.log('─'.repeat(60));
  const flat = flattenSpans(result.trace);
  const auditJson = JSON.stringify({ exportedAt: new Date().toISOString(), spans: flat }, null, 2);
  // 写到 data/（gitignored，不污染仓库）；目录不存在则创建
  const auditDir = 'data';
  try {
    await import('node:fs').then((fs) => fs.mkdirSync(auditDir, { recursive: true }));
  } catch {
    /* 目录已存在则忽略 */
  }
  const auditPath = `${auditDir}/trace-audit-export.json`;
  writeFileSync(auditPath, auditJson);
  console.log(`已写出审计 JSON：${auditPath}（${flat.length} 个扁平 span，data/ 已 gitignored）`);
  console.log('首个 span 示例：');
  console.log(JSON.stringify(flat[0], null, 2));

  console.log('\n' + '═'.repeat(60));
  console.log('要点：');
  console.log('  1. renderSpanTree → 调试/日志（人读）。');
  console.log('  2. toOTLP → OpenTelemetry 后端（Jaeger/Tempo/Datadog，机器读）。');
  console.log('  3. flattenSpans + 落盘 → 审计/长期存储（合规追溯）。');
  console.log('  4. 三路同源：都来自 runLoop 返回的 result.trace，零额外埋点。');
  console.log('  5. trace 是运行时对齐工程的核心——每步决策可重建。');
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('示例运行失败：', err);
  process.exit(1);
});
