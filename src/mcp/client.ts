/**
 * MCP stdio 客户端：JSON-RPC 2.0 over stdin/stdout。
 *
 * 流程：
 *   1. spawn 服务端子进程（如 npx -y @modelcontextprotocol/server-filesystem）
 *   2. initialize 握手 → initialized 通知
 *   3. tools/list 获取工具列表
 *   4. tools/call 调用工具
 *   5. close() 关闭子进程
 *
 * 消息格式：每行一个 JSON-RPC 消息（newline-delimited JSON）。
 * 客户端写 stdout→服务端 stdin；读 服务端 stdout→客户端。
 *
 * 零依赖：仅用 node:child_process, node:readline。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  InitializeResult,
  JsonRpcRequest,
  ServerMessage,
  ToolCallParams,
  ToolCallResult,
  ToolsListResult,
  ResourcesListResult,
  PromptsListResult,
} from './protocol.ts';

/** 服务端启动配置 */
export interface McpServerConfig {
  /** 启动命令（如 'npx', 'node', 'python'） */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
}

/** pending 请求的 resolver */
interface PendingRequest {
  resolve: (msg: ServerMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * MCP stdio 客户端：管理一个 MCP 服务端子进程的完整生命周期。
 *
 * 用法：
 *   const client = new McpStdioClient({ command: 'npx', args: ['-y', '@mcp/server-fs'] });
 *   await client.connect();
 *   const tools = await client.listTools();
 *   const result = await client.callTool('read_file', { path: '/tmp/a.txt' });
 *   await client.close();
 */
export class McpStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private initialized = false;
  private serverInfo: InitializeResult | null = null;

  constructor(private readonly config: McpServerConfig) {}

  /** 当前请求 id 计数器（测试用） */
  get currentId(): number {
    return this.nextId;
  }

  /** 是否已完成握手 */
  get isConnected(): boolean {
    return this.initialized && this.proc !== null;
  }

  /** 服务端信息（connect 后可用） */
  get server(): InitializeResult | null {
    return this.serverInfo;
  }

  /** 启动子进程并完成 initialize 握手 */
  async connect(timeoutMs = 10000): Promise<InitializeResult> {
    if (this.proc) throw new Error('MCP 客户端已连接');

    this.proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error('无法获取子进程 stdin/stdout');
    }

    // 逐行读取服务端 stdout
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    // stderr 用于调试（不影响协议）
    if (this.proc.stderr) {
      const errRl = createInterface({ input: this.proc.stderr });
      errRl.on('line', (line) => {
        // 服务端 stderr 日志，静默或转发（暂不处理）
        void line;
      });
    }

    this.proc.on('exit', (code) => {
      this.proc = null;
      this.initialized = false;
      // 拒绝所有 pending
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP 服务端退出（code=${code}）`));
      }
      this.pending.clear();
    });

    // initialize 握手
    this.serverInfo = await this.request<InitializeResult>('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'agentloop', version: '1.0.0' },
    }, timeoutMs);

    // 发送 initialized 通知
    this.notify('initialized', {});
    this.initialized = true;
    return this.serverInfo;
  }

  /** 处理服务端传来的一行 JSON */
  private handleLine(line: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(line) as ServerMessage;
    } catch {
      return; // 非 JSON 行忽略
    }

    // 响应（有 id）：找到对应 pending 并 resolve
    if ('id' in msg && 'result' in msg) {
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(msg);
      }
    } else if ('id' in msg && 'error' in msg) {
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(msg.error.message));
      }
    }
    // 通知（无 id）：暂不处理服务端推送（如 tools/list_changed）
  }

  /** 发送 JSON-RPC 请求并等待响应 */
  private async request<R>(method: string, params: unknown, timeoutMs = 30000): Promise<R> {
    if (!this.proc?.stdin) throw new Error('MCP 客户端未连接');
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (msg) => resolve((msg as { result: R }).result),
        reject,
        timer,
      });

      this.proc!.stdin!.write(JSON.stringify(req) + '\n');
    });
  }

  /** 发送 JSON-RPC 通知（无 id，不等待响应） */
  private notify(method: string, params: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.proc.stdin.write(msg + '\n');
  }

  /** tools/list：获取服务端可用工具 */
  async listTools(): Promise<ToolsListResult> {
    return this.request<ToolsListResult>('tools/list', {});
  }

  /** tools/call：调用指定工具 */
  async callTool(params: ToolCallParams): Promise<ToolCallResult> {
    return this.request<ToolCallResult>('tools/call', params);
  }

  /** resources/list：获取可用资源 */
  async listResources(): Promise<ResourcesListResult> {
    return this.request<ResourcesListResult>('resources/list', {});
  }

  /** prompts/list：获取可用提示模板 */
  async listPrompts(): Promise<PromptsListResult> {
    return this.request<PromptsListResult>('prompts/list', {});
  }

  /** 关闭子进程 */
  async close(): Promise<void> {
    this.initialized = false;
    const proc = this.proc;
    this.proc = null; // 先置 null，防止 exit handler 二次操作
    if (proc) {
      proc.stdin?.end();
      try {
        proc.kill('SIGTERM');
      } catch {
        // 可能已退出
      }
      // 给进程一点时间优雅退出
      await new Promise((r) => setTimeout(r, 100));
      try {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // 已退出
      }
    }
    // 清理 pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('MCP 客户端已关闭'));
    }
    this.pending.clear();
  }
}
