import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOrchestrationV2TestFiles } from './lesson-author-orchestration-v2-test-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = await listOrchestrationV2TestFiles(root);

if (tests.length === 0) {
  throw new Error('ORCHESTRATION_V2_TEST_SUITE_EMPTY');
}

const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsxCli, '--test', ...tests], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.once('error', error => {
  console.error('[LessonAuthorOrchestrationV2Tests] Failed to start:', error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`[LessonAuthorOrchestrationV2Tests] Terminated by ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
