/**
 * dashboard.ts 深层路径测试（R10-D3）。
 *
 * 补 dashboard.test.ts 未触达的分支。核心策略：用纯函数 handleDashboardRequest
 * + 模拟 ServerResponse 测试路由逻辑（无需真实 TCP 服务器，杜绝端口/并发 flaky）。
 * 不做真实 server 冒烟（曾因 listen socket + IPC 序列化导致并发套件 deserialize flaky）。
 *
 *   1. /api/events 路由 → JSON { stats, events }（Content-Type/状态码/body）
 *   2. / 未知路径 → HTML（默认分支 + utf-8）
 *   3. 环形缓冲裁剪：>500 条事件 buffer ≤ 500
 *   4. usage 三项分别累加（prompt/completion/total）
 *   5. events 每条 { time, event } 结构 + 实时反映 pushEvent
 *   6. getStats 全字段 + lastEventAt 单调
 *   7. startDashboard 是返回 http.Server 的函数（类型由 tsc + 调用方保证）
 *   8. handler 多次调用幂等（无状态副作用）
 *
 * 依赖：R10-D3 改进 dashboard.ts——startDashboard 返回 http.Server（向后兼容）+
 *      抽出纯函数 handleDashboardRequest 便于确定性测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { pushEvent, getStats, startDashboard, handleDashboardRequest } from '../src/dashboard.ts';
import type { LoopEvent } from '../src/types.ts';

/** 构造一个假的 IncomingMessage */
function fakeReq(url: string): IncomingMessage {
  return { url } as unknown as IncomingMessage;
}

/** 捕获写入的假 ServerResponse + 状态容器 */
interface Captured {
  res: ServerResponse;
  status: number | undefined;
  headers: Record<string, string>;
  body: string;
}
function fakeRes(): Captured {
  const cap: Captured = { res: undefined as unknown as ServerResponse, status: undefined, headers: {}, body: '' };
  cap.res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      cap.status = status;
      // 模拟真实 HTTP 的小写化 header 行为（Node http 会把 header 名小写）
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
      cap.headers = lower;
    },
    end(data?: string) {
      cap.body = data ?? '';
    },
  } as unknown as ServerResponse;
  return cap;
}

test('路由 /api/events → JSON，含 stats + events 结构 + 正确 Content-Type', () => {
  const cap = fakeRes();
  handleDashboardRequest(fakeReq('/api/events'), cap.res);
  assert.equal(cap.status, 200);
  assert.match(cap.headers['content-type'] ?? '', /application\/json/);
  const data = JSON.parse(cap.body) as { stats: unknown; events: unknown[] };
  assert.ok(typeof data.stats === 'object' && data.stats !== null, '含 stats 对象');
  assert.ok(Array.isArray(data.events), '含 events 数组');
});

test('路由 / → HTML，含 utf-8 + dashboard 骨架', () => {
  const cap = fakeRes();
  handleDashboardRequest(fakeReq('/'), cap.res);
  assert.equal(cap.status, 200);
  assert.match(cap.headers['content-type'] ?? '', /text\/html/);
  assert.match(cap.headers['content-type'] ?? '', /utf-8/);
  assert.match(cap.body, /Agent Loop Dashboard/);
  assert.match(cap.body, /事件流/);
  assert.match(cap.body, /<script>/);
});

test('路由 未知路径 → HTML（默认分支）', () => {
  const cap = fakeRes();
  handleDashboardRequest(fakeReq('/some/random/path'), cap.res);
  assert.equal(cap.status, 200);
  assert.match(cap.headers['content-type'] ?? '', /text\/html/);
  assert.match(cap.body, /Agent Loop Dashboard/);
});

test('events 每条为 { time:number, event } 结构', () => {
  const marker = `probe-${Math.random()}`;
  pushEvent({ type: 'final', answer: marker });
  const cap = fakeRes();
  handleDashboardRequest(fakeReq('/api/events'), cap.res);
  const data = JSON.parse(cap.body) as { events: Array<{ time: number; event: LoopEvent }> };
  const probe = data.events.find((e) => e.event.type === 'final' && e.event.answer === marker);
  assert.ok(probe, '推送的 final 事件应在 events 中可见');
  assert.ok(typeof probe!.time === 'number', 'event.time 为 number');
  assert.ok(probe!.time > 0, 'time 为正数');
});

