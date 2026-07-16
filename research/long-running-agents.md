# 长程 Agent 工程研究归档

> 研究主题：如何让 AI Agent 持续运行 8 小时以上不中断。
> 归档日期：2026-07-01
> 研究方法：网络检索 + 关键文献精读 + 现有项目能力盘点 + 落地设计。

---

## 一、问题陈述

当前 `agentloop` 的 `runLoop()` 是**单进程、内存态、有界步数**的循环：

- `maxSteps` 默认 8（可通过 `LOOP_MAX_STEPS` 调大，但无上界保护）。
- `Memory` 是内存对象，进程崩溃即全部丢失。
- 已有 `FileSessionStore`，但它是「整段会话存取」，**没有逐步 checkpoint**——崩溃后只能从会话起点重跑。
- 已有 `compact.ts` 上下文压缩，可延缓上下文爆炸，但不能解决「进程死亡后状态丢失」。

**8 小时长任务的核心挑战不是「跑得久」，而是「崩了能续」。** 一次 LLM 调用超时、一次工具网络抖动、一次 OOM、一次机器重启，都会让数小时进度归零。

---

## 二、业界方案综述（按成熟度排序）

### 2.1 Durable Execution（持久化执行）—— 最成熟

**核心思想**：把执行过程看作「事件流」，每一步的输入/输出都持久化；崩溃后通过**重放（replay）**重建内存状态，从断点继续。

#### 代表系统

| 系统 | 模式 | 关键机制 |
|------|------|----------|
| **Temporal** | 事件溯源 + 重放 | Workflow 代码确定性重放；`Continue-As-New` 重启历史防事件表无限增长；`Signal`/`Query` 实现外部交互；Timer 实现长等待 |
| **Restate** | 日志即状态（journaling） | 每个 invocation 是一条有序日志，重放即恢复；内置 Kafka-like 持久化 |
| **DBOS** | 数据库即运行时 | 把 step 状态直接写进 Postgres，事务级一致性 |
| **Diagrid** | 编排层 durable | 强调「checkpoint 不等于 durable execution」——还需自动故障检测 + 编排重启 |

#### Temporal 三大长程模式（最值得借鉴）

1. **Continue-As-New**：Workflow 执行到一定时间/事件数后，主动关闭当前执行，以「全新的起点 + 携带的上下文」启动新执行。**这正是 Agent 上下文压缩的工程化形态**——防止事件历史无限膨胀导致重放越来越慢。

2. **Event Sourcing / Replay**：不保存「当前状态」，而保存「导致状态变化的事件序列」。恢复时从头重放事件重建状态。对 Agent 而言：保存每步的 LLM 响应、工具调用、工具结果；恢复时把这些「决定点」依次喂回。

3. **Interrupt / Resume（HITL 暂停）**：Workflow 执行到需要人审批处，阻塞等待外部 Signal；人批准后发 Signal，Workflow 从阻塞点继续。**Agent 的 HITL 审批门天然适配这个模型。**

> **Diagrid 的关键批评**（重要洞察）：仅仅「写 checkpoint 文件」不构成 durable execution。真正的 durable execution 必须包含：
> - **自动故障检测**（进程死了谁发现？）
> - **编排重启**（谁负责重新拉起？从哪里恢复？）
> - **幂等性保证**（重放时工具副作用怎么处理？）
>
> 这三个要求直接决定了本项目的实现范围（见第五节）。

### 2.2 Checkpoint-and-Resume（检查点恢复）—— 实用主义

**核心思想**：在「安全点」（step 边界）把当前完整状态快照落盘；崩溃后加载最近快照，从下一个 step 继续。比事件溯源简单（不重放，直接还原），但快照更大。

#### 关键实践（Addy Osmani《Long-running Agents》+ ZenML）

- **检查点边界 = step 边界**：每次 Think→Act→Observe 完成一个完整循环后，是天然的「一致状态点」——此时 memory 是自洽的（所有 tool 结果已回填）。
- **原子写**：先写临时文件，再 `rename`（POSIX 原子）。Windows 上 `rename` 同盘也是原子的。**绝不能直接覆盖写正在用的文件**——写到一半崩溃会损坏状态。
- **保留多代**：不只存最新 checkpoint，还存前 1-2 代，防「最新 checkpoint 恰好损坏」。
- **快照内容 = memory + step 计数 + 累计 usage + 随机种子**（若涉及随机）。

