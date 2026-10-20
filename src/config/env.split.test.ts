// Characterization test of src/config/env.ts.
//
// env/__snapshots__/env-characterization.json was recorded from the one-file
// env.ts, before it was split into env/*.ts. Each scenario loads env.ts in a
// fresh module graph, in a worker thread of a child process whose environment
// holds only operating-system essentials (PATH, TEMP...) plus the scenario's
// keys. dotenv's config() is replaced by a stub before env.ts is imported, so
// no .env file (the developer's own, or .env.example in CI) adds values.
// The host strips the types once (Node's own type stripping) and the workers
// run that JavaScript, which keeps 250 fresh module graphs fast; a few
// scenarios run again in child processes under tsx, as the app runs, and the
// scenarios that end the process (missing env file) run that way only.
//
// The type check at the end makes `npx tsc --noEmit` fail when the type of
// `env` changes (a key, a value type or readonly-ness).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { env } from './env.js';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SNAPSHOT_PATH = path.join(ROOT, 'src', 'config', 'env', '__snapshots__', 'env-characterization.json');

type EnvMap = Record<string, string>;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Scenario {
  name: string;
  base: 'required' | 'empty';
  unset?: string[];
  set?: EnvMap;
  expect: JsonObject;
}

interface Snapshot {
  required: EnvMap;
  scenarios: Scenario[];
  exitScenarios: Scenario[];
}

/** Operating-system variables a child process needs (Windows and Linux); never an application key. */
const ESSENTIAL_ENV = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOME',
]);

