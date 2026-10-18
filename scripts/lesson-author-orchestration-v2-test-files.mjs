// The test files of `npm run test:lesson-author-orchestration-v2`: every
// lesson-author-orchestration-v2*.test.ts and lesson-author-idm*.test.ts in
// src/modules/ai-chatbot, sorted. scripts/run-tests.mjs uses the same list to
// check that every test file belongs to a suite.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function listOrchestrationV2TestFiles(root) {
  const testDirectory = path.join(root, 'src', 'modules', 'ai-chatbot');
  return (await readdir(testDirectory))
    .filter(
      name =>
        (name.startsWith('lesson-author-orchestration-v2') || name.startsWith('lesson-author-idm')) &&
        name.endsWith('.test.ts'),
    )
    .sort()
    .map(name => path.join(testDirectory, name));
}
