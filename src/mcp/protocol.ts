/**
 * MCP（Model Context Protocol）协议类型定义。
 *
 * MCP 基于 JSON-RPC 2.0，支持 stdio / SSE / WebSocket 传输。本项目实现
 * stdio 传输（最通用：客户端 spawn 服务端子进程，通过 stdin/stdout 收发消息）。
 *
 * 协议流程：
 *   1. 客户端 → initialize（含 protocolVersion + capabilities + clientInfo）
 *   2. 服务端 → InitializeResult（含 protocolVersion + capabilities + serverInfo）
 *   3. 客户端 → initialized 通知
 *   4. 此后可调用：tools/list, tools/call, resources/list, prompts/list 等
 *
 * 参考：https://modelcontextprotocol.io/specification/2025-11-25
 */

// —————————— JSON-RPC 2.0 基础类型 ——————————

/** JSON-RPC 请求（有 id，需响应） */
export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: P;
}

/** JSON-RPC 通知（无 id，无需响应） */
export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

/** JSON-RPC 响应（成功） */
export interface JsonRpcResponse<R = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result: R;
}

/** JSON-RPC 错误响应 */
export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

/** 任一服务端消息（响应或通知） */
export type ServerMessage<R = unknown> = JsonRpcResponse<R> | JsonRpcError | JsonRpcNotification;

// —————————— initialize 握手 ——————————

export interface ClientInfo {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
}

export interface InitializeParams {
  protocolVersion: string;
  capabilities: ClientCapabilities;
  clientInfo: ClientInfo;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: { name: string; version: string };
  instructions?: string;
}

// —————————— tools ——————————

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

export interface ToolsListResult {
  tools: ToolDefinition[];
  nextCursor?: string;
}

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolCallResultContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolCallResult {
  content: ToolCallResultContent[];
  isError?: boolean;
}

// —————————— resources ——————————

export interface Resource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourcesListResult {
  resources: Resource[];
  nextCursor?: string;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface ResourcesReadResult {
  contents: ResourceContent[];
}

// —————————— prompts ——————————

export interface Prompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface PromptsListResult {
  prompts: Prompt[];
  nextCursor?: string;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptsGetResult {
  description?: string;
  messages: PromptMessage[];
}

// —————————— MCP 标准错误码 ——————————

export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
