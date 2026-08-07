# agentloop · AGENTS.md

## 项目内容（What）
聚焦 **Agent 主循环**的可嵌入执行内核。它只负责把 LLM ↔ 工具调用串成一个干净可靠的主循环，并集成 2026 业界公认让 Agent 长程可靠的 10+ 能力。**不做框架**，是给上层（CLI / 库 / 工作流平台 / 产品内 Agent）提供统一运行时的底座。

不做：不提供 UI、不绑定特定 LLM 厂商、不做声明式编排。

## 目标（Goal）
- 把「LLM ↔ 工具调用」的循环做到**最干净**，运行时零业务假设。
- 覆盖长程 Agent 的核心可靠性能力（见下），且每项可独立开关——关闭后优雅退化为朴素循环。
- 成功标准：无 API key 时（StubLLM）可跑通完整主循环；有 key 时可接任意 OpenAI-compatible endpoint；所有能力有测试验证。

## 当前情况（Status）
**功能完整，可作为稳定底座复用。** **51 个 TS 源文件、44 个测试文件、718 个测试用例、零运行时依赖**。

### 深度推进记录（deep-r1 ~ deep-r8 / R5 进行中）
- **r1**: 基线扫描 632 用例确认 + 读 AGENTS.md
- **r2-r3**: 补 mcp/registry.ts 独立测试 16 用例（findMcpConfig/loadMcpConfig/loadMcpFromConfig 边界）
- **r4**: 补 errors.ts 独立测试 14 用例（LlmHttpError/withRetry/classify）
- **r5**: 补 mcp/client.ts 深层路径 17 用例（超时/二次连接/JSON-RPC error/子进程退出）
- **r6**: **修 parseSSELine 不映射 snake_case tool_calls bug**（streaming.ts normalizeToolCalls，真实 OpenAI/GLM SSE 现可正确提取）+ 3 用例
- **r7**: 修 iterative.test flaky 隔离（LOOP_RESULTS_DIR 环境变量 + 独立临时目录）
- **r8**: env.ts 单元测试 15 用例（parseLine 引号/注释/空值/等号边界 + env 读取/fallback）

### 第五轮深化基线（R5-D1，2026-08-06）

**测试规模**：716 用例 / 47 测试文件（`npm test`）。

**R5 聚焦缺口清单**（按"有源文件但无配对测试文件"排序，纯逻辑优先补测）：

| 模块 | 源文件 | 行数 | 现状 | R5 目标 |
|------|--------|------|------|---------|
| **MCP 协议层** | `mcp/protocol.ts` | 205 | **完全无独立测试**，仅 mcp.test.ts happy-path | D2-D3：JSON-RPC 请求/响应/通知构造、批量、错误码、id 类型 |
| **MCP 适配层** | `mcp/adapter.ts` | 133 | **完全无独立测试** | D4：MCP 工具→LoopTool 适配、参数 schema 透传、资源/提示枚举 |
| **存储文件层** | `storage-file.ts` | 130 | **完全无独立测试**，仅 storage.test.ts 间接 | D5：原子写/读/锁/并发竞争/坏 JSON 恢复 |
| **运行时配置** | `runtime.ts` | 48 | 无独立测试 | D8 错误路径：默认值/环境覆盖/非法值兜底 |

**flaky 测试分析**（R5-D1 确认，D2 修复）：
- `retry.test.ts「退避时长封顶于 maxDelayMs」`：用 wall-clock 断言 `elapsed < 400ms`，在全量并发跑下因系统负载超出（实测 559ms）。**断言意图是验证退避封顶**——未封顶应为 `sum(1000*2^k) ≈ 31s`，封顶后为 5×50ms。修复方向：放宽上界到 2000ms（保留「远小于未封顶」的判别力），或改用注入时钟。
- `iterative.test.ts`：Node test-runner IPC 序列化错误 `Unable to deserialize cloned data`，是 runner 在并发下的已知问题，非测试逻辑缺陷；隔离单跑稳定通过。修复方向：将本文件标记为 `concurrency: 1`（文件级串行）。

PRODUCT.md 所列能力**全部真实落地**（均有源文件 + 导出符号 + 测试）：

