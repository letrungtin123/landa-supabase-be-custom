import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Characterization of the AI engine transition worker
// (ai-engine-transition.worker.ts): start (first drain, then the poller on
// its interval, fake clock), the single-flight drain, the claim, jobs run
// one after another, the lease heartbeat and the lease-lost check, the
// phases (index target, yield, engine switch, source cleanup, completion)
// and the failure mark with its terminal rule and capped exponential
// backoff. Every SQL statement (exact text, parameters, pool or client),
// Redis command, log line, interval and result is digested into a golden
// file written by the code before the worker moved onto
// src/platform/job-runner. Rewrite it only for an intended change:
//   AI_ENGINE_TRANSITION_WORKER_GOLDEN_WRITE=1 npx tsx --test src/modules/ai-chatbot/ai-platform/ai-engine-transition-worker.characterization.test.ts
// AI_ENGINE_TRANSITION_WORKER_FULL_OUT=<file> also writes every outcome in full.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.AI_ENGINE_TRANSITION_WORKER_ENABLED = 'true';
process.env.AI_ENGINE_TRANSITION_WORKER_POLL_INTERVAL_MS = '15000';
process.env.AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE = '20';
process.env.AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS = '60';
process.env.AI_ENGINE_TRANSITION_WORKER_MAX_ATTEMPTS = '30';
process.env.AI_ENGINE_TRANSITION_WORKER_RETRY_BASE_SECONDS = '30';
process.env.AI_ENGINE_TRANSITION_WORKER_RETRY_MAX_SECONDS = '3600';

const h = await import('../../../test-support/job-characterization.js');
const { env } = await import('../../../config/env.js');
const worker = await import('./ai-engine-transition.worker.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const KB = 'd0000000-0000-4000-8000-000000000001';
const JOB = 'e0000000-0000-4000-8000-000000000001';
const JOB_2 = 'e0000000-0000-4000-8000-000000000002';
const LEASE = 'f0000000-0000-4000-8000-000000000001';

const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  tenant_id: TENANT,
  from_engine: 'gemini_file_search',
  to_engine: 'self_built_rag',
  status: 'running',
  phase: 'index_target',
  attempt_count: 1,
  lease_token: LEASE,
  lease_expires_at: '2026-10-19 10:01:00+07',
  ...extra,
});

const CLAIM = /UPDATE ai_engine_transition_jobs job\n\s+SET status = 'running'/;
const RENEW = /UPDATE ai_engine_transition_jobs\n\s+SET lease_expires_at = now\(\)/;
const BUSY = /AND status IN \('learning', 'deleting'\)/;
const ELIGIBLE = /AS total\n\s+FROM kb_documents\n/;
const READY = /AS total\n\s+FROM kb_documents d\n/;
const SETTINGS = /RETURNING active_engine, active_transition_job_id::text/;
const MISSING = /ORDER BY d.created_at ASC, d.id ASC/;
const SWITCH = /SET active_engine = \$3/;
const CLEANUP = /SELECT kb.id::text AS kb_id/;
const FAIL = /SET status = CASE WHEN \$3::boolean THEN 'failed' ELSE 'queued' END/;
const ONE = { rows: [], rowCount: 1 };
const NONE = { rows: [], rowCount: 0 };

type Value = Parameters<typeof h.answers>[0][number][1];
type Row = [RegExp, Value];
/** A tenant still on Gemini with 2 eligible documents, `ready` of them indexed; `first` answers before that. */
function transition(claimed: Value, ready = '1', ...first: Row[]) {
  return h.answers([
    ...first,
    [CLAIM, claimed],
    [RENEW, ONE],
    [BUSY, [{ count: '0' }]],
    [ELIGIBLE, [{ total: '2' }]],
    [READY, [{ total: ready }]],
    [SETTINGS, [{ active_engine: 'gemini_file_search', active_transition_job_id: JOB }]],
    [MISSING, []],
    [SWITCH, { rows: [{ tenant_id: TENANT }], rowCount: 1 }],
    [CLEANUP, []],
  ]);
}

type Case = import('../../../test-support/job-characterization.js').JobCase;
type Context = Parameters<Case['run']>[0];
const cases: Case[] = [];
const add = (name: string, sql: Case['sql'], run: Case['run']) => cases.push({ name, sql, run });
let gate: import('../../../test-support/job-characterization.js').Gate | null = null;

async function start(context: Context): Promise<void> {
  await worker.startAiEngineTransitionWorker();
  await context.settle();
  context.mark('started');
}

