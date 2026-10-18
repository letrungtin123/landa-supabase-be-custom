// npm test: every test:* script of package.json except the database suites,
// one after another, then one summary line per suite. Exits 1 when a suite
// fails, or when a test file belongs to no suite.
//
// - The test:* scripts are the only list of suites. A new test file goes into
//   the script of its module (or a new test:<module> script); a file that no
//   script runs fails this command.
// - Database suites need a disposable database and an explicit opt-in. They
//   run with `npm run test:integration`, never here.
// - Every service URL points at a closed loopback port, whatever .env says,
//   so no suite reaches a real database, Redis, RabbitMQ, Storage or AI
//   service. NODE_ENV is "test" unless set; "production" is refused (env.ts
//   would load .env.production).
//
// Usage: npm test                     every suite
//        npm test -- test:news ...    only these suites
//        npm test -- --list           the suites, without running them
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { listOrchestrationV2TestFiles } from './lesson-author-orchestration-v2-test-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DATABASE_SUITES = new Set([
  'test:integration',
  'test:tenant-data-quota:integration',
  'test:course-publish-governance:acceptance',
]);

// Suites whose test files a script chooses instead of package.json listing them.
const SCRIPTED_SUITES = {
  'test:lesson-author-orchestration-v2': listOrchestrationV2TestFiles,
};

const TEST_FILE = /\.test\.(?:ts|mjs|cjs|js)$/;
const TEST_DIRECTORIES = ['src', 'scripts'];

const CLOSED_PORT = '127.0.0.1:1';
const SERVICE_ENV = {
  DATABASE_URL: `postgresql://test:test@${CLOSED_PORT}/test`,
  DATABASE_POOLER_URL: '',
  REDIS_URL: `redis://${CLOSED_PORT}`,
  RABBITMQ_URL: `amqp://test:test@${CLOSED_PORT}`,
  SUPABASE_URL: `http://${CLOSED_PORT}`,
  AI_RAG_SERVICE_URL: `http://${CLOSED_PORT}`,
};

function fail(message) {
  console.error(`[run-tests] ${message}`);
  process.exit(1);
}

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function listTestFiles(directory) {
  const files = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...listTestFiles(relative));
    } else if (TEST_FILE.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

/** The test files each non-database test:* script runs, by suite name. */
async function readSuites() {
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
  const suites = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith('test:') || DATABASE_SUITES.has(name)) continue;
    const scripted = SCRIPTED_SUITES[name];
    const files = scripted
      ? (await scripted(root)).map(file => toPosix(path.relative(root, file)))
      : command.split(/\s+/).filter(token => TEST_FILE.test(token));
    suites.set(name, files);
  }
  return suites;
}

function checkEnvironment() {
  const nodeEnv = process.env.NODE_ENV?.trim() || 'test';
  if (nodeEnv === 'production') {
    fail('NODE_ENV=production would load .env.production; run the tests with NODE_ENV=test.');
  }
  // env.ts loads .env.development.local over everything else when NODE_ENV is not production.
  const localOverrides = path.join(root, '.env.development.local');
  if (existsSync(localOverrides)) {
    const overridden = Object.keys(parseDotenv(readFileSync(localOverrides))).filter(key => key in SERVICE_ENV);
    if (overridden.length > 0) {
      fail(`.env.development.local sets ${overridden.join(', ')}, which would point the tests at a real service.`);
    }
  }
  return { ...process.env, ...SERVICE_ENV, NODE_ENV: nodeEnv };
}

function npmRun(name, env) {
  const npmCli = process.env.npm_execpath;
  const options = { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] };
  if (npmCli && /\.c?js$/.test(npmCli)) return spawn(process.execPath, [npmCli, 'run', name], options);
  return spawn(`npm run ${name}`, { ...options, shell: true });
}

/** Runs one suite, streaming its output, and reads the counts of the node:test summary (spec or TAP). */
function runSuite(name, env) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = npmRun(name, env);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', chunk => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', error => {
      console.error(`[run-tests] ${name} could not start:`, error);
    });
    child.once('close', (code, signal) => {
      const counts = {};
      for (const match of output.matchAll(/^(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
        counts[match[1]] = (counts[match[1]] ?? 0) + Number(match[2]);
      }
      resolve({
        name,
        ok: code === 0 && !signal,
        code: signal ?? code,
        counts,
        seconds: (Date.now() - started) / 1000,
      });
    });
  });
}

function printSummary(results) {
  const columns = ['tests', 'pass', 'fail', 'cancelled', 'skipped'];
  const width = Math.max(...results.map(result => result.name.length), 5);
  const line = cells => cells.map((cell, index) => (index === 0 ? cell.padEnd(width) : cell.padStart(9))).join('  ');
  console.log('\nTest summary (npm test)');
  console.log(line(['suite', 'result', ...columns, 'seconds']));
  const total = Object.fromEntries(columns.map(column => [column, 0]));
  for (const result of results) {
    for (const column of columns) total[column] += result.counts[column] ?? 0;
    const counts = columns.map(column => String(result.counts[column] ?? '?'));
    console.log(line([result.name, result.ok ? 'ok' : `FAIL(${result.code})`, ...counts, result.seconds.toFixed(1)]));
  }
  const failed = results.filter(result => !result.ok).length;
  const seconds = results.reduce((sum, result) => sum + result.seconds, 0);
  const totals = columns.map(column => String(total[column]));
  console.log(line([`${results.length} suites`, failed ? `${failed} FAIL` : 'ok', ...totals, seconds.toFixed(1)]));
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const requested = args.filter(arg => arg !== '--list');

const suites = await readSuites();
const covered = new Set([...suites.values()].flat());
const orphans = TEST_DIRECTORIES.flatMap(listTestFiles).filter(file => !covered.has(file));
const missing = [...suites].flatMap(([name, files]) =>
  files.filter(file => !existsSync(path.join(root, file))).map(file => `${name}: ${file}`),
);

if (listOnly) {
  for (const [name, files] of suites) console.log(`${name} (${files.length} files)`);
  for (const name of DATABASE_SUITES) console.log(`${name} (database, npm run test:integration)`);
}
if (orphans.length > 0) {
  console.error(`[run-tests] ${orphans.length} test files belong to no test:* script:\n  ${orphans.join('\n  ')}`);
}
if (missing.length > 0) console.error(`[run-tests] test:* scripts list missing files:\n  ${missing.join('\n  ')}`);
if (listOnly) process.exit(orphans.length > 0 || missing.length > 0 ? 1 : 0);

const unknown = requested.filter(name => !suites.has(name));
if (unknown.length > 0) fail(`unknown or database suites: ${unknown.join(', ')}`);
const selected = requested.length > 0 ? requested : [...suites.keys()];
if (selected.length === 0) fail('no test:* scripts found in package.json');

const env = checkEnvironment();
console.log(`[run-tests] ${selected.length} suites; NODE_ENV=${env.NODE_ENV}; service URLs on ${CLOSED_PORT} (closed)`);
const results = [];
for (const name of selected) {
  console.log(`\n[run-tests] ${name}`);
  results.push(await runSuite(name, env));
}
printSummary(results);
if (orphans.length > 0) {
  console.error(`[run-tests] FAIL: ${orphans.length} test files belong to no test:* script (see above).`);
}
if (missing.length > 0) {
  console.error(`[run-tests] FAIL: ${missing.length} listed test files do not exist (see above).`);
}
process.exitCode = results.every(result => result.ok) && orphans.length === 0 && missing.length === 0 ? 0 : 1;
