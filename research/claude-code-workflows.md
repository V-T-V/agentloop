# Claude Code Dynamic Workflows 研究

> 研究日期：2026-07-09
> 来源：[官方文档](https://code.claude.com/docs/en/workflows) + [Ken Huang 分析](https://kenhuangus.substack.com/p/claude-code-orchestration-dynamic) + [DevOps.com](https://devops.com/claude-codes-dynamic-workflows-take-on-the-tasks-that-were-too-big-to-automate/)

---

## 一、核心设计：Agent 自己写编排脚本

Claude Code Dynamic Workflows 最本质的创新是：**不是用户手写工作流定义，而是 Claude 自己读任务后生成一个编排脚本**。

```
用户: "审查整个代码库的安全问题"

Claude 的思考:
  1. 这个任务需要检查 50 个目录
  2. 每个目录独立审查（可并行）
  3. 最后汇总

Claude 的行动:
  → 写一个 shell 脚本，用 claude -p 并行调用 50 个子 agent
  → 每个子 agent 审查一个目录
  → 脚本收集结果后，Claude 再读汇总做最终报告
```

**关键区别于传统工作流引擎**（Airflow/Temporal/cogent）：
- 传统：用户预定义 DAG/步骤 → 引擎执行
- Claude Code：**Agent 自己决定编排策略 → 生成脚本 → 执行脚本**

这意味着编排本身就是 agent 的一个 tool——agent 可以根据任务特点选择最优的并行/串行/动态策略。

---

## 二、三种编排模式

### 1. Map（扇出 / Fan-out）
```
任务: "审查 50 个文件"
        ┌─ claude -p "审查 file1" → result1
        ├─ claude -p "审查 file2" → result2
Main ───┤  ...
        └─ claude -p "审查 file50" → result50
        ↓
     汇总所有 result
```
- N 个独立子任务并行执行
- 每个 `claude -p` 是一个全新 context 的子 agent
- 适合：批量同类操作（审查、迁移、文档生成）

### 2. Pipeline（管道 / 串行）
```
Main → claude -p "阶段1: 分析" → output1
     → claude -p "阶段2: 基于output1设计" → output2
     → claude -p "阶段3: 基于output2实现" → output3
```
- 前阶段输出作为后阶段输入
- 每阶段独立 context（只看输入文本，不看前阶段对话历史）
- 适合：多步骤加工（分析→设计→实现→测试）

### 3. Dynamic Dispatch（动态分发）
```
Main → 分析任务 → 决定拆分策略
     → 根据中间结果动态调整后续步骤
     → 可能并行、可能串行、可能增减子任务
```
- 运行时根据结果决定下一步
- 最灵活但也最复杂
- 适合：探索性任务（先侦察再决定怎么拆）

---

## 三、技术实现细节

### `claude -p`（Print Mode）
```bash
# 非交互模式：给指令，出结果，退出
claude -p "审查 src/auth.ts 的安全问题"
```
- 每次调用是独立进程，独立 context
- 支持 `--output-format json` 返回结构化结果
- 支持 `--model` 指定不同模型（子 agent 用便宜模型）

### 脚本即 Artifact
```
claude 生成的脚本保存为 .claude/workflows/audit-2026-07-09.sh
→ 可审查（用户确认编排策略合理）
→ 可重跑（参数调整后重跑同一策略）
→ 可复用（类似任务套用同样模式）
```

### Context 隔离原则
- **主 agent**：看全局，决定编排策略，读汇总结果
- **子 agent**：只看自己的任务描述 + 必要上下文（通过命令行参数传入）
- **通信方式**：文本（stdin/stdout），不是共享内存

这与我们的 Ralph Loop **完全一致**——文件系统即状态，每次迭代全新 context。

---

## 四、与本项目（agentloop + Ralph Loop）的对照

| 维度 | Claude Code Workflows | 我们的 Ralph Loop | Gap |
|------|----------------------|-------------------|-----|
| 编排决策 | **Agent 自己写脚本** | 用户预定义 JSON | **核心差距** |
| 子 agent 调用 | `claude -p`（CLI fork） | 内嵌 runLoop | 不同实现，同等效果 |
| Context 隔离 | 每子 agent 全新进程 | 每次 runLoop 全新 memory | ✅ 一致 |
| 状态管理 | 脚本 + 文件 | todo.md + results/ | ✅ 一致 |
| 并行执行 | 脚本内 fork/wait | 串行（待改进） | **待补** |
| 可重跑 | 脚本是 artifact | JSON 是 artifact | ✅ 类似 |
| 崩溃恢复 | 重跑脚本 | 读 todo.md | ✅ 一致 |
| 动态调整 | 脚本可含条件分支 | 固定子任务列表 | **待补** |

### 关键差距

1. **编排决策权**：Claude Code 让 agent 自己决定"怎么编排"（生成脚本），我们的 Ralph Loop 是用户预定义。这是最大的设计差距——**agent 应该能自己决定并行度、执行顺序、是否需要再拆子任务**。

2. **并行执行**：Claude Code 的脚本可以 `wait < <(claude -p ...)` 并行 fork。我们的 Ralph Loop 是串行循环，浪费了时间。

3. **动态分发**：Claude Code 的脚本可以 `if [ condition ]; then ...` 动态调整。我们的 todo.md 是 Planner 一次写死的。

---

## 五、对我们项目的演进启示

### 演进方向：让 Ralph Loop 的 Planner 生成编排策略

当前 Ralph Loop：
```
Planner → 写 todo.md（固定子任务列表）→ Worker 串行循环
```

演进后（Claude Code 式）：
```
Orchestrator Agent → 分析任务 → 生成编排计划（含并行/串行/依赖）
→ 执行计划（并行 fork Worker runLoop）
→ 汇总
```

具体实现：
1. Planner 不只输出子任务列表，还输出**执行计划**（哪些并行、哪些串行、依赖关系）
2. Worker 循环支持**并行批次**（同一批次的子任务用 Promise.allSettled 并行）
3. 支持**动态追加**（Worker 发现需要更多子任务时，追加到 todo.md）

这是把 Ralph Loop 从"固定串行循环"升级到"自适应编排引擎"的路径。

---

## 六、参考来源

- [官方文档：Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Ken Huang：Claude Code Orchestration: Dynamic Workflows](https://kenhuangus.substack.com/p/claude-code-orchestration-dynamic)
- [DevOps.com：Dynamic Workflows Take on Tasks Too Big to Automate](https://devops.com/claude-codes-dynamic-workflows-take-on-the-tasks-that-were-too-big-to-automate/)
- [MindStudio：Claude Code Sub-Agents Explained](https://www.mindstudio.ai/blog/claude-code-sub-agents-explained)
- [Anthropic：Building Effective Agents（五种工作流模式）](https://www.anthropic.com/engineering/building-effective-agents)

---

*本文档为研究归档。对应实现见 `src/ralph-loop.ts` 及后续编排引擎演进。*