### 2.3 Context Folding（上下文折叠）—— 前沿研究

**来源**：OpenReview 2025/2026 论文 + Anthropic《Effective Context Engineering》。

**核心思想**：长程任务的瓶颈不是「执行时长」而是「上下文窗口」。Agent 必须**主动管理**自己的工作记忆，而非被动等窗口爆满才压缩。

#### 折叠 vs 压缩的区别

| 维度 | auto-compact（当前项目） | Context Folding |
|------|--------------------------|------------------|
| 触发 | 被动（达阈值） | 主动（任务驱动） |
| 粒度 | 整体摘要 | 分层：保留「任务骨架」+「当前焦点」+「可召回的冷档案」 |
| 结构 | 平铺历史 → 摘要 | 树/图结构，可按需展开子任务上下文 |

**对本项目的启示**：`compact.ts` 已实现被动压缩。Folding 的进阶在于——结合 **subagent 任务分解**（已有 `subagent.ts`），让每个子任务有独立的小上下文，主循环只持有子任务的「结论」而非全过程。这天然实现了「上下文隔离 + 折叠」。

### 2.4 任务分解（Task Decomposition）—— 工程现实

**核心思想**：8 小时任务不可能是一个 57600 步的线性循环（按 8h / 0.5s per step 估算）。必须把大任务拆成**阶段**，每阶段是一个可独立 checkpoint、可独立恢复的子运行。

#### 模式：Map-Reduce / Pipeline / Fan-out

- **Pipeline**：阶段 1 → 阶段 2 → ... 每阶段产出落盘，下一阶段从磁盘读。
- **Fan-out**：一个大任务拆成 N 个子任务，并行/串行跑，结果汇总。
- **Recursive**：子任务再拆子任务（subagent 的递归 delegate）。

**对本项目**：`cogent/workflow.ts` 已有 sequential/parallel/conditional 编排。`agentloop/subagent.ts` 已有 delegate/delegate_parallel。**长任务 = workflow 串起多个 agentloop run，每个 run 自带 checkpoint。**

---

## 三、关键文献清单

| # | 来源 | 核心贡献 | 链接 |
|---|------|----------|------|
| 1 | Addy Osmani《Long-running Agents》(2025) | checkpoint-and-resume 工程化清单、故障模式分类 | https://addyo.substack.com/p/long-running-agents |
| 2 | Temporal 文档 - Continue-As-New | 防事件表无限增长的标准模式 | https://docs.temporal.io/continue-as-new |
| 3 | Diagrid《Checkpoints Are Not Durable Execution》 | 批判：仅 checkpoint 不够，需编排重启+幂等 | https://diagrid.io/blog/checkpoints-vs-durable-execution |
| 4 | Anthropic《Effective Context Engineering》 | context rot、主动上下文管理、subagent 隔离 | https://anthropic.com/news/context-engineering |
| 5 | OpenReview Context Folding 论文 | 分层工作记忆 vs 平铺摘要 | https://openreview.net (检索 "context folding agent") |
| 6 | ZenML Checkpointing 文档 | step 边界快照的工程实现 | https://docs.zenml.io/ (checkpointing) |
| 7 | Restate / DBOS durable runtime | journaling / DB-as-runtime 范式 | https://restate.dev / https://dbos-project.org |

---

## 四、agentloop 现状盘点（Gap Analysis）

| 能力 | 现状 | 8h 长任务要求 | Gap |
|------|------|---------------|-----|
| 上下文压缩 | ✅ `compact.ts` 双重阈值 | ✅ 已满足 | 无（可优化阈值） |
| 消息序列化 | ✅ `Memory.serializeMessages/fromMessages` | ✅ 已满足 | 无 |
| 会话持久化 | ⚠️ `FileSessionStore` 整段存取 | 需逐步 checkpoint | **缺 checkpoint** |
| 原子写 | ✅ tmp+rename | ✅ 已满足 | 无 |
| 步数上限 | ⚠️ 默认 8，可调但无保护 | 需大上限 + 可恢复 | **缺 resume** |
| 崩溃恢复 | ❌ 无 | 核心需求 | **缺 resume** |
| 任务分解 | ✅ subagent + workflow | ✅ 已满足 | 无 |
| 可观测性 | ✅ span 树 + OTLP | ✅ 已满足 | 无 |
| 幂等性 | ❌ 工具有副作用 | 长程需考虑 | 后续优化 |

