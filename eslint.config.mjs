// ESLint: `npm run lint` (CI runs it too). `npm run lint -- <paths>` and
// `npm run lint:fix -- <paths>` work on part of the tree.
//
// Baseline for existing code: every error that existed when lint was added
// (2026-10-18) is recorded per file and rule in eslint-suppressions.json, so
// lint passes with 0 errors while any new error fails it, in a new file or in
// an old one. The baseline only shrinks:
// - after fixing recorded errors, run `npm run lint:baseline` (prunes the
//   file); until then lint fails with "There are suppressions left that do
//   not occur anymore";
// - never grow it to get green. `eslint --suppress-all` is for the initial
//   baseline only;
// - `npm run lint:fix` without paths also rewrites recorded errors all over
//   the tree: give it the paths of the change instead.
// Warnings (max-lines, no-empty) are never recorded; they print on every run.
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'tmp/**',
      // Legacy one-off scripts at the repository root, outside tsconfig.json.
      'run-migration.ts',
      'update-badges.ts',
    ],
  },
  js.configs.recommended,
  {
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'max-lines': ['warn', { max: 800 }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Type-aware rules that catch real bugs.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test registers test()/describe() synchronously; their promise needs no await.
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/only-throw-error': 'error',
    },
  },
  eslintConfigPrettier,
);
