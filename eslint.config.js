import js from '@eslint/js';
import ts from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default ts.config(
  {
    ignores: [
      'dist',
      'dev-dist',
      'node_modules',
      'scripts/**', // dev-only tsx harnesses
      '*.config.js',
      '*.config.ts',
      'postcss.config.js',
      'tailwind.config.js',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Classic hook rules only — the plugin's newer "recommended" bundles the
      // strict React-Compiler purity rules, which we don't opt into yet.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Pragmatic settings for this codebase (can tighten later):
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Newer ESLint-10 stylistic defaults — informative, not bugs; keep as warnings.
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
  {
    // Tests may use a few extra patterns; keep them lenient.
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