**结论：唯一关键 Gap 是「checkpoint-and-resume」。** 上下文压缩、序列化、原子写、任务分解的基础设施都已就位，只差把「逐步落盘 + 崩溃续跑」这条主线打通。

---

## 五、落地设计：Durable Loop

### 5.1 设计目标

1. **进程崩溃后可恢复**：从最近 checkpoint 续跑，不丢已完成的 step。
2. **对现有 runLoop 最小侵入**：新增 `checkpoint.ts` 模块 + runLoop 增加可选 `durable` 配置。
3. **零依赖**：复用 `node:fs/promises`，沿用项目既有风格。
4. **向后兼容**：不传 `durable` 配置时，行为与现在完全一致。

### 5.2 数据模型：Checkpoint

```typescript
interface Checkpoint {
  __schema: 'agentloop-checkpoint';
  version: number;
  /** 本次运行的唯一 id（同一任务多次恢复共享同一 id） */
  runId: string;
  /** 已完成的最后一个 step 编号（恢复时从 nextStep = step + 1 开始） */
  step: number;
  /** 序列化的完整 memory（含 system + 全部消息） */
  messages: Message[];
  /** 累计 token 用量 */
  totalUsage: TokenUsage;
  /** 停止原因（恢复时用于判断是否已完成） */
  stopReason?: RunLoopOutput['stopReason'];
  /** 最终答案（若已收敛） */
  answer?: string;
  /** 检查点写入时间（ISO） */
  savedAt: string;
}
```

### 5.3 写入策略：Step 边界原子落盘

在 `runLoop` 的 for 循环**每个 step 末尾**（无论是「工具调用完成 continue」还是「收敛 break」之后）写入 checkpoint：

```
for step in 1..maxSteps:
    [Think] LLM 调用
    [Act/Observe] 工具执行 → 回填
    >>> 🔒 CHECKPOINT(memory, step, usage) <<<   // 新增：每步落盘
    if 收敛: break
```

**为什么落在 step 末尾而非 LLM 调用前？**
- step 末尾的 memory 是**自洽的**（所有 tool result 已回填，无悬空 tool_call）。
- LLM 调用前的 memory 可能有「未回填的 assistant tool_calls」，恢复时会让 LLM 困惑。
- step 末尾 = 「一个完整思维周期的结束」，是最安全的快照点。

### 5.4 恢复策略：Resume

```typescript
// 启动时检查是否有未完成的 checkpoint
const ckpt = await loadCheckpoint(runId);
if (ckpt && ckpt.stopReason !== 'final') {
  // 恢复：从 ckpt.messages 重建 memory，从 ckpt.step+1 继续循环
  memory = Memory.fromMessages(ckpt.messages);
  startStep = ckpt.step + 1;
  totalUsage = ckpt.totalUsage;
}
```

**幂等性考量**（Diagrid 批判的核心）：工具副作用（如 web_search 已发请求）在重放时会**重新执行**。本项目采用「step 末尾快照」而非「事件重放」，因此**崩溃前已完成的 step 不会重跑**——只有崩溃发生在某 step 中途时，该 step 会从头执行。这是 checkpoint 模式对幂等性的天然保护（优于纯事件溯源）。

### 5.5 多代保留（Generational Retention）

```
.agentloop/checkpoints/<runId>.json         ← 最新
.agentloop/checkpoints/<runId>.prev.json    ← 前一代（防最新损坏）
```

加载时：先读最新，解析失败则回退前一代，再失败则视为无 checkpoint（全新开始）。

### 5.6 长任务编排：Workflow 级 Durable

单 loop 的 checkpoint 解决「单段执行崩溃」。8 小时任务还需 **workflow 级**编排：

```
[阶段1: 调研] → checkpoint → [阶段2: 分析] → checkpoint → [阶段3: 撰写] → checkpoint
```

每个阶段是一个独立 runLoop（自带 checkpoint），阶段间产出落盘。即使第 7 小时崩溃，也能从「阶段3的最近 checkpoint」恢复，而非从头。

---

