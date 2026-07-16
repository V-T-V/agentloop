# Agent Loop

> 一个聚焦于 **Agent 主循环** 的独立基座，演进到 2026 前沿形态：
> **上下文工程 + 流式 + 可观测 + OTel 导出 + 并行 Sub-agent + 持久化记忆 + 人机审批 + 轨迹追踪评估** 八大能力齐备。

`agentloop` 不做框架，只把「LLM ↔ 工具调用」的循环做到最干净，并集成 2026 业界公认让 Agent 长程可靠运行的六大能力。所有能力均可独立开关，关闭后优雅退化为朴素循环。

## 为什么是它 + 演进依据

| 能力 | 2026 共识依据 |
|---|---|
| 🔥 **上下文工程 / 自动压缩** | [Anthropic《Effective Context Engineering》](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)；Claude Code 在 ~95% 上下文时 auto-compact（[LangChain 分析](https://www.langchain.com/blog/context-engineering-for-agents)、[Anthropic Cookbook](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)）|
| 🌊 **流式输出** | SSE 逐 token 输出，降低感知延迟。GLM-4 / OpenAI 兼容 `stream:true` + `stream_options:{include_usage:true}` |
| 📡 **可观测性 (Span)** | [Braintrust 2026 Agent Observability 指南](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026)、AgentOps：把每步推理/工具调用当一等 span |
| 🔭 **OTel 导出** | [OTLP 规范](https://opentelemetry.io/docs/specs/otlp/) + [GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)：零依赖手写 OTLP/HTTP，`gen_ai.*` 属性 |
| 🐙 **并行 Sub-agent** | [Azure 架构中心](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) fan-out/fan-in；[Towards AI](https://pub.towardsai.net/multi-agent-fan-out-when-parallelism-bites-back-c42656dd4d2f) 三大陷阱防护 |
| 💾 **持久化记忆** | 存储抽象 + 文件实现，会话跨进程恢复 |
| 🔐 **人机审批 (HITL)** | [Approval Framework](https://agentic-patterns.com/patterns/human-in-loop-approval-framework/)、[HITL Escalation](https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026)：高风险工具执行前暂停、等人确认、再恢复 |
| 🎞️ **轨迹追踪与评估** | [MorphLLM](https://www.morphllm.com/ai-agent-evaluation)、[LangChain trajectory eval](https://www.langchain.com/resources/llm-evaluation-framework)、[LLM-as-judge](https://deepeval.com/blog/llm-as-a-judge)：捕获每步内容、持久化回放、多维 rubric 打分 |
| 健壮性 | 工具入参 schema 校验（失败回填友好错误，让 LLM 能修正重试）|

核心共识（[Anthropic《Building Effective Agents》](https://www.anthropic.com/research/building-effective-agents)）：**简单单线程主循环胜过复杂多 agent 编排**——「最可靠的 agent 出奇地简单」。

## 快速开始

```bash
cd agentloop
npm install

# 离线演示模式（无需 API Key，StubLLM 跑通完整回路 + 流式 + 压缩）
npm run cli -- "现在几点？"

# 交互模式（支持 /stats /trace）
npm run cli

# 关闭流式
npm run cli -- --no-stream "1+1 等于几"
```

启用真实 LLM：`cp .env.example .env`，填入 `LOOP_LLM_API_KEY`（默认走智谱 GLM）。

## 这个循环长什么样

核心在 [`src/loop.ts`](src/loop.ts) 的 `runLoop()`：

```
run（root span）
└─ for step = 1..maxSteps:
     ├─ [上下文工程] 若达双重阈值 → compact（摘要历史 + 保留 recent window）
     ├─ [Think] llm.chatStream(memory, tools)  →  assistant message + usage
     │            （最终答案逐 token 广播 stream_delta）
     ├─ [Act]   if 带 tool_calls:
     │            并发执行（每个包 tool span）→ 按序回填 role:'tool'
     │            continue
     └─ [收敛]  else: content 即最终答案 → 结束
```

每一步都通过 `onEvent` 广播（`thinking` / `stream_delta` / `tool_call` / `tool_result` / `compact` / `usage` / `final` / `max_steps` / `error`），CLI 据此实时打印，并可用 `/trace` 查看完整 span 树。

## 八大能力

### 1. 上下文工程：自动压缩（`compact.ts` + `tokens.ts`）

**双重阈值触发**（每步 LLM 调用前检查）：
```
触发 compact 当：token 占用 ≥ 85% 预算  或  消息数 ≥ 60 条
```
- 比 Claude Code 的 95% 更保守（85%），给摘要本身留空间，符合 Anthropic「在进入 rot 区之前压缩」的建议。
- 压缩时保留首条 system + 最近 N 条（recent window）不压缩，中间历史调 LLM 摘要化后重启上下文。
- Token 估算零依赖（中英文分别按 ~1.5 / ~4 字符每 token 近似），足以驱动阈值判定。

### 2. 流式输出（`streaming.ts` + `llm.ts`）

- 逐 token 通过 `onEvent(stream_delta)` 推送，CLI 实时逐字打印最终答案。
- SSE 解析：累加 `delta.content`、按 index 合并增量 `tool_calls`、末块提取 `usage`。
- 工具调用步骤的「思考内容」不流式广播，只广播最终答案，输出不混乱。
- 支持 `AbortSignal` 早停；离线模式（StubLLM）同样有逐字流式体验。

### 3. 可观测性（`trace.ts`）

- 层级化 span 树：`run → step → {llm, tool, compact}`，每个记录 token/延迟/状态。
- `runLoop` 返回 `trace`（完整树）和 `totalUsage`（累计 token）。
- CLI `/stats` 显示步数/总 token/估算成本；`/trace` 打印 span 树。

### 4. OpenTelemetry 导出（`otel.ts`）—— 零依赖 OTLP/HTTP

- 把 span 树转成 OTLP/HTTP JSON，POST 到任意标准 Collector（Jaeger / Datadog / Honeycomb）。
- 零依赖：用原生 `fetch` 手写 OTLP 协议，不引入 `@opentelemetry/*` 依赖树。
- GenAI 语义属性：llm span 标注 `gen_ai.system` / `gen_ai.request.model` / `gen_ai.usage.*`，tool span 标注 `gen_ai.tool.name`——被业界观测平台正确识别归类。
- 配置 `LOOP_OTEL_ENDPOINT` 后 `LOOP_OTEL_EXPORT=1` 自动导出，或用 CLI `/export-trace`、`--export-trace` 手动触发。

### 5. 并行 Sub-agent 委派（`fanout.ts` + `subagent.ts`）

主 agent 可把子任务委派给独立子 agent（fan-out / fan-in 编排）：
- `delegate(task)`：跑一个独立子 runLoop（独立记忆、受控步数），结果回填。
- `delegate_parallel(tasks)`：并发扇出多个子 agent，聚合后回填——适合「同时查多源再汇总」。
- 三大陷阱防护：每个子任务独立超时（防落后者瓶颈）、错误隔离（一个失败不拖垮全局，`allSettled` 语义）、结构化聚合。
- **trace 嵌套**：子 runLoop 的 root span 自然成为父 tool span 的 child，OTel 导出后在 Jaeger 可见完整调用树。递归深度护栏（`LOOP_SUBAGENT_MAX_DEPTH`）防无限委派。

### 6. 会话持久化（`storage.ts` + `storage-file.ts`）

- 会话存为本地 JSON（`.agentloop/sessions/`），重启可恢复完整对话上下文。
- 存储抽象接口 `SessionStore` 兼容未来 SQLite / 向量库后端；当前文件实现保持零依赖。
- 原子写（先 `.tmp` 再 rename）防崩溃损坏；`list()` 对损坏文件容错跳过。
- CLI：`/sessions` 列表、`/save [标题]`、`/load <id>`、`/new`。

### 7. 人机协同审批门（HITL）

高风险工具执行前可暂停、请求人确认，被拒则跳过并回填拒绝原因——agent 接入真实世界（http_get、未来 MCP 工具）时的必需安全层。
- 工具标记 `requiresApproval: true`（如 `http_get`），执行前触发 `onApproval` 钩子。
- `runLoop` 加 `onApproval?: (req) => Promise<{approved, reason?}>`；CLI 用 readline 问 `y/n`。
- **向后兼容**：不传钩子时 `auto` 模式默认放行（行为不变）；`LOOP_HITL_MODE=strict` 时无钩子则拒绝高风险工具。
- 拒绝原因回填给 LLM，让它能据此换一种方式继续——而非硬中断。

### 8. 轨迹追踪与评估（trajectory / trace-store / eval）

把追踪从「元数据级」升级到「轨迹级」——能事后**完整回放** AI 每步做了什么，并用 **LLM-as-judge 评估打分**。

**三层**：
1. **内容捕获**（`loop.ts` 7 个点）：每步的 LLM 输入消息、输出内容/工具调用、工具入参与结果、压缩摘要、审批决策、错误信息，全部写入 span.attributes。子 agent 轨迹自动嵌套。
2. **持久化**（`trace-store.ts`）：runLoop 后把含内容的完整 trace 落盘 `.agentloop/traces/`，跨进程可回放。
3. **评估**（`eval.ts`）：LLM-as-judge 按 6 维度 rubric 打分（工具选择/参数质量/效率/错误恢复/任务完成/安全，1-5 分），输出总分+理由+改进建议。rubric 评分标准明写进 prompt 防偏差。

**CLI**：`/traces` 列历史、`/replay [id]` 逐步回放（🧠思考/🔧工具/🗜️压缩）、`/eval` 评估最近一次轨迹。

## 内置工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `datetime` | （无） | 当前日期与时间 |
| `calculator` | `expression` | 安全算术求值（手写 Shunting-Yard，绝不 `eval`） |
| `iterate` | `start,step,stopWhen` | 通用数值迭代（统一/分支步进，适合 Collatz、倍增等迭代任务） |
| `http_get` | `url` | 原生 fetch 抓取网页/JSON ⚠️需审批 |
| `delegate` | `task` | 把子任务委派给一个独立子 agent |
| `delegate_parallel` | `tasks[]` | 并行扇出多个子 agent，聚合结果 |

工具执行前会做入参 schema 校验（`schema.ts`），参数不符时回填友好错误而非抛异常。

## 用法（REPL 命令）

```
/help              查看帮助
/tools             列出可用工具
/stats             最近一次运行的 token 与耗时
/trace             最近一次运行的 span 树
/sessions          列出已保存会话
/save [标题]       保存当前会话
/load <id>         加载某个会话
/new               新建空会话
/export-trace      把最近一次 trace 导出到 OTel 端点
/traces            列出历史运行轨迹
/replay [id]       回放某次运行（含每步决策），默认最近一次
/eval              用 LLM 评估最近一次轨迹（多维打分）
/clear             清空当前会话记忆
/exit              退出（Ctrl+C / Ctrl+D）
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LOOP_LLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | OpenAI 兼容端点 |
| `LOOP_LLM_API_KEY` | （空 → StubLLM） | API Key |
| `LOOP_LLM_MODEL` | `glm-4-flash` | 模型名 |
| `LOOP_LLM_RETRIES` | `3` | 网络层重试次数（429/5xx/超时） |
| `LOOP_LLM_TIMEOUT_MS` | `30000` | 单次请求超时 |
| `LOOP_LLM_TEMPERATURE` | `0.3` | 生成温度 |
| `LOOP_MAX_STEPS` | `8` | 循环最大步数 |
| `LOOP_TOKEN_BUDGET` | `120000` | 上下文 token 预算 |
| `LOOP_COMPACT_THRESHOLD` | `0.85` | token 占比压缩阈值 |
| `LOOP_COMPACT_MAX_MESSAGES` | `60` | 消息条数压缩阈值 |
| `LOOP_COMPACT_RECENT` | `6` | 压缩时保留最近 N 条 |
| `LOOP_STREAM` | `1` | 1=流式，0=非流式 |
| `LOOP_TRACE` | `1` | 1=记录 span，0=关闭 |
| `LOOP_PRICE_INPUT_PER_1K` | `0` | 输入 token 价格（/1K，仅 /stats 展示） |
| `LOOP_PRICE_OUTPUT_PER_1K` | `0` | 输出 token 价格（/1K） |
| `LOOP_OTEL_ENDPOINT` | （空=不导出） | OTLP/HTTP 端点，如 `http://localhost:4318/v1/traces` |
| `LOOP_OTEL_SERVICE_NAME` | `agentloop` | 服务名 |
| `LOOP_OTEL_EXPORT` | `0` | 1=runLoop 结束自动导出 |
| `LOOP_SUBAGENT_MAX_STEPS` | `8` | 子 agent 最大步数（验证后从 4 调至 8，避免子任务退化） |
| `LOOP_SUBAGENT_MAX_DEPTH` | `3` | 委派递归深度上限 |
| `LOOP_SUBAGENT_TIMEOUT_MS` | `30000` | 单个子 agent 超时 |
| `LOOP_SESSION_DIR` | `.agentloop/sessions` | 会话存储目录 |
| `LOOP_HITL_MODE` | `auto` | HITL 策略：auto=无钩子放行，strict=无钩子拒绝高风险工具 |
| `LOOP_TRACE_PERSIST` | `1` | 1=runLoop 后把含内容的 trace 落盘，供 /replay /eval |
| `LOOP_TRACE_DIR` | `.agentloop/traces` | 轨迹存储目录 |
| `LOOP_EVAL_MODEL` | （空=复用主模型） | LLM-as-judge 评估用的模型 |

## 目录结构

```
src/
├── loop.ts          ⭐ 主循环 runLoop()，集成八大能力（含轨迹内容捕获）
├── compact.ts       上下文压缩（双重阈值 + LLM 摘要）
├── tokens.ts        Token 估算器
├── streaming.ts     SSE 流式聚合器
├── trace.ts         Span 可观测性（含 setAttribute 内容捕获）
├── trajectory.ts    轨迹渲染（Span→可读文本，供回放与评估）
├── trace-store.ts   轨迹持久化（文件存储）
├── eval.ts          LLM-as-judge 评估器（多维 rubric 打分）
├── otel.ts          OTLP/HTTP 导出（零依赖，gen_ai.* 语义属性）
├── fanout.ts        并行扇出编排（超时/错误隔离/聚合）
├── subagent.ts      Sub-agent 委派工具（delegate / delegate_parallel）
├── storage.ts       会话存储抽象接口
├── storage-file.ts  文件存储实现（原子写/损坏容错）
├── schema.ts        工具入参校验
├── llm.ts           OpenAI 兼容客户端 + StubLLM（流式/usage）
├── memory.ts        内存级消息缓冲 + 滑动窗口 + 序列化
├── types.ts         核心类型
├── errors.ts        结构化 LlmHttpError
├── env.ts / retry.ts  零依赖工具
├── tools/           内置工具 + registry
└── cli.ts           CLI（流式 + /stats /trace + /sessions /save /load + /traces /replay /eval + HITL）
test/                154 个测试覆盖全部模块
```

## 开发

```bash
npm test            # 全部测试（78 个）
npm run type-check  # TS 类型检查
npm run lint        # ESLint
npm run product:check # 产品化门禁
npm run format      # Prettier 格式化
```

## 设计原则

- **零运行时依赖**：原生 `fetch`、`node:` 内置模块。
- **所有能力可关闭**：环境变量 + 入参开关，关闭后退化回朴素 loop。
- **可读性优先**：每项能力集中在独立模块，loop.ts 只做编排。
- **离线可玩**：StubLLM 让流式/压缩/span 全部可在无 API Key 下演示与测试。
