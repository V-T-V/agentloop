/**
 * 性能基准测试：测量关键路径的耗时与内存占用。
 *
 * 覆盖 agentloop 的热路径：
 * 1. token 估算（estimateTokens / estimateMemoryTokens）——压缩阈值判定的每步调用。
 * 2. 内存快照（Memory.snapshot）——每次 LLM 调用前读取。
 * 3. SSE 聚合（StreamAggregator）——流式输出的逐 chunk 处理。
 * 4. 检查点序列化（makeCheckpoint + JSON.stringify）——每步落盘。
 * 5. 完整 runLoop（StubLLM + 多步工具调用）——端到端主循环。
 *
 * 设计为零依赖：用 node:perf_hooks 的 performance.now() 计时，
 * process.memoryUsage() 测堆增量。提供 BenchmarkRunner 与 BenchmarkResult，
 * 既能被 test/bench.test.ts 校验正确性，也能被 scripts/bench.mjs 离线跑出报告。
 *
 * 用法：
 *   const r = new BenchmarkRunner();
 *   const res = await r.measure('token-estimate', () => estimateTokens(bigText), 1000);
 *   console.log(r.format(res));
 */

import { performance } from 'node:perf_hooks';
import { estimateMemoryTokens, estimateTokens } from './tokens.ts';
import { Memory } from './memory.ts';
import { StreamAggregator } from './streaming.ts';
import { makeCheckpoint } from './checkpoint.ts';
import { runLoop } from './loop.ts';
import type { ChatResult, LLMClient, Message, TokenUsage } from './types.ts';

/** 单次基准测试结果 */
export interface BenchmarkResult {
  /** 测试名 */
  name: string;
  /** 迭代次数 */
  iterations: number;
  /** 总耗时（ms） */
  totalMs: number;
  /** 平均每次耗时（μs） */
  avgUs: number;
  /** 单次最快（μs） */
  minUs: number;
  /** 单次最慢（μs） */
  maxUs: number;
  /** 中位数耗时（μs） */
  medianUs: number;
  /** P95 耗时（μs） */
  p95Us: number;
  /** 每秒操作数（ops/sec） */
  opsPerSec: number;
  /** 堆内存增量（字节，可选；仅 measureWithMemory 测） */
  heapDelta?: number;
  /** 单位标签（如 '次'、'token'） */
  unit?: string;
}

/**
 * 基准测试运行器：提供计时、内存测量与结果格式化。
 *
 * 设计为「预热 + 多轮计时」：先跑若干次预热（稳定 JIT），再正式计时取统计量。
 */
export class BenchmarkRunner {
  /** 默认预热次数 */
  readonly warmup: number;

  constructor(warmup = 50) {
    this.warmup = warmup;
  }

  /**
   * 测量一个同步函数的执行耗时。
   * @param name 测试名
   * @param fn 被测函数
   * @param iterations 正式计时迭代次数
   * @param unit 单位标签
   */
  measure(name: string, fn: () => void, iterations = 1000, unit?: string): BenchmarkResult {
    // 预热
    const warm = Math.min(this.warmup, iterations);
    for (let i = 0; i < warm; i++) fn();

    // 正式计时
    const samples: number[] = new Array(iterations);
    const startTotal = performance.now();
    for (let i = 0; i < iterations; i++) {
      const s = performance.now();
      fn();
      samples[i] = performance.now() - s;
    }
    const totalMs = performance.now() - startTotal;
    return this.computeStats(name, samples, totalMs, unit);
  }

  /**
   * 测量一个异步函数的执行耗时。
   */
  async measureAsync(name: string, fn: () => Promise<void>, iterations = 100, unit?: string): Promise<BenchmarkResult> {
    const warm = Math.min(this.warmup, iterations);
    for (let i = 0; i < warm; i++) await fn();

    const samples: number[] = new Array(iterations);
    const startTotal = performance.now();
    for (let i = 0; i < iterations; i++) {
      const s = performance.now();
      await fn();
      samples[i] = performance.now() - s;
    }
    const totalMs = performance.now() - startTotal;
    return this.computeStats(name, samples, totalMs, unit);
  }

  /**
   * 测量并附带堆内存增量（单次大对象创建场景）。
   * 强制 GC（若可用 --expose-gc）后测堆差值。
   */
  measureWithMemory(name: string, fn: () => void, iterations = 100, unit?: string): BenchmarkResult {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (gc) gc();
    const before = process.memoryUsage().heapUsed;
    const res = this.measure(name, fn, iterations, unit);
    if (gc) gc();
    const after = process.memoryUsage().heapUsed;
    return { ...res, heapDelta: after - before };
  }

