# agentloop · AGENTS.md

## 项目内容（What）
聚焦 **Agent 主循环**的可嵌入执行内核。它只负责把 LLM ↔ 工具调用串成一个干净可靠的主循环，并集成 2026 业界公认让 Agent 长程可靠的 10+ 能力。**不做框架**，是给上层（CLI / 库 / 工作流平台 / 产品内 Agent）提供统一运行时的底座。

不做：不提供 UI、不绑定特定 LLM 厂商、不做声明式编排。

## 目标（Goal）
- 把「LLM ↔ 工具调用」的循环做到**最干净**，运行时零业务假设。
- 覆盖长程 Agent 的核心可靠性能力（见下），且每项可独立开关——关闭后优雅退化为朴素循环。
- 成功标准：无 API key 时（StubLLM）可跑通完整主循环；有 key 时可接任意 OpenAI-compatible endpoint；所有能力有测试验证。

## 当前情况（Status）
**功能完整，可作为稳定底座复用。** **51 个 TS 源文件、42 个测试文件、630 个测试用例、零运行时依赖**。

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
