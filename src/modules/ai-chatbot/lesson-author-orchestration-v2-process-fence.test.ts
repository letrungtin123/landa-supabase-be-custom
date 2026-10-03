import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOrchestrationV2ProductionProcessFence } from './lesson-author-orchestration-v2-process-fence.js';

test('allows the compiled orchestration worker in production', () => {
  assert.doesNotThrow(() => assertOrchestrationV2ProductionProcessFence({
    node_env: 'production',
    exec_argv: [],
    argv: ['node', 'dist/workers/lesson-author-orchestration-v2.worker.js'],
  }));
});

test('allows a source orchestration worker only outside production', () => {
  assert.doesNotThrow(() => assertOrchestrationV2ProductionProcessFence({
    node_env: 'development',
    exec_argv: ['--import', 'node_modules/tsx/dist/loader.mjs'],
    argv: ['node', 'src/workers/lesson-author-orchestration-v2.worker.ts'],
  }));
});

test('rejects TSX orchestration workers before they can consume production messages', () => {
  assert.throws(
    () => assertOrchestrationV2ProductionProcessFence({
      node_env: 'production',
      exec_argv: ['--import', 'file:///app/node_modules/tsx/dist/loader.mjs'],
      argv: ['node', 'src/workers/lesson-author-orchestration-v2.worker.ts'],
    }),
    /LESSON_AUTHOR_ORCHESTRATION_V2_PRODUCTION_SOURCE_RUNTIME_FORBIDDEN/,
  );
});