## 六、8 小时任务执行架构（目标方案）

```
┌─────────────────────────────────────────────────────────────┐
│                    LongTask Runner                          │
│   (规划: maxSteps=∞, 每步 checkpoint, 崩溃自动 resume)        │
├─────────────────────────────────────────────────────────────┤
│  Workflow 阶段编排（复用 cogent/workflow.ts 或内置 pipeline） │
│  ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐          │
│  │ Phase1 │──▶│ Phase2 │──▶│ Phase3 │──▶│ Phase4 │          │
│  └───┬────┘   └───┬────┘   └───┬────┘   └───┬────┘          │
│      │ checkpoint   │           │           │                │
├──────▼──────────────▼───────────▼───────────▼───────────────┤
│         每个 Phase = runLoop(durable: { runId, ... })        │
│  • Memory 序列化 + 每步落盘                                   │
│  • auto-compact 防上下文爆炸                                   │
│  • subagent 分解隔离上下文                                    │
│  • span 树全程可观测                                          │
├─────────────────────────────────────────────────────────────┤
│   CheckpointStore (文件/未来可换 SQLite)                      │
│   .agentloop/checkpoints/<runId>.{json,prev.json}            │
└─────────────────────────────────────────────────────────────┘
```

### 容错与恢复矩阵

| 故障类型 | 检测 | 恢复 |
|----------|------|------|
| LLM 调用超时 | try/catch in step | 该 step 记录 error，**checkpoint 仍写入**，下个 resume 重试该 step |
| 工具网络错误 | tool.execute catch | 结果回填错误信息，循环继续（已有机制） |
| 进程 OOM/崩溃 | 外部（无）→ 手动重启 | 从最近 checkpoint resume |
| 机器重启 | 外部 | 从 checkpoint resume |
| checkpoint 文件损坏 | loadCheckpoint catch | 回退 prev 代；再失败则全新开始 |

---

## 七、测试策略

1. **单元测试**：`checkpoint.ts` 的 save/load/损坏回退/版本校验。
2. **集成测试**：模拟「跑 3 步 → 模拟崩溃（强制中断）→ resume → 续跑到收敛」。
3. **幂等测试**：验证崩溃 step 不会重复执行副作用（用计数工具断言）。
4. **长程模拟测试**：构造一个需要 ~50 步的任务（如多层迭代），中途 kill 后 resume，验证最终答案一致。

---

## 八、实施路线图

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 研究 + 归档（本文档） | ✅ 完成 |
| Phase 2 | 实现 `src/checkpoint.ts`（CheckpointStore + 原子写 + 多代） | ✅ 完成 |
| Phase 3 | 集成进 `runLoop`（可选 `durable` 配置，step 末尾落盘） | ✅ 完成 |
| Phase 4 | resume API（`runLoop` 入口检测 checkpoint 自动续跑） | ✅ 完成 |
| Phase 5 | durable 测试（14 项：崩溃恢复 + 幂等 + 向后兼容） | ✅ 完成 |
| Phase 6 | `src/long-task.ts` 阶段级编排 runner（含自动重试 + 阶段跳过） | ✅ 完成 |
| Phase 7 | 实跑验证（partial-resume：阶段跳过 + 续跑 + checkpoint 落盘） | ✅ 完成 |
| 后续 | workflow 级 durable（cogent/workflow.ts 集成） | 规划中 |

---

## 九、Karpathy《LOOPS.md》—— 理论基石（2025-07）

> *"Prompts are easy. Loops are hard. And writing fifty prompts a day is the work nobody does twice."*
> —— Andrej Karpathy, LOOPS.md (2025-07)

本文档的研究方向被一篇里程碑文献直接验证。2025 年 7 月，Andrej Karpathy 发布 `LOOPS.md`，宣告「提示词时代结束，循环时代到来」。Anthropic（Claude 创始人 Boris Cherny）与 Shopify 负责人的后续对话进一步确认了这个方向。本节归档其核心框架,并对照本项目做 Gap Analysis。

### 9.1 核心论点

Karpathy 认为工程师对 LLM 的关注点应从「写好单次提示词」转向「构建可靠的 agent 循环」。原因：
- **提示词是静态的、一次性的**：写五十个 prompt 的工作没人会做第二次,不可复用。
- **循环是有状态的、可迭代的**：agent 在循环中调工具、观察结果、自我修正、维护状态——这是真正的工程难题。

