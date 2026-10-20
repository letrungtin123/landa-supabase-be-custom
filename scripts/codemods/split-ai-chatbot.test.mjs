// split-ai-chatbot.mjs with a "moves" map, on a scratch git repository: nested
// target folders and every kind of path it rewrites. The run on this
// repository's own tree is tried by split-ai-chatbot.selftest.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { listOrchestrationV2TestFiles } from '../lesson-author-orchestration-v2-test-files.mjs';

const codemod = fileURLToPath(new URL('./split-ai-chatbot.mjs', import.meta.url));
const M = 'src/modules/chatbot/feature';

const FILES = {
  [`${M}/feature-a.logic.ts`]: `import { b } from './feature-b.repository.js';\nexport const a = () => b;\n`,
  [`${M}/feature-b.repository.ts`]: [
    `import type { Db } from '../../../config/db.js';`,
    `export type { A } from './feature-a.types.js';`,
    `export const b = (db?: Db) => db;`,
    `export const lazy = () => import('./feature-a.logic.js');`,
    '',
  ].join('\n'),
  [`${M}/feature-a.types.ts`]: `export type A = string;\n`,
  [`${M}/feature-a.logic.test.ts`]: [
    `import { readFileSync } from 'node:fs';`,
    `import { a } from './feature-a.logic.js';`,
    `const pinned = readFileSync(new URL('./feature-b.repository.ts', import.meta.url), 'utf8');`,
    `const router = readFileSync(new URL('../chatbot.routes.ts', import.meta.url), 'utf8');`,
    `const sibling = new URL('../../../../../other-repo/', import.meta.url);`,
    String.raw`const site = 'D:\\repo\\dist\\modules\\chatbot\\feature\\feature-a.logic.js:3:1';`,
    String.raw`const pattern = /^modules\/chatbot\/feature\/feature-a\.logic\.test\.ts:\d+$/;`,
    `void [a, pinned, router, sibling, site, pattern];`,
    '',
  ].join('\n'),
  [`${M}/feature-v2-steps.test.ts`]: `export {};\n`,
  [`${M}/keep-me.test.ts`]: `import { a } from './feature-a.logic.js';\nvoid a;\n`,
  [`${M}/legacy/old.service.ts`]: `import { a } from '../feature-a.logic.js';\nexport const old = a;\n`,
  'src/modules/chatbot/chatbot.routes.ts': `import { b } from './feature/feature-b.repository.js';\nexport default b;\n`,
  'src/config/db.ts': `export type Db = object;\n`,
  'package.json': JSON.stringify(
    { scripts: { 'test:feature': `tsx --test ${M}/feature-a.logic.test.ts ${M}/keep-me.test.ts` } },
    null,
    2,
  ),
  'eslint-suppressions.json': JSON.stringify(
    { [`${M}/feature-b.repository.ts`]: { rule: { count: 1 } }, 'src/a.ts': { rule: { count: 1 } } },
    null,
    2,
  ),
  'docs/notes.md': `See src/modules/chatbot/feature/feature-a.logic.ts and feature/feature-b.repository.ts; feature/legacy/ stays.\n`,
};

const MAP = {
  module: M,
  folders: { shared: 'base', 'steps/inner': 'nested target' },
  keep: { 'legacy/': 'stays', 'keep-me.test.ts': 'stays' },
  moves: {
    shared: ['feature-a.types.ts', 'feature-b.repository.ts'],
    'steps/inner': ['feature-a.logic.ts', 'feature-a.logic.test.ts', 'feature-v2-steps.test.ts'],
  },
};

function scratchRepo(t, files = FILES, map = MAP) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-codemod-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  fs.writeFileSync(path.join(root, 'moves.json'), JSON.stringify(map));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [codemod, '--root', root, '--map', path.join(root, 'moves.json'), ...args], {
    encoding: 'utf8',
  });
}

const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

