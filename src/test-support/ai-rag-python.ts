import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cross-language tests run Python of the landa-ai-rag repo, checked out next to
// landa-backend (../landa-ai-rag) with its dev virtualenv (.venv-dev). Where it
// is not there (CI clones this repository alone), those tests are skipped with
// a reason instead of failing.
//
// LANDA_REQUIRE_CROSS_LANGUAGE=1 turns that skip into a failure: the first
// check of a missing file throws, so the test file that needs it fails to load.
// Set it where the AI repo is expected next to this one, so a wrong path (for
// example after files moved) cannot hide the cross-language tests as skips.
//
// Every path to the AI repo is resolved here, from this file's place
// (src/test-support), so the tests that use it can live in any folder.

const sibling = fileURLToPath(new URL('../../../landa-ai-rag/', import.meta.url));

/**
 * The landa-ai-rag checkout next to landa-backend. A link (symlink or junction)
 * there is followed to its folder, so Python runs from the checkout's own,
 * shorter path (Windows Python cannot import past 260 characters).
 */
export const AI_RAG_ROOT = existsSync(sibling) ? realpathSync(sibling) : sibling;

/** The Python of its dev virtualenv. */
export const AI_RAG_DEV_PYTHON = resolve(
  AI_RAG_ROOT,
  process.platform === 'win32' ? '.venv-dev/Scripts/python.exe' : '.venv-dev/bin/python',
);

/** LANDA_REQUIRE_CROSS_LANGUAGE=1: a missing AI repo, virtualenv or bridge file fails instead of skipping. */
export const REQUIRE_CROSS_LANGUAGE = process.env.LANDA_REQUIRE_CROSS_LANGUAGE === '1';

/**
 * `{ skip: aiRagSkip(...) }` for a test that spawns the AI repo's dev Python and
 * needs `files` of that repo (paths relative to its root, such as
 * 'tests/idm_contract_bridge.py'): false when everything is there, else the
 * reason to skip. Throws instead when LANDA_REQUIRE_CROSS_LANGUAGE=1.
 */
export function aiRagSkip(...files: string[]): string | false {
  const missing = [AI_RAG_DEV_PYTHON, ...files.map(file => resolve(AI_RAG_ROOT, file))].filter(
    path => !existsSync(path),
  );
  if (missing.length === 0) return false;
  const reason = `needs ${missing.join(', ')} (the landa-ai-rag repo next to landa-backend, with its .venv-dev), which is not available here`;
  if (REQUIRE_CROSS_LANGUAGE) throw new Error(`LANDA_REQUIRE_CROSS_LANGUAGE=1: ${reason}`);
  return reason;
}

/** `{ skip: aiRagPythonSkip }` for a test that spawns ../landa-ai-rag/.venv-dev Python. */
export const aiRagPythonSkip: string | false = aiRagSkip();
