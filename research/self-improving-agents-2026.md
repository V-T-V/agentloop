# 自我改进 Agent 架构研究（2026 最新）

> 研究日期：2026-07-16
> 来源：[Medium: Architecture Behind Self-Improving Agents](https://medium.com/@rselvaguru/the-architecture-behind-self-improving-ai-agents-full-implementation-guide-dfb0ce67c7c7) + [BuildMVPFast: Reflection Loops for Accuracy](https://www.buildmvpfast.com/blog/ai-agent-self-improvement-recursive-accuracy-production-2026) + [Tecadrise: Agentic Loops 2026](https://tecadrise.ai/blog/agentic-loops-autonomous-ai-agents-2026)

---

## 一、三大自我改进模式

### 1. Reflection Loop（反思循环）—— +34.2% 准确率

来源：BuildMVPFast 2026 生产级实践。

**结构**：`generate(答案) → critic(批评) → revise(修订) → 验证`

```
Worker 产出 answer_v1
  ↓
Critic LLM 调用（独立 prompt，批评视角）：
  输出 { issues: [...], severity: high/med/low, suggested_fix: "..." }
  ↓
Revise LLM 调用：输入 {original_answer, critique} → answer_v2
  ↓
answer_v2 进入 verify/judge 门控
```

**关键区别于 Ralph Loop 的重试**：
- Ralph Loop 重试 = 全新 context 重跑（昂贵、不精确）
- Reflection Loop = 原地批评+修订（2 次 LLM 调用，精确修正已知问题）

**终止条件**：最多修订 2-3 次，或 critic 给出 severity=low。

**失败模式**：critic 本身有偏差时会放大错误（递归放大偏见）。

### 2. Memory Graph（记忆图谱）—— 跨任务学习

来源：Medium 自我改进 Agent 架构。

**结构**：节点 = 事实/技能/观察；边 = 关系（caused_by, contradicts, refines, learned_from）

```
节点：{ id, type, content, confidence, source, taskId, timestamp }
边：  { from, to, relation }
```

**核心：反思写入记忆**
- 任务完成后，reflection pass 提取可泛化的经验
- 写入记忆图谱，带 confidence
- 下次任务开始时，查询相关记忆注入 context

**与我们的 MemoryStore 的差距**：我们有 TF 向量检索，但无图谱结构、无 confidence、无反思写入。

### 3. Meta-Prompting（提示词自进化）—— 进化式优化

来源：BuildMVPFast。

**结构**：版本化 prompt 存储 + 选择压力

```
prompt-store: {
  worker: [
    { version: 1, text: "...", evalScore: 72, parentVersion: null },
    { version: 2, text: "...", evalScore: 81, parentVersion: 1 },
    { version: 3, text: "...", evalScore: 68, parentVersion: 2 }, // 回退
  ]
}
```

**流程**：
1. 跑一批任务，收集 verify passRate + judge score
2. meta-optimizer LLM 调用：输入 {current_prompt, outcomes} → 提议 prompt delta
3. 新版本跑评测，保留 top-K，回退退步版本

**我们的差距**：system prompt 是代码里的静态字符串，从不根据性能反馈修改。

---

## 二、对照本项目（agentloop）的差距分析

| 模式 | 当前状态 | 缺失 | 优先级 |
|------|---------|------|--------|
| **Reflection Loop** | 有重试（全新 context），无批评-修订 | 在 Worker 内加 critic→revise 子循环 | **P0（最高 ROI）** |
| **Memory Graph** | 有 MemoryStore（TF 向量），无图谱/confidence/反思 | 加 confidence + 反思写入 + 跨任务检索 | P1 |
| **Meta-Prompting** | prompt 是静态字符串 | 版本化 prompt 存储 + 选择优化 | P2 |

### 为什么 Reflection Loop 是 P0

1. **ROI 最高**：BuildMVPFast 报告 +34.2% 准确率，只需每子任务加 2 次 LLM 调用
2. **与现有架构完美契合**：在 `verifySubtaskResult` 前插入 critic→revise，复用已有 LLM
3. **解决实际问题**：之前测试中 Python/Go/TS/Swift 简介太短被拒，Reflection Loop 能在验证前自修正
4. **比重试更高效**：重试是"从零再来"（~8 步），反思是"针对性修改"（2 步）

---

## 三、实施路线

### Phase 1: Reflection Loop（本轮实现）
- 新建 `src/reflection.ts`：`critique(llm, answer, context) → Critique` + `revise(llm, answer, critique) → answer_v2`
- 集成到 `ralph-loop.ts`：Worker 产出后、verify 前插入 critic→revise
- 配置：`RalphTaskSpec.reflection?: { enabled: boolean; maxRevisions: number }`

### Phase 2: Memory Graph（后续）
- 扩展 `memory-store.ts`：加 confidence + edges + reflection 写入
- Worker 启动时检索相关记忆注入 context

### Phase 3: Meta-Prompting（后续）
- 新建 `src/prompt-store.ts`：版本化存储 + 选择优化
- ralph-loop 读动态 prompt 而非硬编码

---

*本文档归档最新研究成果。Phase 1 (Reflection Loop) 将立即实现并验证。*
