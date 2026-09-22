import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
export default ts.config(
  { ignores: ['dist/**', 'dist-store/**', 'node_modules/**', 'test-results/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: 'readonly' } }, rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-restricted-imports': ['error', { paths: [{ name: 'culori', message: 'Use tree-shakeable culori/fn.' }, { name: 'jsdom', message: 'Use real Chromium.' }, { name: 'happy-dom', message: 'Use real Chromium.' }] }],
  } },
  { files: ['src/core/**/*.ts'], rules: {
    'no-restricted-globals': ['error', 'document', 'window', 'chrome', 'getComputedStyle', 'CSSStyleSheet'],
  } },
);
