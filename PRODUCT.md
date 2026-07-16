# AgentLoop 产品化执行档案

## 产品定位

可嵌入的 Agent 执行内核。它只负责把 LLM、工具、记忆、轨迹、预算、审批和观测串成一个可靠主循环，为上层框架、CLI、工作流平台或产品内 Agent 提供统一运行时。

## 目标用户

- 需要在产品中嵌入工具调用 Agent 的工程团队。
- 需要可观测、可回放、可评估 Agent 轨迹的平台团队。
- 需要把单 Agent 扩展到 sub-agent fan-out / long-task 的研发团队。
- 上层声明式编排框架，例如 `cogent`。

## 最小产品闭环

1. 用户通过 CLI 或库调用提交任务。
2. `runLoop()` 调用 LLM，按 schema 执行工具，并把结果回填。
3. 过程产生 span、usage、metrics、trajectory。
4. 需要时压缩上下文、持久化会话、checkpoint 长任务。
5. 结束后可 replay / eval / export trace。

## 当前优势

- 主循环简单清晰，运行时零业务假设，适合作为底座复用。
- 已覆盖上下文压缩、流式、OTel、sub-agent、存储、HITL、trajectory eval、budget、checkpoint、MCP、搜索等关键能力。
- StubLLM 支持离线演示和测试，降低集成门槛。
- 测试覆盖面广，适合继续沉淀为稳定包。

## 近期路线

- M1：固定 `product:check`，把执行内核能力作为可回归的产品门禁。
- M2：整理库级 API 文档，给 `runLoop()`、工具注册、trace store、eval 提供最小集成示例。
- M3：补一个“嵌入式 SDK 示例”：外部业务传工具 + 审批钩子 + trace 导出。
- M4：为 `cogent` 提供稳定 adapter，减少相对路径耦合。
- M5：准备发布形态，拆分 runtime/core 与 CLI 包。

## 产品门禁

- `npm run product:check`：检查执行内核、上下文/流式/观测、安全、长任务、记忆/轨迹/评估、工具/MCP 和文档是否齐备。
- `npm run type-check`：TypeScript 类型检查。
- `npm test`：全部单元测试。
- `npm run lint`：代码风格和静态规则。

## 产品化验收

- 无 API Key 时离线 StubLLM 可跑通完整主循环。
- 有 API Key 时可接 OpenAI-compatible endpoint。
- 工具调用、压缩、轨迹、评估、checkpoint 都能被测试验证。
- `npm run product:check`、`npm run type-check`、`npm test`、`npm run lint` 通过。
