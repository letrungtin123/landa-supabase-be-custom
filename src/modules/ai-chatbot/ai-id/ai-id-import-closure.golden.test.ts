import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createModuleResolver, importClosure } from '../../../test-support/import-closure.js';

// Golden import closure of the AI ID code: the files of this folder (ai-id/,
// legacy/ included) that each entry point reaches through value imports,
// computed statically with the TypeScript compiler (src/test-support/import-closure.ts).
//
// - by_name: the file names, sorted. A move-only change of ai-id keeps it
//   equal; the test fails when an entry point reaches a file more or less.
// - by_path: the same files as paths from src/modules/ai-chatbot/, for
//   reading only. A move changes it without failing the test (a note says so);
//   rewrite the golden after the move so it shows the new places.
//
// After a reviewed change of what an entry point loads, rewrite it:
//   AI_ID_IMPORT_CLOSURE_GOLDEN_WRITE=1 npx tsx --test src/modules/ai-chatbot/ai-id/ai-id-import-closure.golden.test.ts

const here = path.dirname(fileURLToPath(import.meta.url));
const AI_CHATBOT = path.resolve(here, '..');
const SRC = path.resolve(here, '../../..');
const REPO = path.resolve(SRC, '..');
const GOLDEN_PATH = path.join(here, 'ai-id-import-closure.golden.json');
const WRITE = process.env.AI_ID_IMPORT_CLOSURE_GOLDEN_WRITE === '1';

/** The PM2 entry points: the V2 dispatcher/worker process and the API process (dist/index.js). */
const ENTRIES = ['src/workers/lesson-author-orchestration-v2.worker.ts', 'src/index.ts'];

interface EntryClosure {
  by_name: string[];
  by_path: string[];
}

interface Golden {
  description: string;
  entries: Record<string, EntryClosure>;
}

const posix = (file: string) => file.split(path.sep).join('/');

function closures(): Golden {
  const resolver = createModuleResolver(path.join(REPO, 'tsconfig.json'), SRC);
  const entries: Record<string, EntryClosure> = {};
  for (const entry of ENTRIES) {
    const { files } = importClosure([path.join(REPO, entry)], resolver);
    const aiId = [...files].filter(file => file.startsWith(here + path.sep));
    const byPath = aiId.map(file => posix(path.relative(AI_CHATBOT, file))).sort();
    const byName = aiId.map(file => path.basename(file)).sort();
    const duplicates = byName.filter((name, index) => byName[index - 1] === name);
    assert.deepEqual(duplicates, [], `${entry}: two reached files share a name, so by_name cannot tell them apart`);
    entries[entry] = { by_name: byName, by_path: byPath };
  }
  return {
    description:
      'Files of src/modules/ai-chatbot/ai-id that each entry point reaches through value imports (static). by_name must stay equal across a move-only change; by_path is informational. Rewrite: AI_ID_IMPORT_CLOSURE_GOLDEN_WRITE=1.',
    entries,
  };
}

test('every entry point reaches the recorded AI ID files (by file name)', t => {
  const current = closures();
  if (WRITE) {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(current, null, 1)}\n`);
    return;
  }
  assert.ok(existsSync(GOLDEN_PATH), `no golden: run with AI_ID_IMPORT_CLOSURE_GOLDEN_WRITE=1 (${GOLDEN_PATH})`);
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
  assert.deepEqual(Object.keys(current.entries), Object.keys(golden.entries));
  for (const entry of ENTRIES) {
    const now = current.entries[entry];
    const recorded = golden.entries[entry];
    const added = now.by_name.filter(name => !recorded.by_name.includes(name));
    const removed = recorded.by_name.filter(name => !now.by_name.includes(name));
    assert.deepEqual({ added, removed }, { added: [], removed: [] }, `${entry} reaches other AI ID files`);
    assert.deepEqual(now.by_name, recorded.by_name, entry);
    const moved = now.by_path.filter(file => !recorded.by_path.includes(file)).length;
    if (moved > 0) {
      t.diagnostic(
        `${entry}: ${moved} files are at another path than the golden records (same names): rewrite it with AI_ID_IMPORT_CLOSURE_GOLDEN_WRITE=1`,
      );
    }
  }
});

test('the closure reads the entry points and follows NodeNext .js specifiers to .ts files', () => {
  const current = closures();
  const worker = current.entries['src/workers/lesson-author-orchestration-v2.worker.ts'];
  // The worker's own composition root and the API's router wiring are in the closures.
  assert.ok(worker.by_name.includes('lesson-author-orchestration-v2-runtime.service.ts'));
  assert.ok(current.entries['src/index.ts'].by_name.includes('lesson-author-workspace-read.controller.ts'));
  for (const closure of Object.values(current.entries)) {
    assert.ok(closure.by_name.every(name => name.endsWith('.ts') && !name.endsWith('.test.ts')));
  }
});