| 能力 | 实现文件 | 状态 |
|------|----------|------|
| 上下文压缩 / auto-compact | `compact.ts` `tokens.ts` | ✅ |
| 流式输出（SSE） | `streaming.ts` | ✅ |
| 可观测性（span/trace） | `trace.ts` `metrics.ts` `trace-store.ts` | ✅ |
| OTel OTLP 导出 | `otel.ts` | ✅ |
| 并行 sub-agent | `subagent.ts` `fanout.ts` | ✅ |
| 长任务 / checkpoint | `long-task.ts` `checkpoint.ts` `run-task.ts` | ✅ |
| 持久化记忆 | `memory-store.ts` `storage.ts` `storage-file.ts` | ✅ |
| 人机审批（HITL） | `loop.ts` 的 `onApproval` 钩子 | ✅（融入 loop） |
| 轨迹回放 / 评估 | `trajectory.ts` `eval.ts` `verify.ts` | ✅ |
| 预算 / 重试 / 执行安全 | `budget.ts` `retry.ts` `errors.ts` | ✅ |
| MCP 工具协议 | `mcp/`（adapter/client/protocol/registry） | ✅ |
| 搜索（web/recall） | `tools/search/` `web_search.ts` | ✅ |
| 性能基准测试（R6 新增） | `bench.ts` + `scripts/bench.mjs` | ✅ |
| 配置校验系统（R7 新增） | `config-check.ts` | ✅ |
| 调试工具（R8 新增） | `debug.ts` | ✅ |

### 源文件完成度矩阵（51 文件）

| 模块 | 源文件 | 配对测试 | 测试用例 | 完成度 |
|------|--------|----------|----------|--------|
| 主循环 | `loop.ts` `runtime.ts` | loop.test.ts iterative.test.ts | ~30 | ✅ |
| 上下文工程 | `compact.ts` `tokens.ts` | compact.test.ts **compact-deep.test.ts** prune.test.ts tokens.test.ts | ~50 | ✅✅ |
| 流式 | `streaming.ts` | streaming.test.ts **streaming-deep.test.ts** | ~40 | ✅✅ |
| 执行安全 | `budget.ts` `retry.ts` `errors.ts` | budget.test.ts **budget-deep.test.ts** | ~50 | ✅✅ |
| Durable | `checkpoint.ts` `long-task.ts` `run-task.ts` | checkpoint.test.ts **checkpoint-deep.test.ts** long-task.test.ts | ~60 | ✅✅ |
| 可观测性 | `trace.ts` `metrics.ts` `trace-store.ts` `otel.ts` `trajectory.ts` | trace.test.ts trace-store.test.ts otel.test.ts trajectory.test.ts metrics.test.ts | ~80 | ✅ |
| 评估 | `eval.ts` `verify.ts` | eval.test.ts verify.test.ts | ~40 | ✅ |
| 记忆/存储 | `memory.ts` `memory-store.ts` `storage.ts` `storage-file.ts` | memory.test.ts memory-store.test.ts storage.test.ts | ~50 | ✅ |
| Sub-agent | `subagent.ts` `fanout.ts` `ralph-loop.ts` | subagent.test.ts fanout.test.ts ralph-loop.test.ts | ~40 | ✅ |
| 多模态 | `multimodal.ts` | multimodal.test.ts | ~10 | ✅ |
| MCP | `mcp/adapter.ts` `mcp/client.ts` `mcp/protocol.ts` `mcp/registry.ts` | mcp.test.ts | ~30 | ✅ |
| 工具 | `tools/registry.ts` `calculator.ts` `datetime.ts` `http_get.ts` `iterate.ts` `load-all.ts` `memory_store.ts` `recall.ts` `web_search.ts` `tools/search/*` | calculator.test.ts http_get.test.ts iterate.test.ts search-backends.test.ts web_search.test.ts | ~80 | ✅ |
| Schema | `schema.ts` | schema.test.ts | ~20 | ✅ |
| LLM | `llm.ts` | llm.test.ts | ~20 | ✅ |
| 基础设施 | `env.ts` `dashboard.ts` `prompt-store.ts` `concurrency.ts` `reflection.ts` | dashboard.test.ts prompt-store.test.ts | ~30 | ✅ |
| **性能基准（R6）** | **`bench.ts`** | **bench.test.ts** | **~18** | ✅ |
| **配置校验（R7）** | **`config-check.ts`** | **config-check.test.ts** | **~34** | ✅ |
| **调试工具（R8）** | **`debug.ts`** | **debug.test.ts** | **~27** | ✅ |
| CLI | `cli.ts` | （由 loop/各模块测试间接覆盖） | — | ✅ |

✅✅ = 含 R2-R5 新增的深层边界测试文件。合计 42 测试文件 / 630 用例。

### 测试覆盖矩阵（35→42 文件，按 R 轮增量）

| 轮次 | 新增测试文件 | 新增用例 | 累计用例 |
|------|-------------|----------|----------|
| R0（基线） | 35 文件 | — | 426 |
| R2 | compact-deep.test.ts | +22 | 448 |
| R3 | budget-deep.test.ts | +32 | 480 |
| R4 | checkpoint-deep.test.ts | +37 | 517 |
| R5 | streaming-deep.test.ts | +36 | 553 |
| R6 | bench.test.ts | +18 | 571 |
| R7 | config-check.test.ts | +34 | 605 |
| R8 | debug.test.ts | +27 | 632 |
| D1（深度推进） | —（基线扫描，无新增测试） | — | 632 |

### 未测/弱测清单（D1 基线扫描，2026-08）

