# Codemods

Move-only restructuring of a module folder: files move into sub-folders, file names stay, and every path that names a
moved file is rewritten. No other code changes.

| File                            | What                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `split-ai-chatbot.mjs`          | The codemod (CLI). Default map: `split-ai-chatbot.map.json` (the done split of `ai-chatbot`). |
| `path-moves.mjs`                | The path rewriting it uses.                                                                   |
| `split-ai-chatbot.map.json`     | Rules map: each name directly under `src/modules/ai-chatbot` goes to the first matching rule. |
| `ai-id-moves.json`              | Moves map (applied): every file of `src/modules/ai-chatbot/ai-id` per folder.                 |
| `split-ai-chatbot.selftest.mjs` | Runs a map on a throwaway copy of the repository and checks the result there.                 |
| `split-ai-chatbot.test.mjs`     | Tests of the codemod on a scratch repository (suite `test:ai-id-structure`).                  |

## Usage

```sh
node scripts/codemods/split-ai-chatbot.mjs --map scripts/codemods/ai-id-moves.json --dry-run [--list]  # the plan
node scripts/codemods/split-ai-chatbot.selftest.mjs --map scripts/codemods/ai-id-moves.json [--full]   # on a copy
node scripts/codemods/split-ai-chatbot.mjs --map scripts/codemods/ai-id-moves.json                     # apply
```

The dry run prints how many files move, per folder, and the path edits by kind (import/export specifiers,
`new URL(…, import.meta.url)` pins, other relative strings, rooted or short paths in text). The self-test copies the
tracked and untracked (not ignored) files, applies the map with `git mv` in a fresh repository, checks that a second
run changes nothing, then runs `tsc --noEmit`, eslint, `prettier --check`, `npm test -- --list` and the
`test:ai-id-structure` suite (with `--full`: every suite), with `LANDA_REQUIRE_CROSS_LANGUAGE=1` when `../landa-ai-rag`
is there. The real tree is not touched.

## What is rewritten

- Relative paths in code: `import`/`export … from`, `import()`, `import x = require()`, `require()`, `import('…')`
  types, `new URL('./x', import.meta.url)` and any other string literal that resolves to a tracked file. Paths inside a
  moved file are re-based to its new folder; a moved file's path to something git does not track (the sibling
  `../landa-ai-rag`) keeps pointing at the same place.
- Rooted paths in any text file: `src/modules/…/x.ts`, `dist/modules/…/x.js`, `modules/…/x.ts` (package.json test
  lists, `eslint-suppressions.json` keys, which are sorted again, docs, comments, goldens), the short form `ai-id/x.ts`,
  and the escaped forms of test data (`'dist\\modules\\…\\x.js'` in a string, `/modules\/…\/x\.ts/` in a regular
  expression), which keep their style.
- Not rewritten: paths built from pieces (`path.join(dir, 'x.ts')`, template literals with `${…}`). A file next to its
  test (`*.golden.json`) moves with it, so such paths stay valid. `ecosystem*.cjs` files are never edited; a plan that
  would need it stops.

The run stops before any change when a name directly under the module is in no list (add it to the map), when a listed
name exists nowhere, or when a move would overwrite a file.

## AI ID layout and layering rule (`ai-id-moves.json`)

Folders, lowest first, with the folders each may import (and, through them, everything those may import), as
`AI_ID_LAYERS` in `src/modules/ai-chatbot/ai-id/ai-id-layers.test.ts` says; never the other way:

```text
shared
contracts                 shared
content                   contracts
sessions                  contracts
sources                   sessions
orchestration             contracts            (files directly in orchestration/: the V2 run model)
orchestration/idm         orchestration, content
orchestration/steps       orchestration/idm
orchestration/finalize    orchestration/steps
orchestration/dispatch    orchestration
orchestration/worker      orchestration/finalize, orchestration/dispatch
orchestration/admission   orchestration
workspace/read            orchestration/steps
workspace/stream          workspace/read
workspace/edit            workspace/read
workspace/apply           workspace/edit, sessions
workspace/launch          workspace/edit, orchestration/admission
orchestration/recovery    orchestration/worker, workspace/edit, sessions
v1                        workspace/edit
legacy                    v1
```

- Nothing imports `legacy/` (V1 code; V2 reaches it only through `chat/chat.service.ts`). `legacy/` does not move.
- Only value imports are checked; `import type` / `export type` are erased at compile time. Tests and `*.fixture.ts`
  may import any folder.
- No `index.ts` barrels: every file is imported by its own path.
- `ai-id-layers.test.ts` passes without checking the folders while `ai-id/` is flat, and enforces the rule once the
  folders exist (it did on the self-test copy).

## Before applying `ai-id-moves.json`

1. Merge the branches that change `ai-id/` first; a new file must be added to the map (the run stops otherwise).
2. Dry run and `split-ai-chatbot.selftest.mjs --full` on the merged tree.
3. Apply, then `npx tsc --noEmit -p tsconfig.json`, `npm run lint`, `npm run format:check`, `npm test` with
   `LANDA_REQUIRE_CROSS_LANGUAGE=1` (no cross-language test may skip). The route table golden must stay unchanged; the
   import closure golden keeps its file names (its paths are rewritten by the codemod).
4. Other repositories: `landa-ai-rag` `tests/unit/legacy/test_instructional_opportunities.py` finds the backend files in
   every planned folder; fe-5173 `CrosswordContent.test.mjs` reads `ai-id/legacy/`, which does not move.
