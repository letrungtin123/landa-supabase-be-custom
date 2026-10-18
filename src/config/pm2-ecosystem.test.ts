import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// The PM2 files at the repository root:
// - ecosystem.production-no-ai.config.cjs is the file prod 226 runs (no AI
//   service, every AI ID flag off). Changing it is a deploy action.
// - ecosystem.config.cjs is the file this machine runs. It must never be
//   started on 226.
const require = createRequire(import.meta.url);

interface Pm2App {
  name: string;
  script: string;
  exec_mode?: string;
  instances?: number;
  env?: Record<string, string>;
  env_production?: Record<string, string>;
}

function loadApps(file: string): Pm2App[] {
  return (require(`../../${file}`) as { apps: Pm2App[] }).apps;
}

const prodApps = loadApps('ecosystem.production-no-ai.config.cjs');
const repoApps = loadApps('ecosystem.config.cjs');

// Apps of ecosystem.config.cjs that prod 226 does not run.
const REPO_ONLY_APPS = ['landa-news-assets-cleanup-worker'];

// Every pool of prod 226 together stays at or below this (max_connections
// 100; the rest is left to Supabase's own services and DB_CONNECTION_RESERVE).
const PROD_226_CONNECTION_CEILING = 60;

const MAIN_SCRIPT = './dist/index.js';

const WORKSPACE_FLAGS = [
  'LESSON_AUTHOR_WORKSPACE_READ_ENABLED',
  'LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED',
  'LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED',
  'LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED',
  'LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED',
];

/** The environments PM2 can start an app with: `env`, and `env` + `env_production` (--env production). */
function environments(app: Pm2App): Array<[label: string, env: Record<string, string>]> {
  const env = app.env ?? {};
  return [
    [`${app.name} env`, env],
    [`${app.name} env_production`, { ...env, ...(app.env_production ?? {}) }],
  ];
}

function role(env: Record<string, string>): string {
  return env.LANDA_PROCESS_ROLE ?? 'all';
}

function poolSize(env: Record<string, string>, key: string, label: string): number {
  const value = Number(env[key]);
  assert.ok(Number.isInteger(value) && value > 0, `${label}: ${key} must be set to a positive integer`);
  return value;
}

test('prod 226 runs no AI ID: every workspace flag is off and publish governance is not set', () => {
  for (const app of prodApps) {
    for (const [label, env] of environments(app)) {
      for (const [key, value] of Object.entries(env)) {
        if (/^LESSON_AUTHOR_WORKSPACE_\w+_ENABLED$/.test(key)) assert.equal(value, 'false', `${label}: ${key}`);
        if (/^LESSON_AUTHOR_\w+_ENABLED$/.test(key)) assert.notEqual(value, 'true', `${label}: ${key}`);
      }
      assert.equal('COURSE_PUBLISH_GOVERNANCE_ENABLED' in env, false, `${label}: COURSE_PUBLISH_GOVERNANCE_ENABLED`);
      if (app.script === MAIN_SCRIPT) {
        for (const flag of WORKSPACE_FLAGS) assert.equal(env[flag], 'false', `${label}: ${flag}`);
        assert.equal(env.EMAIL_OUTBOX_INLINE_WORKER_ENABLED, 'false', `${label}: EMAIL_OUTBOX_INLINE_WORKER_ENABLED`);
      }
    }
  }
});

test('prod 226: the API is a PM2 cluster of api processes next to exactly one background process', () => {
  const api = prodApps.find((app) => app.name === 'landa-refactor-backend');
  assert.ok(api, 'landa-refactor-backend is missing');
  assert.equal(api.script, MAIN_SCRIPT);
  assert.equal(api.exec_mode, 'cluster');
  const background = prodApps.filter((app) => app.script === MAIN_SCRIPT && role(app.env ?? {}) === 'background');
  assert.equal(background.length, 1, 'exactly one background process');
  assert.equal(background[0]!.exec_mode, 'fork');
  assert.equal(background[0]!.instances, 1);

  for (const [label, env] of environments(api)) {
    assert.equal(role(env), 'api', label);
    assert.equal(Number(env.LANDA_API_INSTANCES), api.instances, `${label}: LANDA_API_INSTANCES matches instances`);
  }
  for (const [label, env] of environments(background[0]!)) {
    assert.equal(role(env), 'background', label);
    assert.equal(Number(env.LANDA_API_INSTANCES), api.instances, `${label}: LANDA_API_INSTANCES matches the API`);
  }
  for (const app of prodApps.filter((candidate) => candidate.script !== MAIN_SCRIPT)) {
    for (const [label, env] of environments(app)) {
      assert.equal('LANDA_API_INSTANCES' in env, false, `${label}: a worker gets no LANDA_API_INSTANCES`);
    }
  }
});

test('prod 226: every pool is sized explicitly and all of them fit under the connection ceiling', () => {
  for (const variant of [0, 1]) {
    let total = 0;
    for (const app of prodApps) {
      const [label, env] = environments(app)[variant]!;
      // As in database-headroom.ts: a process that serves HTTP also opens the reports pool.
      const servesHttp = app.script === MAIN_SCRIPT && role(env) !== 'background';
      const perProcess =
        poolSize(env, 'DB_POOL_MAX', label) + (servesHttp ? poolSize(env, 'REPORTS_DB_POOL_MAX', label) : 0);
      total += perProcess * (app.instances ?? 1);
    }
    assert.ok(total <= PROD_226_CONNECTION_CEILING, `${total} connections > ${PROD_226_CONNECTION_CEILING}`);
  }
});

test('the repo and prod 226 files give the shared apps the same names and scripts', () => {
  for (const app of prodApps) {
    const repoApp = repoApps.find((candidate) => candidate.name === app.name);
    assert.ok(repoApp, `${app.name} is not in ecosystem.config.cjs`);
    assert.equal(app.script, repoApp.script, `${app.name}: script`);
  }
  const repoOnly = repoApps.map((app) => app.name).filter((name) => !prodApps.some((app) => app.name === name));
  assert.deepEqual(
    repoOnly,
    REPO_ONLY_APPS,
    'an app added to ecosystem.config.cjs needs a decision for ecosystem.production-no-ai.config.cjs',
  );
});
