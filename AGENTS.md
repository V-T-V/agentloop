# agentloop · AGENTS.md

## 项目内容（What）
聚焦 **Agent 主循环**的可嵌入执行内核。它只负责把 LLM ↔ 工具调用串成一个干净可靠的主循环，并集成 2026 业界公认让 Agent 长程可靠的 10+ 能力。**不做框架**，是给上层（CLI / 库 / 工作流平台 / 产品内 Agent）提供统一运行时的底座。

不做：不提供 UI、不绑定特定 LLM 厂商、不做声明式编排。

## 目标（Goal）
- 把「LLM ↔ 工具调用」的循环做到**最干净**，运行时零业务假设。
- 覆盖长程 Agent 的核心可靠性能力（见下），且每项可独立开关——关闭后优雅退化为朴素循环。
- 成功标准：无 API key 时（StubLLM）可跑通完整主循环；有 key 时可接任意 OpenAI-compatible endpoint；所有能力有测试验证。

## 当前情况（Status）
**功能完整，可作为稳定底座复用。** **107 个 TS 源文件、59 个测试文件、938 个测试用例、零运行时依赖**。

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

### 第五轮深化成果（R5-D1 ~ R5-D8 完成，2026-08-06）

**测试规模**：716 → **845 用例** / 47 → **51 测试文件**（+129 用例 / +4 文件），全绿且全量并发跑稳定。

| 轮次 | 内容 | 关键交付 |
|------|------|----------|
| **D1** | 基线扫描 + 缺口定位 | 确认 flaky retry/iterative；列出 protocol/adapter/storage-file/runtime 零配对测试缺口 |
| **D2** | 修复两处 flaky | retry 上界 400→5000ms（保留封顶判别力）；iterative 用 `quiet()` 静默 long-task 的 55 处 console 输出，缩小 IPC payload 根除 `Unable to deserialize cloned data` |
| **D3** | storage-file.ts +27 | 消除 130 行零测试：原子写/坏 JSON/schema 不符/list 容错排序/delete 幂等/newSessionId 唯一排序/makeSession 标题推导/并发 save |
| **D4** | mcp/adapter.ts +27 | 消除 133 行零测试：stub McpStdioClient 原型不 spawn 子进程，测 name/desc/schema 映射、toolPrefix、content 渲染（text/image/resource）、isError、抛错捕获、loadMcpServers 批量+单失败不阻塞 |
| **D5** | concurrency-deep +20 | 信号量不变量：release 幂等/FIFO 公平/许可传递/峰值<=capacity/withConcurrency 抛错仍释放/全局信号量单例与 reset |
| **D6** | **修 Number(env)‖d 吞 0 bug** | 新增 `envNumber`/`envInt`（src/env.ts）：正确保留合法 0、拒绝 NaN/Infinity、min/max 钳制；迁移 compact/subagent。`LOOP_COMPACT_THRESHOLD=0` 等此前静默回退默认的配置现可生效 |
| **D7** | bug 修复推广 | 迁移 budget/llm/concurrency：temperature=0(确定性)/retries=0(不重试)/warningThreshold 钳制[0,1]/并发数 min=1，全代码库 `Number(env)‖d` 模式清零（cli 价格除外，本就默认 0） |
| **D8** | trace-store-deep +25 | 覆盖此前零测试的 prune 淘汰（maxAgeMs/maxCount/同时/清 tmp/清损坏文件/目录不存在）+ load/list 错误路径 + answer/userQuestion 截断 |

**净增能力**：`envNumber`/`envInt` 是新的公共配置解析 API（导出自 `src/env.ts`），上层模块可统一用它读数值配置，杜绝 0 被吞的整类 bug。

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

✅✅ = 含 R2-R5 新增的深层边界测试文件。合计 59 测试文件 / 938 用例。

### 测试覆盖矩阵（35→59 文件，按 R 轮增量）

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
| 深度 r1-r8 | retry/mcp-registry/errors/mcp-deep/env 等 | +86 | 718 |
| **R5-D2** | （修 flaky，无新增） | — | 718 |
| **R5-D3** | storage-file.test.ts | +27 | 745 |
| **R5-D4** | mcp-adapter.test.ts | +27 | 772 |
| **R5-D5** | concurrency-deep.test.ts | +20 | 792 |
| **R5-D6** | env.test.ts / compact.test.ts 扩展 | +24 | 816 |
| **R5-D7** | budget-deep.test.ts 扩展 | +4 | 820 |
| **R5-D8** | trace-store-deep.test.ts | +25 | 845 |
| **R10-D2** | fanout-deep.test.ts | +14 | 859 |
| **R10-D3** | dashboard-deep.test.ts（+ 重构 handleDashboardRequest） | +10 | 869 |
| **R10-D4** | memory-store-deep.test.ts | +20 | 889 |
| **R10-D5** | otel-deep.test.ts（+ 根除并发 flaky） | +24 | 913 |
| **R10-D6** | subagent-deep.test.ts（修 Number(env)‖d 吞 0 bug） | +7 | 921 |
| **R10-D7** | llm-deep.test.ts（修 toUsage truthy 吞 0 bug） | +7 | 928 |
| **R10-D8** | tools-registry-load-all.test.ts | +10 | 938 |

### R10 完成表（845 → 938 用例，+93）

