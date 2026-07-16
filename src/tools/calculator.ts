/**
 * 工具：calculator —— 安全的算术求值。
 *
 * 安全策略：绝不使用 eval / new Function。手写一个 Shunting-Yard
 * 词法分析 + 双栈求值器，只接受数字与 + - * / ( ) 与空白。
 * 任何非法字符直接报错，杜绝代码注入。
 *
 * 支持一元 +/-（如 -1+2、3*-2、-(2+3)、2--3）与科学计数法（如 1e3、1.5e-2）。
 */

import type { ToolDef } from '../types.ts';

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

/** 读取从位置 i 开始的一个数字字面量（含小数点与可选的科学计数法）。i 指向首个数字/点。 */
function readNumber(expr: string, i: number): { value: number; next: number } {
  let j = i;
  // 整数 / 小数部分：[0-9.]
  while (j < expr.length && /[0-9.]/.test(expr[j]!)) j++;
  // 可选的科学计数法：e / E + 可选符号 + 数字
  if (j < expr.length && (expr[j] === 'e' || expr[j] === 'E')) {
    j++;
    if (j < expr.length && (expr[j] === '+' || expr[j] === '-')) j++;
    const expStart = j;
    while (j < expr.length && /[0-9]/.test(expr[j]!)) j++;
    if (j === expStart) throw new Error('非法的科学计数法（缺少指数）');
  }
  const num = expr.slice(i, j);
  const value = Number(num);
  if (Number.isNaN(value)) throw new Error(`非法数字「${num}」`);
  return { value, next: j };
}

/** 判断当前位置的 +/- 是否为一元（前置 token 非数字/右括号时为一元） */
function isUnaryPosition(prev: Token | undefined): boolean {
  if (!prev) return true; // 表达式开头
  return prev.kind === 'op' || prev.kind === 'lparen';
}

/**
 * 词法分析：把表达式切成 token，遇非法字符抛错。
 * 一元 +/- 在此阶段处理：
 *  - 一元 + ：直接丢弃（+x 等价 x）。
 *  - 一元 - ：后接数字 → 合并为负数 num；后接 (  → 等价 0-(...)，插入 num:0 + 二元 -。
 */
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === '+' || ch === '-') {
      if (isUnaryPosition(tokens[tokens.length - 1])) {
        if (ch === '+') {
          // 一元 + 丢弃
          i++;
          continue;
        }
        // 一元 -：看后面是数字还是括号
        let j = i + 1;
        while (j < expr.length && (expr[j] === ' ' || expr[j] === '\t')) j++;
        if (j < expr.length && /[0-9.]/.test(expr[j]!)) {
          const { value, next } = readNumber(expr, j);
          tokens.push({ kind: 'num', value: -value });
          i = next;
          continue;
        }
        // 一元 - 后接括号或其它：用 0 - (...) 等价
        tokens.push({ kind: 'num', value: 0 });
        tokens.push({ kind: 'op', value: '-' });
        i++;
        continue;
      }
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    // 数字（含小数点与科学计数法，多个点交给 Number 校验）
    if (/[0-9.]/.test(ch)) {
      const { value, next } = readNumber(expr, i);
      tokens.push({ kind: 'num', value });
      i = next;
      continue;
    }
    throw new Error(`非法字符「${ch}」`);
  }
  return tokens;
}

/** 应用一个二元运算 */
function applyOp(a: number, b: number, op: string): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      if (b === 0) throw new Error('除零错误');
      return a / b;
    default:
      throw new Error(`未知运算符「${op}」`);
  }
}

/** 双栈求值（Shunting-Yard 的就地版） */
function evaluate(tokens: Token[]): number {
  const values: number[] = [];
  const ops: string[] = [];

  for (const t of tokens) {
    if (t.kind === 'num') {
      values.push(t.value);
    } else if (t.kind === 'op') {
      while (
        ops.length &&
        ops[ops.length - 1] !== '(' &&
        PRECEDENCE[ops[ops.length - 1]!]! >= PRECEDENCE[t.value]!
      ) {
        const op = ops.pop()!;
        const b = values.pop();
        const a = values.pop();
        if (a === undefined || b === undefined) throw new Error('表达式不完整');
        values.push(applyOp(a, b, op));
      }
      ops.push(t.value);
    } else if (t.kind === 'lparen') {
      ops.push('(');
    } else if (t.kind === 'rparen') {
      while (ops.length && ops[ops.length - 1] !== '(') {
        const op = ops.pop()!;
        const b = values.pop();
        const a = values.pop();
        if (a === undefined || b === undefined) throw new Error('表达式不完整');
        values.push(applyOp(a, b, op));
      }
      if (ops.pop() !== '(') throw new Error('括号不匹配');
    }
  }

  while (ops.length) {
    const op = ops.pop()!;
    if (op === '(') throw new Error('括号不匹配');
    const b = values.pop();
    const a = values.pop();
    if (a === undefined || b === undefined) throw new Error('表达式不完整');
    values.push(applyOp(a, b, op));
  }

  if (values.length !== 1) throw new Error('表达式不完整');
  return values[0]!;
}

export const calculatorTool: ToolDef<{ expression: string }> = {
  name: 'calculator',
  description: '计算一个算术表达式，支持 + - * /、括号、负号与科学计数法。例如：(1+2)*3、3*-2、1.5e-2',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '要计算的算术表达式' },
    },
    required: ['expression'],
  },
  execute({ expression }) {
    try {
      const result = evalExpression(expression);
      return { ok: true, output: `${expression} = ${result}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, output: `计算失败：${msg}` };
    }
  },
};

/**
 * 安全求值：导出供 iterate 等工具复用。
 * 把表达式里的 `x` 占位符替换为给定数值后，用 Shunting-Yard 求值。
 * 不使用 eval / new Function，杜绝代码注入。
 */
export function evalExpression(expr: string, x?: number): number {
  const replaced = x === undefined ? expr : expr.replace(/x/g, String(x));
  return evaluate(tokenize(replaced));
}