test('a moves map moves files into nested folders and rewrites every path to them', t => {
  const root = scratchRepo(t);
  const dry = run(root, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /5 files to move, \d+ files with path rewrites/);
  assert.equal(fs.existsSync(path.join(root, M, 'shared')), false, 'a dry run changes nothing');

  const applied = run(root);
  assert.equal(applied.status, 0, applied.stderr);
  const logic = read(root, `${M}/steps/inner/feature-a.logic.ts`);
  assert.match(logic, /from '\.\.\/\.\.\/shared\/feature-b\.repository\.js'/);
  const repository = read(root, `${M}/shared/feature-b.repository.ts`);
  assert.match(repository, /import type \{ Db \} from '\.\.\/\.\.\/\.\.\/\.\.\/config\/db\.js'/);
  assert.match(repository, /export type \{ A \} from '\.\/feature-a\.types\.js'/);
  assert.match(repository, /import\('\.\.\/steps\/inner\/feature-a\.logic\.js'\)/);
  const moved = read(root, `${M}/steps/inner/feature-a.logic.test.ts`);
  assert.match(moved, /new URL\('\.\.\/\.\.\/shared\/feature-b\.repository\.ts', import\.meta\.url\)/);
  assert.match(moved, /new URL\('\.\.\/\.\.\/\.\.\/chatbot\.routes\.ts', import\.meta\.url\)/);
  assert.match(moved, /new URL\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/other-repo\/', import\.meta\.url\)/);
  // Rooted paths with escaped separators keep their style: a Windows stack line and a regular expression.
  assert.ok(
    moved.includes(String.raw`'D:\\repo\\dist\\modules\\chatbot\\feature\\steps\\inner\\feature-a.logic.js:3:1'`),
  );
  assert.ok(moved.includes(String.raw`/^modules\/chatbot\/feature\/steps\/inner\/feature-a\.logic\.test\.ts:\d+$/`));
  assert.match(read(root, `${M}/keep-me.test.ts`), /from '\.\/steps\/inner\/feature-a\.logic\.js'/);
  assert.match(read(root, `${M}/legacy/old.service.ts`), /from '\.\.\/steps\/inner\/feature-a\.logic\.js'/);
  assert.match(read(root, 'src/modules/chatbot/chatbot.routes.ts'), /'\.\/feature\/shared\/feature-b\.repository\.js'/);
  assert.equal(
    JSON.parse(read(root, 'package.json')).scripts['test:feature'],
    `tsx --test ${M}/steps/inner/feature-a.logic.test.ts ${M}/keep-me.test.ts`,
  );
  assert.deepEqual(Object.keys(JSON.parse(read(root, 'eslint-suppressions.json'))), [
    'src/a.ts',
    `${M}/shared/feature-b.repository.ts`,
  ]);
  assert.equal(
    read(root, 'docs/notes.md'),
    'See src/modules/chatbot/feature/steps/inner/feature-a.logic.ts and feature/shared/feature-b.repository.ts; feature/legacy/ stays.\n',
  );

  const again = run(root, '--dry-run');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /: 0 files to move, 0 files with path rewrites/);
});

test('the V2 suite still finds its test files by name in nested folders', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-codemod-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'src/modules/ai-chatbot/ai-id/orchestration/worker');
  fs.mkdirSync(nested, { recursive: true });
  for (const name of ['lesson-author-orchestration-v2-worker.test.ts', 'lesson-author-idm-x.test.ts', 'other.test.ts'])
    fs.writeFileSync(path.join(nested, name), '');
  const found = (await listOrchestrationV2TestFiles(root)).map(file => path.basename(file));
  assert.deepEqual(found, ['lesson-author-idm-x.test.ts', 'lesson-author-orchestration-v2-worker.test.ts']);
});

test('the run stops before any change on an unplaced name, a missing listed name or an ecosystem file', t => {
  const unplaced = scratchRepo(t, { ...FILES, [`${M}/new-file.ts`]: 'export {};\n' });
  const first = run(unplaced);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /places: new-file\.ts/);
  assert.equal(fs.existsSync(path.join(unplaced, M, 'shared')), false);

  const missing = scratchRepo(t, FILES, {
    ...MAP,
    moves: { ...MAP.moves, shared: [...MAP.moves.shared, 'gone.ts'] },
  });
  const second = run(missing);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /listed but not found: shared\/gone\.ts/);

  const ecosystem = scratchRepo(t, {
    ...FILES,
    'ecosystem.config.cjs': `module.exports = { script: './dist/modules/chatbot/feature/feature-a.logic.js' };\n`,
  });
  const third = run(ecosystem);
  assert.equal(third.status, 1);
  assert.match(third.stderr, /ecosystem files are not edited/);
  assert.equal(fs.existsSync(path.join(ecosystem, M, 'shared')), false);
});
