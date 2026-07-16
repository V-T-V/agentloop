/**
 * 工具：iterate —— 通用数值迭代（带状态的循环计算）。
 *
 * 解决 calculator（单次表达式）无法胜任的「迭代型任务」：Collatz 序列、
 * 斐波那契、阶乘累加、复利、log 迭代近似等。
 *
 * 工作方式：维护一个当前值 x，每步用 step 表达式（含占位符 x）算出下一个 x，
 * 直到满足 stopWhen 条件或达到 maxIter。返回完整轨迹 + 是否收敛。
 *
 * 安全：复用 calculator 的 evalExpression（Shunting-Yard），不接受任意代码；
 * stopWhen 用简单规则（x==target / x<bound），不执行 LLM 给的条件代码。
 */

import { evalExpression } from './calculator.ts';
import type { ToolDef } from '../types.ts';

const HARD_ITER_CAP = 10000; // 绝对上限，防恶意/失控循环

/** 终止条件：当前值等于目标、或小于/大于某边界（maxIter 在顶层参数，不在此处） */
interface StopCondition {
  /** 当 x 等于此值时停止（如 Collatz 收敛到 1） */
  equals?: number;
  /** 当 x 小于此值时停止 */
  lessThan?: number;
  /** 当 x 大于此值时停止 */
  greaterThan?: number;
}

export const iterateTool: ToolDef<{
  start: number;
  step?: string;
  stepOdd?: string;
  stepEven?: string;
  stopWhen: StopCondition;
  maxIter?: number;
}> = {
  name: 'iterate',
  description:
    '迭代计算一个数值序列：给定起始值 start、每步表达式（用 x 表示当前值，如 "3*x+1"）、' +
    '终止条件 stopWhen，返回完整轨迹直到收敛或达上限。' +
    '两种步进模式：① 统一步进 step；② 分支步进 stepOdd（x 为奇数时，如 "3*x+1"）+ stepEven（x 为偶数时，如 "x/2"）——后者用于 Collatz 等条件迭代。' +
    '适合 Collatz 序列、斐波那契、阶乘累加等，避免用 calculator 逐步算导致步数耗尽。',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'number', description: '起始值 x0（如 Collatz 用 7、27、97）' },
      step: {
        type: 'string',
        description: '统一步进表达式（用 x 表示当前值）。与 stepOdd/stepEven 二选一',
      },
      stepOdd: {
        type: 'string',
        description: 'x 为奇数时的步进表达式（如 Collatz 的 "3*x+1"）',
      },
      stepEven: {
        type: 'string',
        description: 'x 为偶数时的步进表达式（如 Collatz 的 "x/2"）',
      },
      stopWhen: {
        type: 'object',
        description: '终止条件（满足任一即停）',
        properties: {
          equals: { type: 'number', description: 'x 等于此值时停止' },
          lessThan: { type: 'number', description: 'x 小于此值时停止' },
          greaterThan: { type: 'number', description: 'x 大于此值时停止' },
        },
      },
      maxIter: { type: 'integer', description: '最大迭代次数（默认 1000，硬上限 10000）' },
    },
    required: ['start', 'stopWhen'],
  },
  execute({ start, step, stepOdd, stepEven, stopWhen, maxIter }) {
    try {
      const cap = Math.min(maxIter ?? 1000, HARD_ITER_CAP);
      // 决定每步用哪个表达式
      const pickStep = (x: number): string => {
        if (step) return step; // 统一步进优先
        if (stepOdd && stepEven) return Number.isInteger(x) && x % 2 !== 0 ? stepOdd : stepEven;
        throw new Error('需要提供 step（统一步进）或 stepOdd+stepEven（分支步进）');
      };

      const seq: number[] = [start];
      let x = start;
      let converged = false;

      for (let i = 0; i < cap; i++) {
        if (stopWhen.equals !== undefined && x === stopWhen.equals) {
          converged = true;
          break;
        }
        if (stopWhen.lessThan !== undefined && x < stopWhen.lessThan) break;
        if (stopWhen.greaterThan !== undefined && x > stopWhen.greaterThan) break;

        const expr = pickStep(x);
        const next = evalExpression(expr, x);
        if (!Number.isFinite(next)) {
          return { ok: false, output: `第 ${i + 1} 步得到非有限数（${next}），已中止。轨迹：[${seq.join(', ')}]` };
        }
        seq.push(next);
        x = next;
      }

      const ruleDesc = step ? `规则 ${step}` : `规则（奇数 ${stepOdd} / 偶数 ${stepEven}）`;
      const status = converged
        ? `✅ 收敛到 ${stopWhen.equals}（${seq.length - 1} 步，序列长度 ${seq.length}）`
        : `⏹️ 达到迭代上限未收敛（${seq.length} 步）`;
      const display =
        seq.length <= 60
          ? `[${seq.join(', ')}]`
          : `[${seq.slice(0, 30).join(', ')}, …（共 ${seq.length} 项），${seq.slice(-5).join(', ')}]`;
      return {
        ok: true,
        output: `起始 ${start}，${ruleDesc}。${status}\n完整序列：${display}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, output: `迭代失败：${msg}` };
    }
  },
};