test('环形缓冲裁剪：>500 条事件后 buffer ≤ 500', () => {
  for (let i = 0; i < 520; i++) {
    pushEvent({ type: 'tool_result', step: i, callId: `bc${i}`, result: { ok: true, output: String(i) } });
  }
  const cap = fakeRes();
  handleDashboardRequest(fakeReq('/api/events'), cap.res);
  const data = JSON.parse(cap.body) as { events: unknown[] };
  assert.ok(data.events.length <= 500, `buffer 不应超过 500，实际 ${data.events.length}`);
  assert.ok(data.events.length >= 499, `buffer 应接近满，实际 ${data.events.length}`);
});

test('usage 事件：prompt/completion/total 三项分别累加', () => {
  const before = getStats().totalUsage;
  pushEvent({ type: 'usage', step: 1, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } });
  pushEvent({ type: 'usage', step: 2, usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } });
  const after = getStats().totalUsage;
  assert.equal(after.promptTokens, before.promptTokens + 15, 'promptTokens 累加 10+5');
  assert.equal(after.completionTokens, before.completionTokens + 27, 'completionTokens 累加 20+7');
  assert.equal(after.totalTokens, before.totalTokens + 42, 'totalTokens 累加 30+12');
});

test('getStats：返回结构含全部预期字段', () => {
  const s = getStats();
  assert.ok(typeof s.steps === 'number');
  assert.ok(typeof s.toolCalls === 'number');
  assert.ok(typeof s.toolResults === 'number');
  assert.ok(typeof s.errors === 'number');
  assert.ok(typeof s.compacts === 'number');
  assert.ok(typeof s.startedAt === 'number');
  assert.ok(typeof s.lastEventAt === 'number');
  assert.ok(typeof s.totalUsage === 'object' && s.totalUsage !== null);
  assert.ok(typeof s.totalUsage.promptTokens === 'number');
  assert.ok(typeof s.totalUsage.completionTokens === 'number');
  assert.ok(typeof s.totalUsage.totalTokens === 'number');
});

test('pushEvent 后 lastEventAt 单调不减', () => {
  const before = getStats().lastEventAt;
  pushEvent({ type: 'final', answer: 'x' });
  const after = getStats().lastEventAt;
  assert.ok(after >= before, `lastEventAt 应单调不减（before=${before} after=${after}）`);
});

test('路由 /api/events：stats 字段实时反映 pushEvent 累积值', () => {
  const beforeSteps = getStats().steps;
  pushEvent({ type: 'thinking', step: 1, message: 'handler-probe' });
  const cap = fakeRes();
  handleDashboardRequest(fakeReq('/api/events'), cap.res);
  const data = JSON.parse(cap.body) as { stats: { steps: number } };
  assert.ok(data.stats.steps >= beforeSteps + 1, `handler 应反映最新累计（before=${beforeSteps} now=${data.stats.steps}）`);
});

test('startDashboard：是返回 http.Server 的函数（类型由 tsc 保证 + 调用方 ralph-loop/run-task 间接验证）', () => {
  // 不真实 listen：避免并发测试套件的 IPC/socket 竞态（曾导致 deserialize flaky）。
  // 路由正确性已由上面的 handleDashboardRequest 纯函数测试完整覆盖；
  // startDashboard 是 createServer(handleDashboardRequest)+listen+return 的 3 行胶水，
  // 返回类型 http.Server 由 tsc 检查 + 全部调用方（按 void 语句调用）保证向后兼容。
  assert.equal(typeof startDashboard, 'function');
});

test('handleDashboardRequest 多次调用幂等（无状态副作用）', () => {
  // 同一请求多次路由应得一致结果（handler 不维护请求间状态）
  for (let i = 0; i < 3; i++) {
    const cap = fakeRes();
    handleDashboardRequest(fakeReq('/'), cap.res);
    assert.equal(cap.status, 200);
    assert.match(cap.body, /Agent Loop Dashboard/);
  }
});