按"纯逻辑且零独立测试文件"优先级排序，是 D2+ 补测的重点目标：

| 模块 | 源文件 | 现状 | 缺口 |
|------|--------|------|------|
| **重试/退避** | `retry.ts` (57 行) | **完全无独立测试** | `withRetry` 成功/重试/耗尽、`backoff` 指数+抖动封顶、`retryOn` 谓词、`isRetryableStatus` 429/5xx/4xx 边界 |
| **MCP 注册表** | `mcp/registry.ts` (106 行) | **完全无独立测试** | `findMcpConfig` 环境变量/默认路径回退、`loadMcpConfig` JSON 解析/缺字段/坏 JSON、Claude Desktop 格式、`loadMcpFromConfig` 空配置优雅退化 |
| **结构化错误** | `errors.ts` (16 行) | 仅 llm.test.ts 间接覆盖 | `LlmHttpError` name/status/message 字段、子类判定 |
| **MCP 客户端** | `mcp/client.ts` (243 行) | 仅 happy-path 测试 | 请求超时、未连接调用、`listResources`/`listPrompts`、子进程异常退出 pending 拒绝、二次 connect 抛错 |
| **轨迹** | `trajectory.ts` (145 行) | 8 用例覆盖核心 | sub-agent 深层嵌套、空 tool 输入、时间戳乱序 |
| **运行时** | `runtime.ts` (48 行) | 无独立测试 | 由 loop 间接覆盖，可补纯函数测试 |

**结论**：`retry.ts`、`mcp/registry.ts`、`errors.ts` 三处是纯逻辑且无独立测试，是 D2-D5 的最高优先级补测目标。

**近期路线**（PRODUCT.md）：M1 product:check 门禁 → M2 库级 API 文档 → M3 嵌入式 SDK 示例 → M4 cogent adapter → M5 发布拆包。

### 下一步扩展方向
- **真实端验收**：接真实 GLM-4 跑长任务（8h+）验证 checkpoint resume + budget 协同。
- **parseSSELine 已知行为**：当前不映射 snake_case `tool_calls`（由 llm.ts 上层适配）；可补 camelCase 转换提升鲁棒性。
- **config-check 扩展**：接入 LLM 端点连通性预检、MCP 工具加载预检。
- **bench 自动化**：把 `npm run bench` 接入 CI，生成性能回归报告（与基线对比）。

## 技术栈与架构
- **语言**：TypeScript，ESM，`"type": "module"`，Node ≥ 20.19
- **依赖**：**零运行时依赖**，devDeps 仅工具链（tsx/eslint/prettier/typescript/typescript-eslint）
- **入口**：`src/loop.ts` 的 `export async function runLoop()`（**无 index.ts**）

```
src/
├── loop.ts              # 主入口 runLoop() —— Think/Act/Observe 主循环
├── llm.ts schema.ts memory.ts types.ts env.ts errors.ts
├── compact.ts tokens.ts streaming.ts        # 上下文工程 / 流式
├── trace.ts otel.ts metrics.ts trace-store.ts trajectory.ts  # 可观测性
├── budget.ts retry.ts checkpoint.ts         # 执行安全
├── subagent.ts fanout.ts long-task.ts       # sub-agent / 长任务
├── memory-store.ts storage.ts storage-file.ts eval.ts verify.ts dashboard.ts
├── mcp/      adapter.ts client.ts protocol.ts registry.ts
└── tools/    registry.ts calculator.ts datetime.ts http_get.ts ... search/
```

## 如何运行
```bash
npm install
npm run cli                 # CLI 交互（无 key 走 StubLLM）
npm run type-check          # tsc --noEmit
npm test                    # node --test（42 个测试文件 / 630 用例）
npm run lint                # eslint
npm run config:check        # 启动期配置校验（类型/范围/互斥）
npm run bench               # 性能基准报告
npm run product:check       # 7 个产品门禁 gate（见下）
```

`product:check` 的 7 个 gate（`scripts/product-check.mjs`）：`agent-loop-core` / `context-streaming-trace` / `execution-safety` / `subagents-and-long-tasks` / `memory-trajectory-eval` / `tool-and-mcp-surface` / `operator-surface`。

> 注意：只有 `product:check`，**无** `product:demo` 脚本。

## 关键约定
- **零运行时依赖**是硬约束——新功能优先用原生实现，不轻易引入依赖。
- 每个源文件配对测试（test/*.test.ts）。
- 严格 TypeScript（`noUnusedLocals` 等）。
- LLM 接入走 OpenAI-compatible；StubLLM 保证离线可测。

## 与其他项目的关系
- 与 `agentresearch` 理念同源（最小 ReAct 循环），但 agentloop 是工程化基座，agentresearch 是教学/研究形态。
- PRODUCT.md 提及为 `cogent`（声明式编排框架）提供 adapter 的目标，但 cogent 不在本工作区。