这个论点与本项目的设计哲学（单线程主循环 + 平坦消息历史 + 原生 tool-calling）完全一致。

### 9.2 LOOPS.md 的 Agent Loop 9 规则（TIER 6）

Karpathy 的 LOOPS.md 在 CLAUDE.md 35 条规则体系的第 6 层(TIER 6: AGENT LOOPS)给出 agent harness 设计的 9 条规则。对照本项目现状：

| # | Karpathy 规则 | 核心要义 | 本项目现状 |
|---|--------------|----------|-----------|
| 1 | **Single editable artifact** | agent 围绕一个可编辑文件工作（如 program.md），文件即「目标载体」 | ⚠️ 本项目以 user prompt 为输入,无「可编辑产物」概念。long-task 的阶段产出接近此模式 |
| 2 | **One objective metric** | 必须有一个可量化的目标函数判断「好坏」,agent 据此自我改进 | ⚠️ verify.ts 有断言验证,但非「连续度量驱动的自我改进」 |
| 3 | **Fixed time window per iteration** | 每次循环迭代有固定时间预算(如 5 分钟训练),防失控 | ❌ 缺失。maxSteps 限制步数但不限时间 |
| 4 | **Keep only improvements** | 只保留优于当前最佳的改动,丢弃劣化——「贪心爬山」 | ❌ 缺失。当前 loop 是线性推进,无「保留最佳」机制 |
| 5 | **Log everything** | 全程记录:每次尝试的输入/输出/指标,供回溯与学习 | ✅ trace.ts 的 span 树 + trace-store.ts 持久化 + trajectory 提取 |
| 6 | **The model does the bookkeeping** | 让 LLM 自己维护账本(状态/进度/决策记录),而非外部状态机 | ✅ Memory 平坦历史 + compact 摘要正是 LLM 自维护账本 |
| 7 | **Minimal harness** | harness(循环框架)应极简——Karpathy 的 autoresearch 仅 630 行 | ✅ 本项目核心 runLoop ~200 行,符合极简原则 |
| 8 | **Edit → Run → Observe → Repeat** | 经典 ReAct 循环:agent 编辑产物→运行→观察指标→重复 | ✅ loop.ts 的 Think→Act→Observe 完全对应 |
| 9 | **Unleash overnight** | 设计目标:让 loop 能自主跑一夜(8h+),无需人干预 | ✅ 本项目核心目标——durable 执行 + long-task runner 正为此设计 |

### 9.3 Karpathy Loop 三文件架构（autoresearch）

Karpathy 的 autoresearch（github.com/karpathy/autoresearch）用三个文件实现了可跑一夜的 agent loop,被誉为「the Karpathy Loop」:

