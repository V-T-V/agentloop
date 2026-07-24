/**
 * Reflection Loop：批评→修订子循环（自我改进 Agent 核心）。
 *
 * 来源：BuildMVPFast《Reflection Loops for Accuracy》报告 +34.2% 准确率。
 *
 * 与重试的区别：
 *   重试 = 全新 context 从头跑（昂贵、不精确，~8步）
 *   反思 = 原地批评+修订（2次 LLM 调用，精确修正已知问题）
 *
 * 流程：
 *   Worker 产出 answer_v1
 *     → critique(llm, answer, task, context) → { issues, severity, suggestedFix }
 *     → 若 severity >= threshold：
 *         revise(llm, answer, critique) → answer_v2
 *     → answer_v2（而非 v1）进入 verify 门控
 *
 * 终止条件：最多修订 maxRevisions 次（默认 2），或 severity < threshold。
 */

import { extractText } from './multimodal.ts';
import type { LLMClient, Message } from './types.ts';

/** 批评结果（结构化） */
export interface Critique {
  /** 发现的问题列表 */
  issues: string[];
  /** 严重程度：low（无需修订）/ medium（建议修订）/ high（必须修订） */
  severity: 'low' | 'medium' | 'high';
  /** 具体修改建议 */
  suggestedFix: string;
}

/** 反思配置 */
export interface ReflectionConfig {
  /** 是否启用反思循环 */
  enabled: boolean;
  /** 最大修订次数（默认 2） */
  maxRevisions: number;
  /** 触发修订的最低严重程度（默认 medium） */
  minSeverityToRevise: 'low' | 'medium' | 'high';
}

/** 默认配置 */
export const DEFAULT_REFLECTION: ReflectionConfig = {
  enabled: false,
  maxRevisions: 2,
  minSeverityToRevise: 'medium',
};

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2 };

const CRITIC_SYSTEM = `你是一个严格的评审专家。你的任务是审查一个 AI agent 的产出，找出问题。

审查标准：
- 内容是否完整（是否遗漏了任务要求的关键信息）
- 内容是否准确（有无明显错误）
- 内容是否充分（是否太简短、缺乏细节）
- 格式是否符合要求

输出 JSON 格式（不要其他文字）：
{
  "issues": ["问题1", "问题2"],
  "severity": "low|medium|high",
  "suggestedFix": "具体修改建议（一句话）"
}

severity 含义：
- low: 小问题，基本合格，不需修订
- medium: 有明显不足，建议修订
- high: 严重不足，必须修订`;

const REVISE_SYSTEM = `你是一个改进专家。你收到了一个原始回答和针对它的批评建议。
请基于批评建议修订原始回答，输出改进后的完整版本。
保留原始回答中的正确内容，只针对批评指出的问题进行修正。
直接输出修订后的内容，不要解释你做了什么。`;

/**
 * 解析 critic 返回的 JSON（容错：strip markdown fence，提取 JSON）。
 */
export function parseCritique(raw: string): Critique {
  let text = raw.trim();
  // strip markdown fence
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();
  try {
    const parsed = JSON.parse(text) as Partial<Critique>;
    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      severity: parsed.severity === 'high' ? 'high' : parsed.severity === 'medium' ? 'medium' : 'low',
      suggestedFix: typeof parsed.suggestedFix === 'string' ? parsed.suggestedFix : '',
    };
  } catch {
    // JSON 解析失败——提取大括号内容
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Critique>;
        return {
          issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
          severity: parsed.severity === 'high' ? 'high' : parsed.severity === 'medium' ? 'medium' : 'low',
          suggestedFix: typeof parsed.suggestedFix === 'string' ? parsed.suggestedFix : '',
        };
      } catch {
        // 仍失败——降级为 low
      }
    }
    return { issues: ['critic 输出解析失败'], severity: 'low', suggestedFix: '' };
  }
}

/**
 * 批评一个回答：返回结构化的改进建议。
 */
export async function critique(
  llm: LLMClient,
  answer: string,
  task: string,
  requirements?: string,
): Promise<Critique> {
  const userContent =
    `任务描述：${task}\n\n` +
    (requirements ? `要求：${requirements}\n\n` : '') +
    `AI 的回答：\n${answer}\n\n` +
    `请审查以上回答，输出 JSON 格式的批评。`;

  const messages: Message[] = [
    { role: 'system', content: CRITIC_SYSTEM },
    { role: 'user', content: userContent },
  ];

  try {
    const result = await llm.chat({ messages, tools: [], responseFormat: { type: 'json_object' } });
    return parseCritique(extractText(result.message.content));
  } catch {
    // LLM 调用失败——降级为不批评
    return { issues: [], severity: 'low', suggestedFix: '' };
  }
}

/**
 * 修订一个回答：基于批评建议产出改进版。
 */
export async function revise(
  llm: LLMClient,
  answer: string,
  criticism: Critique,
  task: string,
): Promise<string> {
  const userContent =
    `任务：${task}\n\n` +
    `原始回答：\n${answer}\n\n` +
    `批评意见：\n${criticism.issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}\n\n` +
    `修改建议：${criticism.suggestedFix}\n\n` +
    `请基于以上批评修订原始回答，输出完整修订版。`;

  const messages: Message[] = [
    { role: 'system', content: REVISE_SYSTEM },
    { role: 'user', content: userContent },
  ];

  try {
    const result = await llm.chat({ messages, tools: [] });
    return extractText(result.message.content).trim() || answer; // 修订失败则返回原文
  } catch {
    return answer; // LLM 失败则返回原文
  }
}

/**
 * 判断是否需要修订（severity 达到阈值）。
 */
export function shouldRevise(criticism: Critique, minSeverity: 'low' | 'medium' | 'high' = 'medium'): boolean {
  return SEVERITY_ORDER[criticism.severity] >= SEVERITY_ORDER[minSeverity];
}

/**
 * 完整的 Reflection Loop：批评→（条件）修订→返回最终版本 + 元信息。
 *
 * 用法：
 *   const { answer, critiques, revised } = await reflectionLoop(llm, answer, task, config);
 *   // answer 可能是修订后的 v2/v3，也可能是原始 v1（若 critic 说 low severity）
 */
export async function reflectionLoop(
  llm: LLMClient,
  answer: string,
  task: string,
  config: ReflectionConfig,
  requirements?: string,
): Promise<{
  /** 最终答案（可能是修订后的） */
  answer: string;
  /** 每次批评的结果 */
  critiques: Critique[];
  /** 是否发生过修订 */
  revised: boolean;
}> {
  if (!config.enabled) {
    return { answer, critiques: [], revised: false };
  }

  const critiques: Critique[] = [];
  let currentAnswer = answer;
  let revised = false;

  for (let i = 0; i < config.maxRevisions; i++) {
    const c = await critique(llm, currentAnswer, task, requirements);
    critiques.push(c);

    if (!shouldRevise(c, config.minSeverityToRevise)) {
      break; // severity 低，不需修订
    }

    // 修订
    const revisedAnswer = await revise(llm, currentAnswer, c, task);
    if (revisedAnswer !== currentAnswer) {
      currentAnswer = revisedAnswer;
      revised = true;
    } else {
      break; // 修订无变化，停止
    }
  }

  return { answer: currentAnswer, critiques, revised };
}
