// ESLint 9 flat config —— Agent Loop（纯 Node 后端，无 DOM）。
// 规则集与工作区兄弟项目（agentresearch / dashan / agenttrain）保持一致。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', '.git/', '*.log'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      // Agent 主循环是合理的串行 await 语义：每一步依赖上一步的工具结果
      'no-await-in-loop': 'off',
      // CLI 大量使用 console 作为交互输出
      'no-console': 'off',
    },
  },
);
