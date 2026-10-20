// Runs split-ai-chatbot.mjs with a map on a throwaway copy of this repository
// and checks the result there; the real tree is never changed.
//
//   node scripts/codemods/split-ai-chatbot.selftest.mjs --map scripts/codemods/ai-id-moves.json
//     [--tmp <folder>]   where the copy goes (default: the OS temp folder)
//     [--full]           run every suite (npm test) instead of the structure suite only
//     [--keep]           leave the copy for inspection
//
// The copy holds the files git tracks plus the untracked ones it does not
// ignore (so uncommitted work is tried too), .env from .env.example (as CI
// does), and links to this repository's node_modules and, when they are next
// to it, ../landa-ai-rag and ../supabase. Then, in the copy:
//  1. the codemod moves the files and rewrites the paths (git mv in a fresh repo);
//  2. a second run must find nothing to do;
//  3. tsc --noEmit, eslint, prettier --check, `npm test -- --list` (every test
//     file in a suite, no listed file missing), and the test suites: the
//     structure suite (route table and import closure goldens, the folder
//     rule, now enforcing), or with --full all of them. With ../landa-ai-rag
//     present, LANDA_REQUIRE_CROSS_LANGUAGE=1 makes a cross-language test that
//     cannot find it fail instead of skip.
// Exit code 0 only when every step passed. The links are removed before the
// copy is deleted, so nothing is deleted through them.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = name => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const mapArgument = option('--map');
if (!mapArgument) {
  console.error('[selftest] --map <file> is required');
  process.exit(2);
}
const mapRelative = path.relative(repoRoot, path.resolve(mapArgument)).split(path.sep).join('/');
if (mapRelative.startsWith('..')) {
  console.error('[selftest] the map must be a file of this repository (it is copied with it)');
  process.exit(2);
}
const full = argv.includes('--full');
const keepCopy = argv.includes('--keep');

// The test environment of CI (.github/workflows/ci.yml): every service on a closed port.
const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:1/ci',
  REDIS_URL: 'redis://127.0.0.1:1',
  RABBITMQ_URL: 'amqp://ci:ci@127.0.0.1:1',
  SUPABASE_URL: 'http://127.0.0.1:1',
  AI_RAG_SERVICE_URL: 'http://127.0.0.1:1',
  SUPABASE_SERVICE_KEY: 'ci-placeholder-not-a-key',
  JWT_SECRET: 'ci-placeholder-not-a-secret',
  CORS_ORIGIN: 'http://localhost:5274',
};

// Short names: the moved paths are deep, and Windows git refuses paths over 260 characters without core.longpaths.
const tmp = fs.mkdtempSync(path.join(path.resolve(option('--tmp') ?? os.tmpdir()), 'st-'));
const copy = path.join(tmp, 'be');
const links = [];
const results = [];

function link(target, at) {
  fs.symlinkSync(fs.realpathSync(target), at, 'junction');
  links.push(at);
}

function removeLinks() {
  for (const at of links) {
    if (!fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
    try {
      fs.unlinkSync(at);
    } catch {
      fs.rmdirSync(at);
    }
    if (fs.lstatSync(at, { throwIfNoEntry: false })) throw new Error(`could not remove the link ${at}`);
  }
}

/** Any link left under `folder` (the copy is deleted only without one). */
function findLinks(folder) {
  const found = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) found.push(full);
    else if (entry.isDirectory()) found.push(...findLinks(full));
  }
  return found;
}

function step(name, command, args, options = {}) {
  console.log(`\n[selftest] ${name}: ${[command, ...args].join(' ')}`);
  const started = Date.now();
  const run = spawnSync(command, args, {
    cwd: copy,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: options.shell ?? false,
    env: { ...process.env, ...TEST_ENV, ...(options.env ?? {}) },
    maxBuffer: 256 * 1024 * 1024,
  });
  const ok = run.status === 0 && (!options.check || options.check(run.stdout ?? ''));
  if (options.capture) process.stdout.write(run.stdout ?? '');
  if (options.capture) process.stderr.write(run.stderr ?? '');
  results.push({ name, ok, seconds: (Date.now() - started) / 1000 });
  return run;
}

try {
  // ── The copy ───────────────────────────────────────────────────────────
  const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
  for (const file of new Set(files)) {
    const from = path.join(repoRoot, file);
    const stat = fs.lstatSync(from, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    fs.copyFileSync(from, path.join(copy, file));
  }
  fs.copyFileSync(path.join(repoRoot, '.env.example'), path.join(copy, '.env'));
  const gitInCopy = (...args) =>
    execFileSync('git', ['-c', 'user.name=selftest', '-c', 'user.email=selftest@invalid', ...args], {
      cwd: copy,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  // Committed before the links exist, so git never sees them.
  gitInCopy('init', '-q');
  gitInCopy('config', 'core.longpaths', 'true');
  gitInCopy('add', '-A');
  gitInCopy('commit', '-q', '-m', 'before the move');
  link(path.join(repoRoot, 'node_modules'), path.join(copy, 'node_modules'));
  const siblings = {};
  for (const sibling of ['landa-ai-rag', 'supabase']) {
    const target = path.resolve(repoRoot, '..', sibling);
    siblings[sibling] = fs.existsSync(target);
    if (siblings[sibling]) link(target, path.join(tmp, sibling));
  }
  console.log(`[selftest] copy of ${files.length} files at ${copy}; siblings: ${JSON.stringify(siblings)}`);

  // ── The codemod ────────────────────────────────────────────────────────
  const codemod = path.join('scripts', 'codemods', 'split-ai-chatbot.mjs');
  step('codemod', process.execPath, [codemod, '--map', mapRelative]);
  step('second run changes nothing', process.execPath, [codemod, '--map', mapRelative, '--dry-run'], {
    capture: true,
    check: out => /: 0 files to move, 0 files with path rewrites/.test(out),
  });
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: copy, encoding: 'utf8' });
  console.log(`[selftest] git status: ${status.split('\n').filter(line => line.startsWith('R')).length} renames`);

  // ── Checks ─────────────────────────────────────────────────────────────
  const bin = (...parts) => path.join(copy, 'node_modules', ...parts);
  step('tsc', process.execPath, [bin('typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json']);
  step('eslint', process.execPath, [bin('eslint', 'bin', 'eslint.js')]);
  step('prettier', process.execPath, [bin('prettier', 'bin', 'prettier.cjs'), '--check', '.']);
  step('every test file in a suite', process.execPath, [path.join('scripts', 'run-tests.mjs'), '--list'], {
    capture: true,
  });
  const crossLanguage = siblings['landa-ai-rag'] ? { LANDA_REQUIRE_CROSS_LANGUAGE: '1' } : {};
  step(
    full ? 'npm test' : 'structure suite',
    process.execPath,
    [path.join('scripts', 'run-tests.mjs'), ...(full ? [] : ['test:ai-id-structure'])],
    { env: crossLanguage },
  );
} catch (error) {
  console.error('[selftest] stopped:', error, error?.stderr?.toString() ?? '');
  results.push({ name: 'setup', ok: false, seconds: 0 });
} finally {
  console.log('\n[selftest] summary');
  for (const result of results)
    console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.seconds.toFixed(1)} s)`);
  removeLinks();
  if (keepCopy) {
    console.log(`[selftest] copy kept at ${copy} (its node_modules link was removed)`);
  } else {
    const left = findLinks(tmp);
    if (left.length > 0) console.error(`[selftest] links left, copy not deleted: ${left.join(', ')}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exitCode = results.length > 0 && results.every(result => result.ok) ? 0 : 1;
}