  /** 从样本计算统计量 */
  private computeStats(name: string, samples: number[], totalMs: number, unit?: string): BenchmarkResult {
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const iterations = sorted.length;
    const avgUs = (sum / iterations) * 1000;
    const medianUs = sorted[Math.floor(iterations / 2)]! * 1000;
    const p95Idx = Math.min(iterations - 1, Math.floor(iterations * 0.95));
    const p95Us = sorted[p95Idx]! * 1000;
    return {
      name,
      iterations,
      totalMs,
      avgUs,
      minUs: sorted[0]! * 1000,
      maxUs: sorted[iterations - 1]! * 1000,
      medianUs,
      p95Us,
      opsPerSec: iterations / (totalMs / 1000),
      unit,
    };
  }

  /** 把单条结果格式化为可读字符串 */
  format(r: BenchmarkResult): string {
    const mem = r.heapDelta !== undefined ? ` | heap +${(r.heapDelta / 1024).toFixed(1)}KB` : '';
    const unit = r.unit ? `/${r.unit}` : '';
    return (
      `[${r.name}] ${r.iterations} 次 | ` +
      `avg ${r.avgUs.toFixed(2)}μs${unit} | ` +
      `p50 ${r.medianUs.toFixed(2)}μs | p95 ${r.p95Us.toFixed(2)}μs | ` +
      `${r.opsPerSec.toFixed(0)} ops/s${mem}`
    );
  }
}

// —————————— 预置基准场景（供 scripts/bench.mjs 与测试复用）——————————

/** 生成指定长度的中文+ASCII 混合文本 */
export function makeText(chars: number): string {
  let s = '';
  const cjk = '中文测试内容片段';
  const ascii = 'abcdefghij ';
  for (let i = 0; i < chars; i++) {
    s += i % 3 === 0 ? cjk[i % cjk.length] : ascii[i % ascii.length];
  }
  return s;
}

/** 造一个有 N 条消息的 memory */
export function makeMemory(n: number, contentLen = 100): Memory {
  const m = new Memory('系统提示词用于测试');
  for (let i = 0; i < n; i++) m.add({ role: 'user', content: makeText(contentLen) });
  return m;
}

/** 返回固定回答的 StubLLM（不消耗真实 token） */
export function stubLLM(answer = '完成'): LLMClient {
  const u: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
  return {
    isStub: true,
    supportsStream: true,
    async chat(): Promise<ChatResult> {
      return { message: { role: 'assistant', content: answer }, usage: u };
    },
    async chatStream(): Promise<ChatResult> {
      return { message: { role: 'assistant', content: answer }, usage: u };
    },
  };
}

/** 跑全部预置基准，返回结果数组 */
export async function runAllBenchmarks(): Promise<BenchmarkResult[]> {
  const r = new BenchmarkRunner();
  const results: BenchmarkResult[] = [];

  // 1. token 估算（单条长文本）
  const longText = makeText(10_000);
  results.push(r.measure('estimateTokens(10k chars)', () => estimateTokens(longText), 5000, '次'));

  // 2. estimateMemoryTokens（1000 条消息）
  const bigMemory = makeMemory(1000, 200);
  results.push(r.measure('estimateMemoryTokens(1000 msgs)', () => estimateMemoryTokens(bigMemory.snapshot()), 500, '次'));

  // 3. Memory.snapshot（带滑动窗口裁剪）
  const windowed = new Memory('sys', { windowSize: 50 });
  for (let i = 0; i < 500; i++) windowed.add({ role: 'user', content: makeText(50) });
  results.push(r.measure('Memory.snapshot(window=50/500)', () => windowed.snapshot(), 2000, '次'));

  // 4. SSE 聚合（100 chunk content）
  results.push(
    r.measure('StreamAggregator(100 chunks)', () => {
      const agg = new StreamAggregator();
      for (let i = 0; i < 100; i++) agg.feed({ content: 'a' });
      agg.take();
    }, 1000, '次'),
  );

  // 5. 检查点序列化（500 条消息）
  results.push(
    r.measure('makeCheckpoint+stringify(500 msgs)', () => {
      const ckpt = makeCheckpoint({
        runId: 'bench',
        step: 5,
        maxSteps: 10,
        messages: bigMemory.serializeMessages(),
        totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
      JSON.stringify(ckpt);
    }, 200, '次'),
  );

  // 6. 端到端 runLoop（3 步，StubLLM）
  results.push(
    await r.measureAsync(
      'runLoop(StubLLM 3步)',
      async () => {
        await runLoop({
          llm: stubLLM('答案'),
          tools: [],
          system: 'sys',
          user: 'q',
          stream: false,
          maxSteps: 3,
        });
      },
      50,
      '次',
    ),
  );

  return results;
}
