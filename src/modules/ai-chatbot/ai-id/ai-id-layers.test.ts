import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createModuleResolver, parseModule } from '../../../test-support/import-closure.js';

// Import direction of the AI ID folders (src/modules/ai-chatbot/ai-id), for
// the folder layout of scripts/codemods/ai-id-moves.json.
//
// Each folder may import its own files and the folders below it: the ones it
// lists here and, through them, everything those may import. Nothing may
// import legacy/ (the V1 code that V2 still reaches only through
// chat/chat.service.ts). Files directly in orchestration/ are the V2 run model
// its sub-folders share. The rule checks value imports; type-only imports
// (`import type`, `export type`) are erased at compile time and are not
// checked. Tests (*.test.ts) and fixtures (*.fixture.ts) may import any folder.
//
// While the folder is still flat (none of these folders but legacy/ exists),
// only the rules that hold for any layout are checked: no index.ts barrel and
// an acyclic rule. Once the folders exist, every file must sit in one of them
// (or be one of the ROOT_FILES) and every value import must follow the rule.

/** Folder → the folders it may import directly (transitively: their allowed folders too). */
const AI_ID_LAYERS: Readonly<Record<string, readonly string[]>> = {
  shared: [],
  contracts: ['shared'],
  content: ['contracts'],
  sessions: ['contracts'],
  orchestration: ['contracts'],
  'orchestration/idm': ['orchestration', 'content'],
  'orchestration/steps': ['orchestration/idm'],
  'orchestration/finalize': ['orchestration/steps'],
  'orchestration/dispatch': ['orchestration'],
  'orchestration/worker': ['orchestration/finalize', 'orchestration/dispatch'],
  'orchestration/admission': ['orchestration'],
  sources: ['sessions'],
  // Organization context: tenant-wide context files and the organization profile (routes, worker); the
  // V2 launch reaches it only through injected functions.
  'org-context': ['sessions', 'orchestration'],
  'workspace/read': ['orchestration/steps'],
  'workspace/stream': ['workspace/read'],
  'workspace/edit': ['workspace/read'],
  'workspace/apply': ['workspace/edit', 'sessions'],
  'workspace/launch': ['workspace/edit', 'orchestration/admission'],
  'orchestration/recovery': ['orchestration/worker', 'workspace/edit', 'sessions'],
  v1: ['workspace/edit'],
  legacy: ['v1'],
};