function essentialEnv(): EnvMap {
  const out: EnvMap = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ESSENTIAL_ENV.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

function scenarioEnv(snapshot: Snapshot, scenario: Scenario): EnvMap {
  const keys: EnvMap = scenario.base === 'required' ? { ...snapshot.required } : {};
  for (const key of scenario.unset ?? []) delete keys[key];
  Object.assign(keys, scenario.set ?? {});
  return { ...essentialEnv(), ...keys };
}

/**
 * Loads env.ts once and reports what it saw: in a worker thread of the scenario
 * host (rootDir from workerData), or in a child process started with
 * --import tsx (rootDir from argv).
 */
const SCENARIO_SOURCE = `
import * as nodeModule from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';

const inWorker = parentPort !== null;
const rootDir = inWorker ? workerData.rootDir : process.argv[1];
if (inWorker) {
  // No tsx here. './x.js' in a .ts file means './x.ts' (NodeNext); the host
  // already stripped the types of those files (workerData.sources by URL).
  const { sources } = workerData;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && specifier.endsWith('.js') && context.parentURL && context.parentURL.endsWith('.ts')) {
        const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (Object.hasOwn(sources, url)) return { format: 'module', source: sources[url], shortCircuit: true };
      return nextLoad(url, context);
    },
  });
}
const logs = [];
const dotenvCalls = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => logs.push(level + ': ' + format(...args));
}
const dotenv = nodeModule.createRequire(path.join(rootDir, 'package.json'))('dotenv');
dotenv.config = (options) => {
  dotenvCalls.push(options);
  return { parsed: {} };
};
let result;
try {
  const mod = await import(pathToFileURL(path.join(rootDir, 'src', 'config', 'env.ts')).href);
  const env = mod.env;
  const values = JSON.parse(JSON.stringify(env));
  const shape = { accessors: [], readOnly: [], hidden: [], nonConfigurable: [] };
  for (const key of Reflect.ownKeys(env)) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    const accessor = descriptor.set ? ' (get, set)' : ' (get)';
    if (descriptor.get || descriptor.set) shape.accessors.push(String(key) + accessor);
    else if (!descriptor.writable) shape.readOnly.push(String(key));
    if (!descriptor.enumerable) shape.hidden.push(String(key));
    if (!descriptor.configurable) shape.nonConfigurable.push(String(key));
  }
  shape.frozen = Object.isFrozen(env);
  shape.plainObject = Object.getPrototypeOf(env) === Object.prototype;
  const nodeEnv = env.NODE_ENV;
  env.NODE_ENV = 'production';
  const whenProduction = env.isProduction;
  env.NODE_ENV = 'staging';
  const whenStaging = env.isProduction;
  env.NODE_ENV = nodeEnv;
  result = {
    exports: Object.keys(mod).sort(),
    keys: Object.keys(env),
    values,
    shape,
    isProductionTracksNodeEnv: [whenProduction, whenStaging],
  };
} catch (error) {
  result = { error: error instanceof Error ? error.name + ': ' + error.message : 'thrown: ' + String(error) };
}
const report = { logs, dotenvCalls, ...result };
if (inWorker) parentPort.postMessage(report);
else process.stdout.write('\\n@@RESULT ' + JSON.stringify(report) + '\\n');
`;

/**
 * Child process: strips the types of env.ts and the .ts files it imports once
 * (Node's own type stripping), then runs every scenario environment in its own
 * worker thread, a few at a time.
 */
const HOST_SOURCE = `
import { existsSync, readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { rootDir, scenarioSource, envs } = JSON.parse(input);

const sources = {};
const pending = [pathToFileURL(path.join(rootDir, 'src', 'config', 'env.ts')).href];
const relativeImport = /(?:from|import) *['"]([.][.]?[/][^'"]+)[.]js['"]/g;
while (pending.length > 0) {
  const url = pending.pop();
  if (Object.hasOwn(sources, url) || !existsSync(fileURLToPath(url))) continue;
  sources[url] = nodeModule.stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'));
  for (const match of sources[url].matchAll(relativeImport)) pending.push(new URL(match[1] + '.ts', url).href);
}

const scenarioUrl = new URL('data:text/javascript,' + encodeURIComponent(scenarioSource));
const results = new Array(envs.length);
let next = 0;
const runOne = (env) =>
  new Promise((resolve) => {
    let message;
    const worker = new Worker(scenarioUrl, { env, workerData: { rootDir, sources }, execArgv: [] });
    worker.on('message', (value) => { message = value; });
    worker.on('error', (error) => { message = { crashed: String((error && error.stack) || error) }; });
    worker.on('exit', (code) => resolve(message ?? { crashed: 'worker exited with code ' + code }));
  });
const lane = async () => {
  while (next < envs.length) {
    const index = next++;
    results[index] = await runOne(envs[index]);
  }
};
await Promise.all(Array.from({ length: Math.max(2, Math.min(16, availableParallelism())) }, lane));
process.stdout.write('\\n@@RESULTS ' + JSON.stringify(results) + '\\n');
`;

/** Child process (--import tsx) for a scenario that ends the process: dotenv reports a missing file. */
const MISSING_FILE_SOURCE = `
import { createRequire } from 'node:module';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = process.argv[1];
const mark = (tag, value) => writeSync(1, '\\n@@' + tag + ' ' + JSON.stringify(value) + '\\n');
const dotenv = createRequire(path.join(rootDir, 'package.json'))('dotenv');
dotenv.config = (options) => {
  mark('DOTENV', options);
  return { error: new Error('stub: the file does not exist') };
};
try {
  await import(pathToFileURL(path.join(rootDir, 'src', 'config', 'env.ts')).href);
  mark('IMPORTED', true);
} catch (error) {
  mark('THREW', String(error && error.message));
}
`;

interface NodeRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNode(nodeArgs: string[], childEnv: EnvMap, stdin = ''): Promise<NodeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, { cwd: ROOT, env: childEnv, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const tsxArgs = (source: string) => ['--import', 'tsx', '--input-type=module', '-e', source, ROOT];

function normalizeText(text: string): string {
  return text.split(ROOT).join('<ROOT>').replace(/\\/g, '/');
}

/** `{ path, ...options }` of a dotenv.config() call as one line: the path, then any other option. */
function describeDotenvCall(options: Json): string {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return JSON.stringify(options);
  const { path: filePath, ...rest } = options;
  const extra = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
  return normalizeText(String(filePath)) + extra;
}

function resultLine(stdout: string, tag: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .find(line => line.startsWith(tag))
    ?.slice(tag.length);
}

async function runWorkerScenarios(envs: EnvMap[]): Promise<JsonObject[]> {
  const input = JSON.stringify({ rootDir: ROOT, scenarioSource: SCENARIO_SOURCE, envs });
  const run = await runNode(['--input-type=module', '-e', HOST_SOURCE], essentialEnv(), input);
  const line = resultLine(run.stdout, '@@RESULTS ');
  assert.ok(line, `the scenario host printed no results (exit ${run.code}):\n${run.stderr}`);
  return JSON.parse(line) as JsonObject[];
}

async function runTsxScenario(childEnv: EnvMap): Promise<JsonObject> {
  const run = await runNode(tsxArgs(SCENARIO_SOURCE), childEnv);
  const line = resultLine(run.stdout, '@@RESULT ');
  assert.ok(line, `the tsx scenario printed no result (exit ${run.code}):\n${run.stderr}`);
  return JSON.parse(line) as JsonObject;
}

/**
 * What a scenario is compared on. Value scenarios other than values/minimal
 * list only the values that differ from it.
 */
function summarize(raw: JsonObject, minimal: JsonObject | null): JsonObject {
  const logs = (raw.logs as string[]).filter(line => !/^\w+: \(node:\d+\)/.test(line)).map(normalizeText);
  const summary: JsonObject = { logs, dotenvCalls: (raw.dotenvCalls as Json[]).map(describeDotenvCall) };
  if (raw.crashed !== undefined) return { ...summary, crashed: raw.crashed };
  if (raw.error !== undefined) return { ...summary, error: raw.error };
  const sortedKeys = [...(raw.keys as string[])].sort();
  const values = raw.values as JsonObject;
  if (minimal) {
    const minimalValues = minimal.values as JsonObject;
    const changed: JsonObject = {};
    for (const key of sortedKeys) {
      if (JSON.stringify(values[key]) !== JSON.stringify(minimalValues[key])) changed[key] = values[key];
    }
    summary.keys = JSON.stringify(sortedKeys) === JSON.stringify(minimal.keys) ? 'same as values/minimal' : sortedKeys;
    summary.valuesChangedFromMinimal = changed;
  } else {
    summary.keys = sortedKeys;
    summary.values = Object.fromEntries(sortedKeys.map(key => [key, values[key]]));
  }
  return {
    ...summary,
    exports: raw.exports,
    shape: raw.shape,
    isProductionTracksNodeEnv: raw.isProductionTracksNodeEnv,
  };
}

async function runMissingFileScenario(snapshot: Snapshot, scenario: Scenario): Promise<JsonObject> {
  const run = await runNode(tsxArgs(MISSING_FILE_SOURCE), scenarioEnv(snapshot, scenario));
  const marks: string[] = [];
  const stdout: string[] = [];
  for (const line of run.stdout.split(/\r?\n/)) {
    const match = /^@@(\w+) (.*)$/.exec(line);
    if (match) {
      const value = JSON.parse(match[2]) as Json;
      marks.push(`${match[1]} ${match[1] === 'DOTENV' ? describeDotenvCall(value) : JSON.stringify(value)}`);
    } else if (line.trim()) {
      stdout.push(normalizeText(line));
    }
  }
  const stderr = run.stderr
    .split(/\r?\n/)
    .filter(line => /^\[(Env|ENV)\]/.test(line))
    .map(normalizeText);
  return { exitCode: run.code, marks, stdout, stderr };
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
const scenarioByName = new Map(snapshot.scenarios.map(scenario => [scenario.name, scenario]));
const minimalScenario = scenarioByName.get('values/minimal');
assert.ok(minimalScenario, 'the snapshot has a values/minimal scenario');
const minimalExpect = minimalScenario.expect;

let workerResults: Promise<Map<string, JsonObject>> | undefined;
function results(): Promise<Map<string, JsonObject>> {
  workerResults ??= runWorkerScenarios(snapshot.scenarios.map(scenario => scenarioEnv(snapshot, scenario))).then(
    raw =>
      new Map(
        snapshot.scenarios.map((scenario, index) => [
          scenario.name,
          summarize(raw[index], scenario === minimalScenario ? null : minimalExpect),
        ]),
      ),
  );
  return workerResults;
}

async function checkGroup(prefixes: string[]): Promise<void> {
  const actual = await results();
  const group = snapshot.scenarios.filter(scenario => prefixes.some(prefix => scenario.name.startsWith(prefix)));
  assert.ok(group.length > 0, `no scenario starts with ${prefixes.join(' or ')}`);
  for (const scenario of group) assert.deepStrictEqual(actual.get(scenario.name), scenario.expect, scenario.name);
}

test('the snapshot covers every key: values/full sets each one, most have an invalid/ scenario', () => {
  const keys = (minimalExpect.keys as string[]).filter(key => key !== 'isProduction');
  const fullSet = scenarioByName.get('values/full')?.set ?? {};
  assert.deepStrictEqual(
    keys.filter(key => !(key in fullSet)),
    [],
    'keys values/full does not set',
  );
  const validated = keys.filter(key => scenarioByName.has(`invalid/${key}`));
  assert.ok(validated.length > 150, `only ${validated.length} keys have an invalid/ scenario`);
});

test('values: defaults, every key set, bounds, blanks, parsing quirks and the legacy name', { timeout: 120_000 }, () =>
  checkGroup(['values/']),
);

test('required keys: each missing or blank, and the first missing one in declaration order', { timeout: 120_000 }, () =>
  checkGroup(['required/']),
);

test(
  'invalid values: every validated key on its own, edge cases per helper, order within a domain',
  { timeout: 120_000 },
  () => checkGroup(['invalid/', 'edge/', 'order/']),
);

test(
  'under tsx (as the app runs) a few scenarios give the same results as in the worker threads',
  { timeout: 120_000 },
  async () => {
    const names = [
      'values/minimal',
      'values/full',
      'invalid/AUTH_LOGIN_IP_MAX_ATTEMPTS (legacy name alone)',
      'required/first-missing-in-order/00-NODE_ENV',
    ];
    const group = names.map(name => scenarioByName.get(name)!);
    const raw = await Promise.all(group.map(scenario => runTsxScenario(scenarioEnv(snapshot, scenario))));
    group.forEach((scenario, index) =>
      assert.deepStrictEqual(
        summarize(raw[index], scenario === minimalScenario ? null : minimalExpect),
        scenario.expect,
        scenario.name,
      ),
    );
  },
);

test(
  'env file loading: a missing .env or .env.production prints the path and exits with code 1',
  { timeout: 120_000 },
  async () => {
    const actual = await Promise.all(
      snapshot.exitScenarios.map(scenario => runMissingFileScenario(snapshot, scenario)),
    );
    snapshot.exitScenarios.forEach((scenario, index) =>
      assert.deepStrictEqual(actual[index], scenario.expect, scenario.name),
    );
  },
);

// ── Compile-time check: the type of `env` is the one it had before the split ──

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const _envTypeIsUnchanged: Equals<typeof env, OldEnv> = true;

/** `typeof env` of the one-file env.ts (tsc --declaration output). */
type OldEnv = {
  readonly NODE_ENV: string;
  readonly PORT: number;
  readonly RUNTIME_LANE: string;
  readonly RUNTIME_TENANT_ALLOWLIST: string[];
  readonly RUNTIME_TENANT_DENYLIST: string[];
  readonly RUNTIME_GLOBAL_MAINTENANCE_ENABLED: boolean;
  readonly LANDA_PROCESS_ROLE: 'all' | 'api' | 'background';
  readonly LANDA_API_INSTANCES: number;
  readonly LANDA_INAPP_CLUSTER_WORKERS: number;
  readonly LANDA_INAPP_CLUSTER_SLOT: string;
  readonly BIND_HOST: string;
  readonly TRUST_PROXY_HOPS: number;
  readonly TRUSTED_PROXY_CIDRS: string[];
  readonly AUTH_LOGIN_IP_MAX_FAILURES: number;
  readonly AUTH_LOGIN_ACCOUNT_MAX_FAILURES: number;
  readonly AUTH_REFRESH_TOKEN_MAX_ATTEMPTS: number;
  readonly AUTH_REFRESH_IP_MAX_FAILURES: number;
  readonly AUTH_PASSWORD_CHANGE_MAX_ATTEMPTS: number;
  readonly AUTH_ACCOUNT_ACTION_MAX_ATTEMPTS: number;
  readonly DATABASE_URL: string;
  readonly DATABASE_POOLER_URL: string;
  readonly DB_POOL_MAX: number;
  readonly DB_POOL_IDLE_TIMEOUT_MS: number;
  readonly DB_CONNECTION_RESERVE: number;
  readonly DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: number;
  readonly DB_LOCK_TIMEOUT_MS: number;
  readonly REPORTS_DB_POOL_MAX: number;
  readonly REPORTS_TENANT_CONCURRENCY: number;
  readonly REPORTS_GLOBAL_CONCURRENCY: number;
  readonly REPORTS_ADMISSION_WAIT_MS: number;
  readonly REPORTS_EXPORT_USER_CONCURRENCY: number;
  readonly REPORTS_EXPORT_TENANT_CONCURRENCY: number;
  readonly REPORTS_EXPORT_GLOBAL_CONCURRENCY: number;
  readonly REPORTS_EXPORT_STATEMENT_TIMEOUT_MS: number;
  readonly JWT_SECRET: string;
  readonly JWT_ACCESS_EXPIRES_IN: string;
  readonly JWT_REFRESH_EXPIRES_IN: string;
  readonly BCRYPT_SALT_ROUNDS: number;
  readonly CORS_ORIGIN: string;
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_KEY: string;
  readonly STORAGE_PROXY_HEADERS_TIMEOUT_MS: number;
  readonly STORAGE_DOWNLOAD_IDLE_TIMEOUT_MS: number;
  readonly RABBITMQ_URL: string;
  readonly RABBITMQ_QUEUE_PREFIX: string;
  readonly RABBITMQ_RETRY_BASE_DELAY_MS: number;
  readonly RABBITMQ_RETRY_MAX_DELAY_MS: number;
  readonly METRICS_ENABLED: boolean;
  readonly METRICS_TOKEN: string;
  readonly NODE_APP_INSTANCE: string;
  readonly REDIS_URL: string;
  readonly REDIS_DATABASE: number;
  readonly REDIS_CONNECT_TIMEOUT_MS: number;
  readonly AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION: boolean;
  readonly SSO_CONFIG_ENCRYPTION_KEY: string;
  readonly DEMO_IFRAME_PUBLIC_ORIGIN: string;
  readonly SMTP_CONFIG_ENCRYPTION_KEY: string;
  readonly SMTP_TLS_REJECT_UNAUTHORIZED: boolean;
  readonly AI_SECRET_ENCRYPTION_KEY: string;
  readonly AI_RAG_SERVICE_URL: string;
  readonly AI_RAG_SERVICE_TOKEN: string;
  readonly AI_RAG_SERVICE_HMAC_KEY_ID: string;
  readonly AI_RAG_SERVICE_HMAC_SECRET: string;
  readonly AI_RAG_REQUEST_TIMEOUT_MS: number;
  readonly LESSON_AUTHOR_GENERATION_STATUS_ENABLED: boolean;
  readonly LESSON_AUTHOR_WORKSPACE_READ_ENABLED: boolean;
  readonly LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED: boolean;
  readonly LESSON_AUTHOR_WORKSPACE_STREAM_AUTH_LEASE_MS: number;
  readonly LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED: boolean;
  readonly LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED: boolean;
  readonly LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED: boolean;
  readonly COURSE_PUBLISH_GOVERNANCE_ENABLED: boolean;
  readonly LESSON_AUTHOR_GENERATION_ENABLED: boolean;
  readonly LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED: boolean;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED: boolean;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_TENANT_CONCURRENCY: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_WORKSPACE_CONCURRENCY: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED: boolean;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_ROLE: 'disabled' | 'dispatcher' | 'worker';
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_LANE_COUNT: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_LANE_INDEX: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_LEASE_SECONDS: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_MAX_ATTEMPTS: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_BASE_MS: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_MAX_MS: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_PUBLISHED_RECOVERY_SECONDS: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_DISPATCH_BATCH_SIZE: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_BATCH_SIZE: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_POLL_INTERVAL_MS: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_GLOBAL_CONCURRENCY: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_PROVIDER_CONCURRENCY: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_UNIT_SOFT_DEADLINE_MS: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_LEASE_SECONDS: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_RECOVERY_BATCH_SIZE: number;
  readonly LESSON_AUTHOR_IDM_PIPELINE_ENABLED: boolean;
  readonly LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST: string[];
  readonly LESSON_AUTHOR_IDM_UNIT_SOFT_DEADLINE_MS: number;
  readonly LESSON_AUTHOR_ORCHESTRATION_V2_STOP_ENABLED: boolean;
  readonly AI_RAG_INDEX_REQUEST_TIMEOUT_MS: number;
  readonly AI_RAG_HTTP_KEEP_ALIVE_IDLE_MS: number;
  readonly AI_RAG_STORAGE_SIGNED_URL_TTL_SECONDS: number;
  readonly AI_RAG_STORAGE_SIGNED_URL_ORIGIN: string;
  readonly AI_TOKEN_RESERVATION_SECONDS: number;
  readonly AI_CHAT_TOKEN_RESERVE_ESTIMATE: number;
  readonly AI_CHAT_TENANT_CONCURRENCY: number;
  readonly AI_CHAT_GLOBAL_CONCURRENCY: number;
  readonly AI_CHAT_ANSWER_DEADLINE_MS: number;
  readonly AI_LESSON_AUTHOR_TOKEN_RESERVE_ESTIMATE: number;
  readonly AI_INDEX_TOKEN_RESERVE_ESTIMATE: number;
  readonly AI_ENGINE_TRANSITION_WORKER_ENABLED: boolean;
  readonly AI_ENGINE_TRANSITION_WORKER_POLL_INTERVAL_MS: number;
  readonly AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE: number;
  readonly AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS: number;
  readonly AI_ENGINE_TRANSITION_WORKER_MAX_ATTEMPTS: number;
  readonly AI_ENGINE_TRANSITION_WORKER_RETRY_BASE_SECONDS: number;
  readonly AI_ENGINE_TRANSITION_WORKER_RETRY_MAX_SECONDS: number;
  readonly EMAIL_OUTBOX_WORKER_ENABLED: boolean;
  readonly EMAIL_OUTBOX_INLINE_WORKER_ENABLED: boolean;
  readonly EMAIL_OUTBOX_INTERVAL_MS: number;
  readonly EMAIL_OUTBOX_BATCH_SIZE: number;
  readonly EMAIL_OUTBOX_CLAIM_BATCH_SIZE: number;
  readonly EMAIL_OUTBOX_CONCURRENCY: number;
  readonly EMAIL_OUTBOX_TENANT_CONCURRENCY: number;
  readonly EMAIL_OUTBOX_TICK_BUDGET_MS: number;
  readonly EMAIL_OUTBOX_SESSION_MAX_MESSAGES: number;
  readonly EMAIL_OUTBOX_SENT_RETENTION_DAYS: number;
  readonly EMAIL_OUTBOX_RETENTION_BATCH_SIZE: number;
  readonly EMAIL_OUTBOX_WAKE_DEBOUNCE_MS: number;
  readonly EMAIL_OUTBOX_RABBIT_PREFETCH: number;
  readonly EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD: number;
  readonly EMAIL_OUTBOX_TENANT_COOLDOWN_MS: number;
  readonly EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS: number;
  readonly DELETION_REQUEUE_INTERVAL_MS: number;
  readonly DELETION_MAX_ATTEMPTS: number;
  readonly DELETION_RETRY_BASE_MS: number;
  readonly DELETION_RETRY_MAX_MS: number;
  readonly DELETION_JOB_RETENTION_DAYS: number;
  readonly COURSE_PROGRESS_RECALC_WORKER_ENABLED: boolean;
  readonly COURSE_PROGRESS_RECALC_BATCH_SIZE: number;
  readonly COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK: number;
  readonly COURSE_PROGRESS_RECALC_RABBIT_PREFETCH: number;
  readonly COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS: number;
  readonly TENANT_DATA_QUOTA_WORKER_ENABLED: boolean;
  readonly TENANT_DATA_QUOTA_WORKER_HEARTBEAT_INTERVAL_MS: number;
  readonly TENANT_DATA_QUOTA_WORKER_POLL_INTERVAL_MS: number;
  readonly TENANT_DATA_QUOTA_WORKER_STANDBY_RETRY_MS: number;
  readonly TENANT_DATA_QUOTA_WORKER_PAGE_SIZE: number;
  readonly TENANT_DATA_QUOTA_WORKER_MAX_TENANTS_PER_CYCLE: number;
  readonly TENANT_DATA_QUOTA_WORKER_MAX_PAGES_PER_CLAIM: number;
  readonly TENANT_DATA_QUOTA_WORKER_LEASE_SECONDS: number;
  readonly TENANT_DATA_QUOTA_WORKER_MAX_SLICE_MS: number;
  readonly TENANT_DATA_QUOTA_WORKER_DATABASE_SNAPSHOT_TIMEOUT_MS: number;
  readonly TENANT_DATA_QUOTA_WORKER_RETRY_BASE_SECONDS: number;
  readonly TENANT_DATA_QUOTA_WORKER_RETRY_MAX_SECONDS: number;
  readonly TENANT_DATA_QUOTA_FOLD_INTERVAL_MS: number;
  readonly TENANT_DATA_QUOTA_FOLD_BATCH_SIZE: number;
  readonly TENANT_DATA_QUOTA_FOLD_MAX_BATCHES_PER_TICK: number;
  readonly KB_OPERATION_WORKER_ENABLED: boolean;
  readonly KB_OPERATION_WORKER_POLL_INTERVAL_MS: number;
  readonly KB_OPERATION_WORKER_BATCH_SIZE: number;
  readonly KB_OPERATION_WORKER_CONCURRENCY: number;
  readonly KB_OPERATION_WORKER_LEASE_SECONDS: number;
  readonly KB_OPERATION_WORKER_MAX_ATTEMPTS: number;
  readonly KB_OPERATION_WORKER_RETRY_BASE_SECONDS: number;
  readonly KB_OPERATION_WORKER_RETRY_MAX_SECONDS: number;
  readonly KB_RESTORE_RECOVERY_POLL_INTERVAL_MS: number;
  readonly KB_FAQ_SHEET_READ_TIMEOUT_MS: number;
  readonly KB_FAQ_SHEET_READ_MAX_MEMORY_MB: number;
  readonly KB_FAQ_SHEET_READ_CONCURRENCY: number;
  readonly LESSON_AUTHOR_VIDEO_MAX_UPLOAD_MB: number;
  readonly LESSON_AUTHOR_VIDEO_MAX_DURATION_SECONDS: number;
  readonly LESSON_AUTHOR_TRANSCRIPT_MAX_CHARS: number;
  readonly LESSON_AUTHOR_TRANSCRIPT_RETENTION_HOURS: number;
  readonly LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED: boolean;
  readonly LESSON_AUTHOR_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS: number;
  readonly LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE: number;
  readonly LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY: number;
  readonly LESSON_AUTHOR_TRANSCRIPTION_WORKER_LEASE_SECONDS: number;
  readonly LESSON_AUTHOR_TRANSCRIPTION_WORKER_MAX_ATTEMPTS: number;
  readonly LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_BASE_SECONDS: number;
  readonly LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_MAX_SECONDS: number;
  readonly LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR: string;
  readonly FFMPEG_PATH: string;
  readonly FFPROBE_PATH: string;
  readonly GEMINI_TRANSCRIPTION_MODEL: string;
  readonly COURSE_OUTLINE_TRANSFER_WORKER_ENABLED: boolean;
  readonly COURSE_OUTLINE_TRANSFER_WORKER_POLL_INTERVAL_MS: number;
  readonly REPORT_PDF_BROWSER_PATH: string;
  readonly REPORT_PDF_BROWSER_CHANNEL: 'msedge' | 'chrome' | 'chromium';
  readonly REPORT_PDF_RENDER_CONCURRENCY: number;
  readonly REPORT_PDF_RENDER_QUEUE_LIMIT: number;
  readonly REPORT_PDF_RENDER_TIMEOUT_MS: number;
  readonly REPORT_PDF_BROWSER_IDLE_CLOSE_MS: number;
  readonly REPORT_PDF_STORAGE_ENABLED: boolean;
  readonly REPORT_PDF_AI_NARRATIVE_ENABLED: boolean;
  readonly REPORT_PDF_AI_NARRATIVE_TIMEOUT_MS: number;
  readonly REPORT_PDF_RATE_LIMIT_WINDOW_SECONDS: number;
  readonly REPORT_PDF_USER_EXPORTS_PER_WINDOW: number;
  readonly REPORT_PDF_TENANT_EXPORTS_PER_WINDOW: number;
  readonly REPORT_PDF_TENANT_ACTIVE_JOBS: number;
  readonly REPORT_CHAT_ROUTER_TIMEOUT_MS: number;
  readonly REPORT_CHAT_NARRATIVE_TIMEOUT_MS: number;
  /** Model for the AI Report calls (router, chat and PDF narratives). Empty = the tenant chat model. */
  readonly REPORT_AI_MODEL: string;
  readonly GEMINI_CHAT_MODEL: string;
  readonly GEMINI_LESSON_AUTHOR_MODEL: string;
  readonly GEMINI_TEMP_DIR: string;
  readonly GEMINI_STORE_CREATE_TIMEOUT_MS: number;
  /** Kiểm tra môi trường production */
  readonly isProduction: boolean;
};
