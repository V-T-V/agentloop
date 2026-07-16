# agentloop · AGENTS.md

## 项目内容（What）
聚焦 **Agent 主循环**的可嵌入执行内核。它只负责把 LLM ↔ 工具调用串成一个干净可靠的主循环，并集成 2026 业界公认让 Agent 长程可靠的 10+ 能力。**不做框架**，是给上层（CLI / 库 / 工作流平台 / 产品内 Agent）提供统一运行时的底座。

不做：不提供 UI、不绑定特定 LLM 厂商、不做声明式编排。

## 目标（Goal）
- 把「LLM ↔ 工具调用」的循环做到**最干净**，运行时零业务假设。
- 覆盖长程 Agent 的核心可靠性能力（见下），且每项可独立开关——关闭后优雅退化为朴素循环。
- 成功标准：无 API key 时（StubLLM）可跑通完整主循环；有 key 时可接任意 OpenAI-compatible endpoint；所有能力有测试验证。

## 当前情况（Status）
**功能完整，可作为稳定底座复用。** 47 个 TS 源文件、33 个测试文件、**零运行时依赖**。

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

**近期路线**（PRODUCT.md）：M1 product:check 门禁 → M2 库级 API 文档 → M3 嵌入式 SDK 示例 → M4 cogent adapter → M5 发布拆包。

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
npm test                    # node --test（33 个测试）
npm run lint                # eslint
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
