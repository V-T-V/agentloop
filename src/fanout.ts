/**
 * 并行扇出编排器（fan-out / fan-in，即 scatter-gather）。
 *
 * 把多个独立子任务并发执行，收集结果后聚合返回。这是 Azure 架构中心定义的
 * 「并发编排」标准形态，适用于「同时查多个来源再汇总」类任务。
 *
 * 三大陷阱防护（Towards AI《When Parallelism Bites Back》）：
 * 1. 落后者瓶颈（straggler）：每个子任务独立超时，超时即放弃该任务，不等它拖垮全局。
 * 2. 错误隔离：单个子任务抛错/超时只标记该项失败，不影响其他（Promise.allSettled 语义）。
 * 3. 聚合成本：返回结构化结果 + 汇总，调用方（通常是 LLM）能直接读懂。
 *
 * 设计为通用编排器：runner 是任意的 async 函数，扇出本身不耦合 agent/loop 逻辑，
 * subagent.ts 会把「跑一个子 runLoop」作为 runner 传入。
 */

import { Semaphore, withConcurrency } from './concurrency.ts';

/** 一个待执行的子任务 */
export interface FanOutTask<TInput = string> {
  id: string;
  input: TInput;
}

/** 单个子任务的执行结果 */
export interface FanOutItemResult {
  id: string;
  /** 是否成功完成（超时/抛错均为 false） */
  ok: boolean;
  /** 结果文本（成功）或错误说明（失败） */
  output: string;
  /** 耗时（毫秒） */
  durationMs: number;
}

/** 一次扇出的聚合结果 */
export interface FanOutResult {
  results: FanOutItemResult[];
  /** 成功数量 */
  succeeded: number;
  /** 失败数量（超时 + 抛错） */
  failed: number;
  /** 给调用方（LLM）的可读汇总 */
  summary: string;
}

export interface FanOutOptions {
  /** 每个子任务独立超时（毫秒），0 表示不超时。默认 30000 */
  timeoutMs?: number;
  /**
   * 最大并发数（信号量限制）。0 或不传表示不限制（全部并发）。
   * 用于防止扇出时 N 个子任务同时调 LLM 撞 429。
   */
  maxConcurrency?: number;
}

/**
 * 带超时地执行一个 promise：超时则 reject（在 runner 层会被捕获为失败）。
 * 用 AbortSignal 实现，确保超时后能释放资源。
 */
function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return fn(new AbortController().signal);
  return new Promise<T>((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`子任务超时（${timeoutMs}ms）`));
    }, timeoutMs);
    fn(ctrl.signal)
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/**
 * 并发执行所有子任务，收集结果。
 * runner 接收 (task, signal)，返回 string 结果；失败（抛错/超时）的项不中断其他。
 */
export async function fanOut<TInput>(
  tasks: FanOutTask<TInput>[],
  runner: (task: FanOutTask<TInput>, signal: AbortSignal) => Promise<string>,
  options: FanOutOptions = {},
): Promise<FanOutResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const sem = options.maxConcurrency && options.maxConcurrency > 0 ? new Semaphore(options.maxConcurrency) : null;

  // 全部并发启动（若有 sem 则受信号量节流）；allSettled 保证任何一项失败都不影响其他
  const settled = await Promise.allSettled(
    tasks.map(async (task): Promise<FanOutItemResult> => {
      const start = performance.now();
      // 并发节流：信号量包裹 runner 执行
      const exec = () => withTimeout((signal) => runner(task, signal), timeoutMs);
      try {
        const output = sem ? await withConcurrency(sem, exec) : await exec();
        return {
          id: task.id,
          ok: true,
          output,
          durationMs: Math.round(performance.now() - start),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          id: task.id,
          ok: false,
          output: `失败：${msg}`,
          durationMs: Math.round(performance.now() - start),
        };
      }
    }),
  );

  // allSettled 永远是 fulfilled（我们在 map 内部已捕获异常），取 value
  const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : {
    id: '?',
    ok: false,
    output: '失败：未知错误',
    durationMs: 0,
  }));

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  // 可读汇总：供 LLM 直接理解整体情况
  const parts = results.map(
    (r) => `【${r.id}】${r.ok ? '✅' : '❌'} ${r.output}`,
  );
  const summary =
    `共 ${results.length} 个子任务：成功 ${succeeded}，失败 ${failed}。\n` + parts.join('\n');

  return { results, succeeded, failed, summary };
}
