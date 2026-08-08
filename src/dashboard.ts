#!/usr/bin/env tsx
/**
 * Web 仪表盘：实时监控 Agent Loop 运行状态。
 *
 * 零依赖 HTTP 服务器（node:http），提供：
 *   GET /          → HTML 页面（原生 JS 轮询渲染）
 *   GET /api/events → 当前缓冲的事件列表（JSON）
 *
 * 用法：
 *   1. 启动仪表盘：npx tsx src/dashboard.ts（默认端口 7788）
 *   2. 在 runLoop 的 onEvent 中调用 pushEvent() 推送事件
 *   3. 浏览器打开 http://localhost:7788
 *
 * 也可被 cli.ts/run-task.ts 集成：启动 dashboard 后把 onEvent 事件转发过来。
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { env } from './env.ts';
import type { LoopEvent, TokenUsage } from './types.ts';

/** 缓冲区：保留最近 N 条事件（环形缓冲，防内存无限增长） */
const MAX_EVENTS = 500;
const eventBuffer: Array<{ time: number; event: LoopEvent }> = [];

/** 累计统计 */
interface Stats {
  steps: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
  compacts: number;
  totalUsage: TokenUsage;
  startedAt: number;
  lastEventAt: number;
}

const stats: Stats = {
  steps: 0,
  toolCalls: 0,
  toolResults: 0,
  errors: 0,
  compacts: 0,
  totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  startedAt: Date.now(),
  lastEventAt: Date.now(),
};

/** 当前统计快照（测试/诊断用） */
export function getStats(): Readonly<Stats> {
  return stats;
}

/**
 * 推送一个 LoopEvent 到仪表盘。
 * 在 runLoop 的 onEvent 回调中调用。
 */
export function pushEvent(event: LoopEvent): void {
  const now = Date.now();
  eventBuffer.push({ time: now, event });
  if (eventBuffer.length > MAX_EVENTS) eventBuffer.shift();
  stats.lastEventAt = now;

  // 累计统计
  switch (event.type) {
    case 'thinking':
      stats.steps++;
      break;
    case 'tool_call':
      stats.toolCalls++;
      break;
    case 'tool_result':
      stats.toolResults++;
      break;
    case 'error':
      stats.errors++;
      break;
    case 'compact':
      stats.compacts++;
      break;
    case 'usage':
      stats.totalUsage = {
        promptTokens: stats.totalUsage.promptTokens + event.usage.promptTokens,
        completionTokens: stats.totalUsage.completionTokens + event.usage.completionTokens,
        totalTokens: stats.totalUsage.totalTokens + event.usage.totalTokens,
      };
      break;
  }
}

/** HTML 页面（内联，零文件依赖） */
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Agent Loop Dashboard</title>
<style>
  body { font-family: -apple-system, monospace; margin: 20px; background: #1a1a2e; color: #e0e0e0; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: #16213e; padding: 16px; border-radius: 8px; text-align: center; }
  .stat-value { font-size: 28px; font-weight: bold; color: #0f3460; }
  .stat-value { color: #e94560; }
  .stat-label { font-size: 12px; color: #888; margin-top: 4px; }
  #events { background: #16213e; padding: 12px; border-radius: 8px; max-height: 400px; overflow-y: auto; font-size: 13px; }
  .event { padding: 4px 8px; border-bottom: 1px solid #0f3460; }
  .event-time { color: #666; margin-right: 8px; }
  .event-type { font-weight: bold; }
  .tool_call { color: #e94560; } .tool_result { color: #0f3460; } .final { color: #53d769; }
  .error { color: #ff4444; } .thinking { color: #4da6ff; } .compact { color: #ff9800; }
  h1 { color: #e94560; }
</style>
</head>
<body>
<h1>🤖 Agent Loop Dashboard</h1>
<div class="stat-grid" id="stats"></div>
<h2>事件流</h2>
<div id="events"></div>
<script>
async function poll() {
  try {
    const res = await fetch('/api/events');
    const data = await res.json();
    // 统计卡片
    const s = data.stats;
    const cards = [
      ['步数', s.steps], ['工具调用', s.toolCalls], ['工具结果', s.toolResults],
      ['错误', s.errors], ['压缩', s.compacts],
      ['Prompt Tokens', s.totalUsage.promptTokens],
      ['Completion Tokens', s.totalUsage.completionTokens],
      ['总 Tokens', s.totalUsage.totalTokens],
    ];
    document.getElementById('stats').innerHTML = cards.map(([label, val]) =>
      '<div class="stat-card"><div class="stat-value">' + val + '</div><div class="stat-label">' + label + '</div></div>'
    ).join('');
    // 事件流（最新在前）
    const events = data.events.slice(-30).reverse();
    document.getElementById('events').innerHTML = events.map(e => {
      const t = new Date(e.time).toLocaleTimeString();
      const detail = e.event.type === 'tool_call' ? ' ' + e.event.call.name :
                     e.event.type === 'final' ? ' ' + e.event.answer.slice(0,60) :
                     e.event.type === 'error' ? ' ' + e.event.message.slice(0,80) : '';
      return '<div class="event"><span class="event-time">' + t + '</span><span class="event-type ' + e.event.type + '">' + e.event.type + '</span>' + detail + '</div>';
    }).join('') || '<div class="event">等待事件...</div>';
  } catch(e) { document.getElementById('events').innerHTML = '<div class="event">连接错误: ' + e + '</div>'; }
}
poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;

/**
 * 单个 HTTP 请求的路由处理（纯函数，不依赖网络）。
 *
 * 路由：
 *   GET /api/events → JSON { stats, events }
 *   其他任意路径    → HTML 页面
 *
 * 抽出为独立函数便于单元测试（无需启动真实 TCP 服务器，杜绝端口/并发 flaky）。
 */
export function handleDashboardRequest(_req: IncomingMessage, res: ServerResponse): void {
  if (_req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats, events: eventBuffer }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
  }
}

/**
 * 启动仪表盘 HTTP 服务器。
 *
 * @param port 端口；省略则读 LOOP_DASHBOARD_PORT 环境变量，默认 7788
 * @returns 已 listen 的 http.Server（调用方可保存以便后续 close() 优雅关闭）
 */
export function startDashboard(port?: number): Server {
  const p = port ?? Number(env('LOOP_DASHBOARD_PORT', '7788'));
  const server = createServer(handleDashboardRequest);
  server.listen(p, () => {
    console.log(`📊 仪表盘已启动：http://localhost:${p}`);
  });
  return server;
}

// 作为脚本直接运行时启动
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startDashboard();
}
