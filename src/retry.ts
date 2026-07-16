// 指数退避重试（搬自 agentresearch/src/utils/retry.ts，去掉 logger 依赖保持零依赖）。
// 日志前缀改为 [loop] 以匹配本项目。

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (error: unknown, attempt: number) => boolean;
}

/** 指数退避 + 加性抖动：base * 2^attempt + random*base，封顶 max */
function backoff(attempt: number, base: number, max: number): number {
  const exp = base * 2 ** attempt;
  const jitter = Math.random() * base;
  return Math.min(exp + jitter, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 重试包裹器：循环调用 fn，失败且 retryOn 通过则退避重试。
 * retries 是「重试次数」，总尝试次数 = retries + 1。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const retryOn = options.retryOn ?? (() => true);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (attempt >= retries || !retryOn(e, attempt)) {
        throw e;
      }
      const wait = backoff(attempt, baseDelayMs, maxDelayMs);
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[loop] 第 ${attempt + 1} 次失败（${msg}），${Math.round(wait)}ms 后重试…`);
      await sleep(wait);
    }
  }
  throw lastError;
}

/** 是否为可重试的 HTTP 状态码：429 限流 或 5xx 服务端错误（4xx 业务错误不重试） */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
