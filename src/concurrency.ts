/**
 * 并发限制器（Semaphore）：防止并发 LLM 调用撞限流墙。
 *
 * 缺口：loop.ts 的 Promise.all（多工具调用）、fanout.ts 的 allSettled（扇出）、
 * subagent delegate_parallel 三处并发 LLM 调用无节流。N 个 sub-agent = N 路并发 → 撞 429。
 *
 * 解决：Semaphore 限制同时在途的 LLM 请求数。集成点为 HttpLLMClient.doFetch
 * （所有 LLM 网络请求的唯一出口），一处节流全局生效。
 *
 * 零依赖，基于 Promise 队列实现异步信号量。
 */

import { env } from './env.ts';

/** 释放函数：调用后归还一个许可 */
type Release = () => void;

/**
 * 异步信号量：限制同时进行的异步操作数量。
 *
 * 经典 Promise-queue 实现：
 * - acquire()：有空闲许可则立即返回，否则入队等待
 * - release()：归还许可，唤醒队首等待者
 *
 * 线程安全（JS 单线程 event loop 天然安全）。
 */
export class Semaphore {
  private available: number;
  private readonly max: number;
  private readonly waiters: Array<() => void> = [];
  /** 当前在途（已 acquire 未 release）数量 */
  private inFlight = 0;

  constructor(max: number) {
    if (max < 1) max = 1;
    this.max = max;
    this.available = max;
  }

  /** 获取一个许可；若需等待则返回 pending Promise */
  async acquire(): Promise<Release> {
    if (this.available > 0) {
      this.available--;
      this.inFlight++;
      return this.makeRelease();
    }
    // 排队等待
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
    return this.makeRelease();
  }

  /** 创建 release 函数（闭包，确保只释放一次） */
  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      const next = this.waiters.shift();
      if (next) {
        // 唤醒等待者：许可「传递」给它（不归还到 available）
        next();
      } else {
        this.available++;
      }
    };
  }

  /** 当前在途数量（诊断用） */
  get currentInFlight(): number {
    return this.inFlight;
  }

  /** 最大许可数 */
  get capacity(): number {
    return this.max;
  }

  /** 等待队列长度 */
  get pending(): number {
    return this.waiters.length;
  }
}

/**
 * 用信号量包裹异步函数：自动 acquire/release（try/finally 保证释放）。
 *
 * 用法：
 *   const result = await withConcurrency(sem, () => doWork());
 */
export async function withConcurrency<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  const release = await sem.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * 全局 LLM 并发信号量（单例）。
 * 由 LOOP_LLM_MAX_CONCURRENT 环境变量控制，默认 4。
 *
 * 所有 HttpLLMClient 实例共享这一个信号量——确保即使创建多个 client，
 * 总并发也不超限。
 */
let globalLlmSemaphore: Semaphore | null = null;

export function getLlmSemaphore(): Semaphore {
  if (!globalLlmSemaphore) {
    const max = Number(env('LOOP_LLM_MAX_CONCURRENT', '4')) || 4;
    globalLlmSemaphore = new Semaphore(max);
  }
  return globalLlmSemaphore;
}

/** 重置全局信号量（测试用：让每个测试独立配置并发数） */
export function resetLlmSemaphore(max?: number): void {
  globalLlmSemaphore = new Semaphore(max ?? (Number(env('LOOP_LLM_MAX_CONCURRENT', '4')) || 4));
}