| 文件 | 职责 | 本项目对应 |
|------|------|-----------|
| **program.md** | agent 可编辑的「目标文件」——定义什么是好的实验/输出 | long-tasks/*.json 的阶段定义（系统提示 + 用户指令 + 断言） |
| **train.py** | agent 实际编辑与运行的产物(每次迭代被改写) | (尚无;当前 agent 直接产文本答案) |
| **best.py** | 保留当前最优结果——只有超越它时才覆盖 | ❌ 缺失。long-task 产出覆盖式保存,无「保留最优」 |

**关键洞察**:Karpathy Loop 的精髓是「**让 agent 在固定时间窗口内反复编辑一个文件,用客观指标筛选保留改进**」。这是一种**有界爬山搜索**——比无界 ReAct 循环更可靠,因为:
- 时间窗口(Rule 3)防止单次迭代失控烧钱
- 只保留改进(Rule 4)保证轨迹单调不劣化
- 可编辑产物(Rule 1)让 agent 的「工作成果」可累积、可检查

### 9.4 Gap Analysis:本项目 vs Karpathy Loop

| 能力 | Karpathy Loop | 本项目 | Gap |
|------|--------------|--------|-----|
| ReAct 循环 | ✅ Edit→Run→Observe | ✅ Think→Act→Observe | 无 |
| 极简 harness | ✅ 630 行 | ✅ runLoop ~200 行 | 无 |
| 全程日志 | ✅ 实验日志 | ✅ span 树 + trajectory | 无 |
| LLM 自维护账本 | ✅ model bookkeeping | ✅ Memory + compact | 无 |
| **跑一夜(8h+)** | ✅ overnight | ✅ durable + long-task | **已实现** |
| 固定时间窗口/迭代 | ✅ 5min/iter | ✅ `phase.timeoutMs` + TimeoutError（Rule 3） | **已实现** |
| 客观指标驱动筛选 | ✅ keep best | ✅ `BestTracker` + `score.expr`（Rule 4） | **已实现** |
| 可编辑产物累积 | ✅ best.py | ⚠️ best-result.json（保留最优，但非「反复编辑同一文件」） | 部分（下一步） |

### 9.5 对本项目的演进启示（已部分落地）

Karpathy Loop 揭示了本项目从「能跑一夜」迈向「**跑一夜还能持续改进**」的三步演进:

1. ✅ **时间预算(Rule 3)** — 已实现:PhaseSpec 增加 `timeoutMs`,runLoopWithRetry 用 `Promise.race` 限时,超时抛 `TimeoutError`(不重试),checkpoint 已保存的进度保留,resume 时续跑。测试覆盖:超时抛错 + 不超时正常返回。
2. ✅ **最佳保留(Rule 4)** — 已实现:`BestTracker` 类 + LongTaskSpec 的 `score.expr` 配置。每次任务产出打分后与 `best-result.json` 比对,仅更优时覆盖(贪心爬山)。支持 `higherIsBetter` 双向。测试覆盖:首次/更优/劣化/反向/非法表达式/损坏回退。
3. ⏳ **迭代式任务(Rule 1+4)** — 待实现:新增「迭代型」long-task 模式——agent 反复编辑同一产物文件,用 verify 指标筛选,直到达标或耗尽预算。这是「Karpathy Loop」的完整复刻(autoresearch 的 program.md → train.py → best.py 三文件架构)。

> 前两步已完成「durable 执行 + 时间安全 + 最佳保留」,第三步将实现真正的「持续自我改进」循环。

---

## 十、参考资料引用规范

本文档所有外部结论均标注来源。实现阶段将对照：
- **Karpathy LOOPS.md** → 理论基石:9 规则 + 三文件架构(第 9 节)
- Temporal Continue-As-New → 对应本项目的「compact 后重置步数计数」
- Diagrid 三要素 → 对应「checkpoint 文件 + runLoop 检测 + step 幂等」
- Addy Osmani checklist → 对应「原子写 + 多代保留 + 自洽快照点」

---

## 十一、参考文献清单（含 2025-07 更新）

| # | 来源 | 核心贡献 | 链接 |
|---|------|----------|------|
| 0 | **Karpathy《LOOPS.md》(2025-07)** | **理论基石**:prompts→loops 范式转移;agent loop 9 规则 | [Gist](https://gist.github.com/sanchez314c/a767997b030d2904c0d0f08fabae2d42) |
| 0b | **Karpathy autoresearch** | the Karpathy Loop 三文件实现(program.md/train.py/best.py) | [github.com/karpathy/autoresearch](https://github.com/karpathy/autoresearch) |
| 0c | Claude 创始人对话(微信) | 业界共识:loop 时代已来;Anthropic+Shopify 验证 | [mp.weixin.qq.com](https://mp.weixin.qq.com/s/eh_InHkl8PCeyjAeGz90ng) |
| 1 | Addy Osmani《Long-running Agents》 | checkpoint-and-resume 工程化清单 | [addyo.substack.com](https://addyo.substack.com/p/long-running-agents) |
| 2 | Temporal - Continue-As-New | 防事件表无限增长 | [docs.temporal.io](https://docs.temporal.io/continue-as-new) |
| 3 | Diagrid 批判 | 仅 checkpoint 不够,需编排重启+幂等 | [diagrid.io](https://diagrid.io/blog/checkpoints-vs-durable-execution) |
| 4 | Anthropic《Effective Context Engineering》 | context rot、subagent 隔离 | [anthropic.com](https://anthropic.com/news/context-engineering) |

---

*本文档为研究归档,随实现进展持续更新。对应代码实现见 `src/checkpoint.ts`、`src/loop.ts` 的 durable 集成、`src/long-task.ts`。第 9.5 节的三步演进为下一阶段工作方向。*