add('start with nothing due', transition([]), start);
add('start disabled', transition([]), async context => {
  (env as { AI_ENGINE_TRANSITION_WORKER_ENABLED: boolean }).AI_ENGINE_TRANSITION_WORKER_ENABLED = false;
  try {
    await start(context);
  } finally {
    (env as { AI_ENGINE_TRANSITION_WORKER_ENABLED: boolean }).AI_ENGINE_TRANSITION_WORKER_ENABLED = true;
  }
});
add('start claim fails', transition(h.sqlError('pool exhausted')), start);
add('index not ready yields the job', transition([job(JOB)], '1'), start);
add('index ready switches the engine and completes', transition([job(JOB)], '2'), start);
add(
  'job already on the target engine cleans the source and completes',
  transition([job(JOB)], '2', [SETTINGS, [{ active_engine: 'self_built_rag', active_transition_job_id: JOB }]]),
  start,
);
add('job in the switch phase', transition([job(JOB, { phase: 'switch_engine' })], '2'), start);
add(
  'source cleanup not finished yields with progress',
  transition([job(JOB, { phase: 'cleanup_source' })], '2', [CLEANUP, [{ kb_id: KB }]], [/SELECT EXISTS \(\n\s+SELECT 1\n\s+FROM kb_doc_gemini_mapping/, [{ exists: true }]]),
  start,
);
add('cleanup of a rag source', transition([job(JOB, { phase: 'cleanup_source', from_engine: 'self_built_rag', to_engine: 'gemini_file_search' })], '2'), start);
add(
  'active engine mismatch fails the job',
  transition([job(JOB)], '2', [SETTINGS, [{ active_engine: 'legacy', active_transition_job_id: JOB }]]),
  start,
);
add('missing settings fail and the job is retried', transition([job(JOB)], '2', [SETTINGS, []]), start);
add('failure at attempt 4', transition([job(JOB, { attempt_count: 4 })], '2', [SETTINGS, []]), start);
add('failure at attempt 12 is capped', transition([job(JOB, { attempt_count: 12 })], '2', [SETTINGS, []]), start);
add('failure on the last attempt is terminal', transition([job(JOB, { attempt_count: 30 })], '2', [SETTINGS, []]), start);
add('failed mark fails', transition([job(JOB)], '2', [SETTINGS, []], [FAIL, h.sqlError('connection reset')]), start);
add('busy documents fail the job', transition([job(JOB)], '2', [BUSY, [{ count: '3' }]]), start);
add('lease lost at the start', transition([job(JOB)], '2', [RENEW, NONE]), start);
add('job without a lease token', transition([job(JOB, { lease_token: null })], '2'), start);
add('engine switch matches no settings row', transition([job(JOB)], '2', [SWITCH, NONE]), start);
add('two jobs run one after another', transition([job(JOB), job(JOB_2, { attempt_count: 3 })], '1'), start);
add(
  'heartbeat renews the lease while the job runs',
  transition([job(JOB)], '2', [BUSY, () => gate!.wait([{ count: '0' }])]),
  async context => {
    gate = context.gate();
    const started = worker.startAiEngineTransitionWorker();
    await context.settle();
    context.mark('busy check pending');
    await context.tick(19_999);
    context.mark('19999 ms');
    await context.tick(1);
    context.mark('20000 ms');
    await context.tick(20_000);
    context.mark('40000 ms');
    gate.open();
    await started;
  },
);
let renewals = 0;
add(
  'heartbeat loses the lease',
  transition([job(JOB)], '2', [BUSY, () => gate!.wait([{ count: '0' }])], [RENEW, () => (++renewals === 2 ? NONE : ONE)]),
  async context => {
    gate = context.gate();
    renewals = 0;
    const started = worker.startAiEngineTransitionWorker();
    await context.settle();
    await context.tick(20_000);
    context.mark('20000 ms');
    gate.open();
    await started;
  },
);
add(
  'heartbeat renewal fails',
  transition([job(JOB)], '2', [BUSY, () => gate!.wait([{ count: '0' }])], [RENEW, () => (++renewals === 2 ? h.sqlError('connection reset') : ONE)]),
  async context => {
    gate = context.gate();
    renewals = 0;
    const started = worker.startAiEngineTransitionWorker();
    await context.settle();
    await context.tick(20_000);
    context.mark('20000 ms');
    gate.open();
    await started;
  },
);
let claims = 0;
add(
  'poller drains on its interval and skips a tick while a drain runs',
  transition(
    () => {
      claims += 1;
      return claims === 2 ? [job(JOB)] : [];
    },
    '1',
    [BUSY, () => (claims === 2 ? gate!.wait([{ count: '0' }]) : [{ count: '0' }])],
  ),
  async context => {
    gate = context.gate();
    claims = 0;
    await start(context);
    await context.tick(14_999);
    context.mark('14999 ms');
    await context.tick(1);
    context.mark('15000 ms: drain running');
    await context.tick(15_000);
    context.mark('30000 ms: tick skipped');
    gate.open();
    await context.settle();
    context.mark('drain done');
    await context.tick(15_000);
    context.mark('45000 ms');
  },
);

h.registerJobCharacterization({
  title: 'AI engine transition worker characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-engine-transition-worker.characterization.golden.json'),
  writeEnv: 'AI_ENGINE_TRANSITION_WORKER_GOLDEN_WRITE',
  fullOutEnv: 'AI_ENGINE_TRANSITION_WORKER_FULL_OUT',
  cases,
  fixedIds: [TENANT, KB, JOB, JOB_2, LEASE],
  now: Date.UTC(2026, 9, 19, 3, 0, 0),
});
