import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cross-language tests run Python of the landa-ai-rag repo, checked out next to
// landa-backend (../landa-ai-rag) with its dev virtualenv (.venv-dev). Where it
// is not there (CI clones this repository alone), those tests are skipped with
// this reason instead of failing, as the IDM bridge tests already are
// (lesson-author-idm.fixture.ts).
const root = fileURLToPath(new URL('../../../landa-ai-rag/', import.meta.url));

export const AI_RAG_DEV_PYTHON = resolve(
  root,
  process.platform === 'win32' ? '.venv-dev/Scripts/python.exe' : '.venv-dev/bin/python',
);

/** `{ skip: aiRagPythonSkip }` for a test that spawns ../landa-ai-rag/.venv-dev Python. */
export const aiRagPythonSkip: string | false = existsSync(AI_RAG_DEV_PYTHON)
  ? false
  : `needs ${AI_RAG_DEV_PYTHON} (the landa-ai-rag repo next to landa-backend, with its .venv-dev), which is not available here`;
