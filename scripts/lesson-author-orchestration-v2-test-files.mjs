// The test files of `npm run test:lesson-author-orchestration-v2`: every
// lesson-author-orchestration-v2*.test.ts and lesson-author-idm*.test.ts under
// src/modules/ai-chatbot (any sub-folder), sorted. scripts/run-tests.mjs uses
// the same list to check that every test file belongs to a suite.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function listOrchestrationV2TestFiles(root) {
  const moduleDirectory = path.join(root, 'src', 'modules', 'ai-chatbot');
  return (await readdir(moduleDirectory, { recursive: true }))
    .filter(relative => {
      const name = path.basename(relative);
      return (
        (name.startsWith('lesson-author-orchestration-v2') || name.startsWith('lesson-author-idm')) &&
        name.endsWith('.test.ts')
      );
    })
    .map(relative => relative.split(path.sep).join('/'))
    .sort()
    .map(relative => path.join(moduleDirectory, relative));
}
