import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childEnv = { ...process.env, NODE_ENV: 'development' };

const child = spawn(
  process.execPath,
  [require.resolve('tsx/cli'), 'src/workers/lesson-author-orchestration-v2.worker.ts'],
  {
    cwd: projectRoot,
    env: childEnv,
    stdio: 'inherit',
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.once('error', (error) => {
  console.error(`[LessonAuthorV2LocalWorker] Could not start worker: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) console.log(`[LessonAuthorV2LocalWorker] Worker stopped by ${signal}`);
  process.exitCode = code ?? (signal ? 1 : 0);
});
