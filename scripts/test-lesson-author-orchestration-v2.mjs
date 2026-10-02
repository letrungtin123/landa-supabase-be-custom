import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(root, 'src', 'modules', 'ai-chatbot');
const tests = (await readdir(testDirectory))
  .filter(name => name.startsWith('lesson-author-orchestration-v2') && name.endsWith('.test.ts'))
  .sort()
  .map(name => path.join(testDirectory, name));

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