/** Files that stay directly in ai-id/: these structure tests and their golden. */
const ROOT_FILES = new Set([
  'ai-id-layers.test.ts',
  'ai-id-import-closure.golden.test.ts',
  'ai-id-import-closure.golden.json',
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../..');
const REPO = path.resolve(SRC, '..');
const posix = (file: string) => file.split(path.sep).join('/');

/** Every folder each folder may import, itself included. Throws on an unknown folder or a cycle. */
function allowedFolders(layers: Readonly<Record<string, readonly string[]>>): Map<string, Set<string>> {
  const allowed = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visit = (folder: string): Set<string> => {
    const known = allowed.get(folder);
    if (known) return known;
    if (!(folder in layers)) throw new Error(`unknown folder ${folder}`);
    if (visiting.has(folder)) throw new Error(`the layer rule has a cycle through ${folder}`);
    visiting.add(folder);
    const result = new Set([folder]);
    for (const base of layers[folder]) for (const item of visit(base)) result.add(item);
    visiting.delete(folder);
    allowed.set(folder, result);
    return result;
  };
  for (const folder of Object.keys(layers)) visit(folder);
  return allowed;
}

interface AiIdImport {
  /** Importing file, relative to ai-id/ (posix). */
  from: string;
  /** Imported file, relative to ai-id/ (posix). */
  to: string;
  typeOnly: boolean;
}

const isTestCode = (file: string) => /\.(test|fixture)\.ts$/.test(file);

/** The folder of a file relative to ai-id/ ('' for a file directly in ai-id/). */
function folderOf(file: string): string {
  const folder = path.posix.dirname(file);
  return folder === '.' ? '' : folder;
}

/** Imports that break the rule: a value import from production code into a folder its own may not import. */
function layerViolations(
  imports: readonly AiIdImport[],
  layers: Readonly<Record<string, readonly string[]>> = AI_ID_LAYERS,
): string[] {
  const allowed = allowedFolders(layers);
  return imports
    .filter(item => !item.typeOnly && !isTestCode(item.from))
    .filter(item => {
      const from = folderOf(item.from);
      const to = folderOf(item.to);
      return from !== to && !allowed.get(from)?.has(to);
    })
    .map(item => `${item.from} -> ${item.to}`);
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function aiIdFiles(): string[] {
  return listFiles(here).map(file => posix(path.relative(here, file)));
}

/** The value and type imports between ai-id files. */
function aiIdImports(files: readonly string[]): AiIdImport[] {
  const resolver = createModuleResolver(path.join(REPO, 'tsconfig.json'), SRC);
  const imports: AiIdImport[] = [];
  for (const file of files.filter(name => name.endsWith('.ts'))) {
    const absolute = path.join(here, file);
    for (const item of parseModule(absolute).imports) {
      const target = resolver.resolve(item.specifier, absolute);
      if (!target || !target.startsWith(here + path.sep)) continue;
      imports.push({ from: file, to: posix(path.relative(here, target)), typeOnly: item.typeOnly });
    }
  }
  return imports;
}

/** Folders of the layout (legacy/ exists in both layouts and does not count). */
function layoutIsFoldered(files: readonly string[]): boolean {
  return files.some(file => {
    const folder = folderOf(file);
    return folder !== '' && folder !== 'legacy' && !folder.startsWith('legacy/');
  });
}

test('the layer rule is acyclic and names known folders only', () => {
  const allowed = allowedFolders(AI_ID_LAYERS);
  assert.equal(allowed.size, Object.keys(AI_ID_LAYERS).length);
  for (const [folder, folders] of allowed) {
    if (folder !== 'legacy') assert.ok(!folders.has('legacy'), `${folder} may not import legacy/`);
  }
});

test('the rule finds a value import against the direction and ignores type-only imports and tests', () => {
  const imports: AiIdImport[] = [
    { from: 'content/a.logic.ts', to: 'shared/b.logic.ts', typeOnly: false },
    { from: 'shared/b.logic.ts', to: 'content/a.logic.ts', typeOnly: false },
    { from: 'orchestration/steps/c.repository.ts', to: 'orchestration/worker/d.repository.ts', typeOnly: true },
    { from: 'orchestration/worker/d.repository.ts', to: 'orchestration/steps/c.repository.ts', typeOnly: false },
    { from: 'shared/e.test.ts', to: 'v1/f.service.ts', typeOnly: false },
    { from: 'v1/f.service.ts', to: 'legacy/g.service.ts', typeOnly: false },
    { from: 'legacy/g.service.ts', to: 'content/a.logic.ts', typeOnly: false },
  ];
  assert.deepEqual(layerViolations(imports), ['shared/b.logic.ts -> content/a.logic.ts', 'v1/f.service.ts -> legacy/g.service.ts']);
});

test('ai-id has no index.ts barrel', () => {
  const barrels = aiIdFiles().filter(file => /^index\.(ts|js|mts|cts)$/.test(path.posix.basename(file)));
  assert.deepEqual(barrels, [], 'import each file by its own path; an index.ts barrel hides the import direction');
});

test('ai-id imports follow the layer rule (enforced once the folders exist)', t => {
  const files = aiIdFiles();
  if (!layoutIsFoldered(files)) {
    t.diagnostic('ai-id is still flat: the folder rules apply after the move of scripts/codemods/ai-id-moves.json');
    return;
  }
  const outside = files.filter(file => {
    const folder = folderOf(file);
    return folder === '' ? !ROOT_FILES.has(file) : !(folder in AI_ID_LAYERS) && !folder.startsWith('legacy/');
  });
  assert.deepEqual(outside, [], 'every ai-id file sits in a folder of AI_ID_LAYERS (or is one of ROOT_FILES)');
  assert.deepEqual(layerViolations(aiIdImports(files)), [], 'value imports against the folder direction');
});