| 日 | 主题 | 成果 |
|----|------|------|
| **D1** | 基线扫描 + 缺口定位 | 845/845 绿；列出 dashboard/fanout/memory-store/otel/multimodal 覆盖率缺口（multimodal 已饱和） |
| **D2** | fanout 深层 | +14：maxConcurrency 信号量节流 / AbortSignal 同步 abort / timeoutMs=0 / 非 Error 抛错 String(e) / 默认 options / summary 标记 / stress / 泛型 TInput |
| **D3** | dashboard 深层 + 重构 | +10：抽出纯函数 handleDashboardRequest（路由与服务器解耦，确定性单测）+ startDashboard 返回 http.Server（向后兼容）；HTTP 端点 / 环形缓冲裁剪 / usage 三项累加 |
| **D4** | memory-store 深层 | +20：addTyped / searchRelevant minConfidence / updateConfidence clamp[0,1] / getLessons / 持久化往返保真 / 损坏文件(非数组/错误 schema/坏 JSON)恢复 / 停用词 / 余弦相似度边界 |
| **D5** | otel 深层 + 根除 flaky | +24：toAnyValue 全类型映射 / 未结束 span / 4 层嵌套 flatten / llm 无 usage / tool 无 tool 属性 / spanId 确定性+唯一性 / kind 映射 / exportTrace 错误路径；彻底根除 dashboard 真实 server 冒烟的并发 deserialize flaky |
| **D6** | **修 bug** subagent.ts | 修 `Number(env('LOOP_SUBAGENT_TIMEOUT_MS','30000'))‖30000` 吞掉合法 0（=不超时）的 bug；抽出可测函数 resolveSubAgentFanoutOptions（envInt 正确保留 0）；+7 回归 |
| **D7** | **修 bug** llm.ts | 修 toUsage 用 `raw.prompt_tokens ‖ raw.completion_tokens` truthy 判定吞掉合法 0（服务端明确返回 0 token 被误判走估算）的 bug；改 typeof==='number' 判定（含 0/含 total_tokens）；+7 回归 |
| **D8** | 错误路径 tools/ | +10：registry.ts（defineTool/builtinTools/findTool）+ load-all.ts（loadAllTools 无配置返纯内置 / registerCleanup 恰好 +1 exit 监听 / cleanup 幂等）—— 此前两模块无独立测试 |
| **D9** | 文档同步 | 本表 + 矩阵更新 |
| **D10** | 全量回归 + 推送 | 938/938 绿 + tsc/lint 通过 + push origin main |

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

**结论**：`retry.ts`、`mcp/registry.ts`、`errors.ts` 三处在深度 r2-r4 已补独立测试；R5 进一步补齐 `storage-file.ts`、`mcp/adapter.ts`、`concurrency.ts`、`trace-store.ts` 的深层路径。当前剩余纯逻辑零独立测试的源文件已基本清零（`runtime.ts` 是集成胶水代码，由 loop 测试间接覆盖；`mcp/protocol.ts` 全为类型定义，仅 `MCP_ERROR_CODES` 一个常量）。

### R10-D1 基线扫描（2026-08-06，845/845 绿）

第十轮起点。基线 `npm test`：845 通过、0 失败、54s。重扫「已配对测试但覆盖率仍偏弱」的源文件（即非零测试，但远未触达核心错误/边界路径）：

| 模块 | 源行数 | 现有用例 | 已测路径 | R10 重点缺口（D2-D5） |
|------|--------|----------|----------|----------------------|
| **dashboard.ts** | 172 | 8 | pushEvent 累加（thinking/tool_call/tool_result/usage/error/compact/final/stream_delta）、getStats 差值 | **HTTP 端点 `/` 与 `/api/events` 未测**（startDashboard 完全未触达）；**环形缓冲裁剪**（>500 条 shift）未测；usage 三项分别累加（仅 totalTokens）；final/tool_call 在 summary 模板的渲染分支 |
| **fanout.ts** | 137 | 6 | 并发、超时、部分失败、全成功 summary、空列表、durationMs | **maxConcurrency 信号量节流**（SerialSemaphore 串行化、防止并发突破上限）；**AbortSignal 传递**（超时后 signal.aborted=true 传给 runner）；**timeoutMs=0 表示不限**；**非 Error 对象抛错**（`e instanceof Error ? e.message : String(e)`）；allSettled 永远 fulfilled 兜底；summary ❌ 分支 |
| **memory-store.ts** | 235 | 13 | 未知（待 D4 详查） | 错误路径：空文件、坏 JSON、超容量 prune、score 排序、向量维度不匹配；delete/has/get/list 等方法 |
| **otel.ts** | 204 | 11 | 未知（待 D5 详查） | **toOTLP 结构转换**、**exportTrace HTTP POST 失败/超时/非 2xx**、payload serviceName/attributes 字段、嵌套 span |
| **multimodal.ts** | 51 | 15 | 全部 5 个 export 都有测试（覆盖良好） | 仅 51 行已基本全覆盖——R10 不再扩，作为「已饱和」对照 |

**结论**：multimodal.ts 已饱和（51 行 / 15 用例），其余 4 模块均有明显深层缺口。R10-D2~D5 按上表补 fanout → dashboard → memory-store → otel 的深层测试；D6-D7 加新能力/修 bug；D8 错误路径加固；D9 文档；D10 回归推送。

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
npm test                    # node --test（59 个测试文件 / 938 用例）
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
