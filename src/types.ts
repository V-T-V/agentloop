/**
 * Agent Loop 核心类型定义。
 *
 * 这里只定义与 LLM / 工具调用相关的「形状」，不引入任何运行时依赖，
 * 以便 loop.ts / llm.ts / tools/* 共享同一套类型契约。
 *
 * 设计原则（与 2026 业界共识、Anthropic《Building Effective Agents》一致）：
 * - 平坦的消息历史（flat message list），不做复杂状态机
 * - 原生 tool-calling API（OpenAI function-calling）
 * - 工具结果统一为字符串，方便喂回 LLM
 */

/** 消息角色：system / user / assistant / tool */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** OpenAI 风格的工具调用结构 */
export interface ToolCall {
  /** 调用唯一标识，用于把 tool 结果回填到对应调用 */
  id: string;
  /** 工具名（需与 ToolDef.name 一致） */
  name: string;
  /** 参数对象，已从 JSON 字符串解析为对象 */
  arguments: Record<string, unknown>;
}

/** 多模态内容部件：文本或图片（OpenAI content parts 兼容） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

/** 一条对话消息（OpenAI 兼容子集，支持多模态） */
export interface Message {
  role: Role;
  /**
   * 消息内容：
   * - string：纯文本（最常见）
   * - ContentPart[]：多模态（文本+图片混合）
   * - null：无内容（如仅有 toolCalls 的 assistant 消息）
   */
  content: string | ContentPart[] | null;
  /** assistant 发起的工具调用（仅 role === 'assistant' 时可能出现） */
  toolCalls?: ToolCall[];
  /** tool 消息需要回填的 tool_call_id */
  toolCallId?: string;
  /** tool 消息里被调用的工具名，便于日志展示 */
  name?: string;
}

/** JSON Schema 的最小子集，足以描述工具参数 */
export interface JsonSchemaProp {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: (string | number)[];
  items?: JsonSchemaProp;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}

/** 工具参数的 JSON Schema（根必须是 object） */
export interface ToolParameters {
  type: 'object';
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
}

/** 工具执行结果 */
export interface ToolResult {
  /** 是否成功执行（失败也返回，交给 LLM 决定后续） */
  ok: boolean;
  /** 序列化后喂给 LLM 的字符串内容 */
  output: string;
}

/**
 * 工具定义：名字 + 描述 + 参数 schema + 执行函数。
 * 泛型 TArgs 用于「定义具体工具」时获得参数类型推断。
 */
export interface ToolDef<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: ToolParameters;
  /** 执行工具；args 已按 schema 校验，返回字符串化结果。失败也应返回（ok:false），而非抛出 */
  execute: (args: TArgs) => Promise<ToolResult> | ToolResult;
  /**
   * 是否为高风险工具，需在人机协同（HITL）审批通过后才执行。
   * 默认 false。标记 true 的工具（如 http_get、未来 MCP 工具）在执行前会触发 onApproval 钩子。
   */
  requiresApproval?: boolean;
}

/** HITL 审批请求：交给 onApproval 钩子决定是否放行 */
export interface ApprovalRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  step: number;
}

/** 审批结果：批准直接执行；拒绝需附原因（会回填给 LLM，让它据以修正） */
export type ApprovalDecision =
  | { approved: true }
  | { approved: false; reason: string };

/**
 * 擦除泛型的工具类型，用作「工具集合」的容器元素。
 * 具体工具（带自己的 TArgs）可安全赋值给它——
 * execute 入参声明为更窄的 Record<string,unknown>，
 * 由 loop.ts 在调用前保证传入解析后的参数。
 */
export type AnyToolDef = ToolDef<Record<string, unknown>>;

/** 循环结束的原因 */
export type StopReason = 'final' | 'max_steps' | 'error' | 'budget_exceeded';

/** 一次 token 用量（OpenAI usage 字段子集） */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 总 token；若服务端未返回则由前两者相加兜底 */
  totalTokens: number;
}

/** Agent 循环运行过程中向外广播的事件，供 CLI / 测试做可视化 */
export type LoopEvent =
  | { type: 'thinking'; step: number; message: string }
  | { type: 'tool_call'; step: number; call: ToolCall }
  | { type: 'tool_result'; step: number; callId: string; result: ToolResult }
  | { type: 'final'; answer: string }
  | { type: 'max_steps'; steps: number }
  | { type: 'error'; message: string }
  /** 预算耗尽（M6: 专用事件，不被误计为 error） */
  | { type: 'budget_exceeded'; spent: number; limit: number; answer: string }
  /** 流式增量文本：每收到一段 token 推送一次（仅流式模式） */
  | { type: 'stream_delta'; step: number; text: string }
  /** 一次 LLM 调用的用量上报 */
  | { type: 'usage'; step: number; usage: TokenUsage }
  /** 触发了上下文压缩 */
  | {
      type: 'compact';
      step: number;
      beforeTokens: number;
      afterTokens: number;
      beforeMessages: number;
      afterMessages: number;
    }
  /** HITL：高风险工具请求审批（等待 onApproval 决定） */
  | { type: 'approval_request'; step: number; call: ToolCall }
  /** HITL：审批结果（批准则随后执行，拒绝则跳过执行并回填） */
  | { type: 'approval_result'; step: number; callId: string; decision: ApprovalDecision };

/** LLM 调用的返回：助手消息 + 本次用量（流式/非流式统一） */
export interface ChatResult {
  message: Message;
  usage: TokenUsage | null;
}

/** 结构化输出格式（OpenAI 兼容 response_format） */
export interface ResponseFormat {
  /** json_object=保证返回合法 JSON；json_schema=按给定 schema 返回 */
  type: 'json_object' | 'json_schema';
  /** 仅 type=json_schema 时使用：定义返回 JSON 的 schema */
  schema?: Record<string, unknown>;
}

/** LLM 客户端接口：给定消息与可用工具，返回助手消息 */
export interface LLMClient {
  /** 是否为真实 LLM（用于日志区分真实/演示） */
  readonly isStub: boolean;
  /** 是否支持流式（StubLLM 也支持，用模拟逐字） */
  readonly supportsStream: boolean;
  /** 单次补全：传入完整对话历史 + 可用工具描述，返回助手消息与用量 */
  chat(input: { messages: Message[]; tools: ToolDef[]; responseFormat?: ResponseFormat }): Promise<ChatResult>;
  /**
   * 流式补全：逐 token 通过 onToken 回调推送，最终返回完整消息与用量。
   * 支持通过 signal 早停。未调用方走 chat() 即可。
   */
  chatStream(
    input: { messages: Message[]; tools: ToolDef[]; responseFormat?: ResponseFormat },
    options: { onToken?: (token: string) => void; signal?: AbortSignal },
  ): Promise<ChatResult>;
}

// —————————— 评估（LLM-as-judge）——————————

/** 单个评估维度 */
export interface EvalDimension {
  /** 维度键（如 tool_selection） */
  key: string;
  /** 展示名（如「工具选择」） */
  label: string;
  /** 评分标准描述（写进 judge prompt，明确每个分数档含义，防偏差） */
  criteria: string;
}

/** 一次评估的结果 */
export interface EvalResult {
  /** 各维度分数（键 → 1-5 整数） */
  scores: Record<string, number>;
  /** 加权平均总分（0-100，便于横向比较） */
  overall: number;
  /** judge 给出的总体理由 */
  reasoning: string;
  /** 改进建议 */
  suggestions: string[];
}

