/**
 * 结构化错误：带 HTTP 状态码的 LLM 请求错误。
 *
 * 让重试判定（retryOn）直接读 status 字段，而不再靠正则匹配消息字符串。
 * 这是本项目相对 agentresearch 的一处关键改进。
 */

export class LlmHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`LLM 请求失败 ${status}: ${detail}`);
    this.name = 'LlmHttpError';
    this.status = status;
  }
}
