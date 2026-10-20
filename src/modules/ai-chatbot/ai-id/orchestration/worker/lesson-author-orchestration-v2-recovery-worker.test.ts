// Worker-side behaviour behind the author recovery actions: the dispatch fence
// of a stopped run, late success/failure of in-flight work, the reconciliation
// of unknown outcomes of finished runs, the dispatch epoch of released
// validations/finalizers and the revision-zero chapter baseline.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import { createOrchestrationV2ChapterRepository } from '../steps/lesson-author-orchestration-v2-chapter.repository.js';
import { orchestrationV2Hash } from '../../shared/lesson-author-orchestration-v2.logic.js';
import { orchestrationV2UnitArtifactHash } from '../steps/lesson-author-orchestration-v2-unit.logic.js';
import { createOrchestrationV2UnitRepository } from '../steps/lesson-author-orchestration-v2-unit.repository.js';
import {
  createOrchestrationV2WorkerRepository,
  type OrchestrationV2TaskLease,
} from './lesson-author-orchestration-v2-worker.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: string) => orchestrationV2Hash(value);
const RUN = uuid(2), TASK = uuid(3), WORKSPACE = uuid(4), TENANT = uuid(5), LEASE_TOKEN = uuid(9), RESERVATION = uuid(10);
const COURSE = 'course-v1:recovery+1+2026';
const noSleep = { sleep: async () => undefined, random: () => 0 };

function lease(overrides: Partial<OrchestrationV2TaskLease> = {}): OrchestrationV2TaskLease {
  return { task_id: TASK, run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT, course_id: COURSE,
    task_key: 'content:chapter-1:unit:1', kind: 'generate_unit', chapter_key: 'chapter-1', node_id: uuid(6),
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(7),
    source_snapshot_hash: hash('source'), runtime_config_hash: hash('runtime'), model: 'model', locale: 'vi',
    max_output_tokens: 65_536, provider_max_attempts: 2, execution_budget_ms: 600_000, lease_token: LEASE_TOKEN,
    dispatch_epoch: 1, provider_replay_required: false, routing_shard: 19, ai_reservation_id: RESERVATION,
    ...overrides };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return { id: TASK, run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT, course_id: COURSE,
    task_key: 'content:chapter-1:unit:1', kind: 'generate_unit', chapter_key: 'chapter-1', node_id: uuid(6),
    input_tokens: 200_000, embedding_tokens: 0, max_output_tokens: 65_536, provider_max_attempts: 2,
    status: 'running', lease_token: LEASE_TOKEN, attempt_count: 1, max_attempts: 2, dispatch_epoch: 1,
    ai_reservation_id: RESERVATION, accounting_state: 'reserved', dispatch_started_at: null, routing_shard: 19,
    ...overrides };
}

type Route = (sql: string, params: unknown[]) => Record<string, unknown>[] | undefined;
function database(route: Route) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const events: string[] = [];
  const tx: GenerationJobSql = {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const rows = route(sql, params);
      assert.notEqual(rows, undefined, `unexpected SQL: ${sql}`);
      return { rows: rows as T[], rowCount: rows!.length };
    },
  };
  const db: GenerationJobDatabase = {
    async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
      events.push('BEGIN');
      try { const value = await work(tx); events.push('COMMIT'); return value; }
      catch (error) { events.push('ROLLBACK'); throw error; }
    },
  };
  return { db, calls, events, worker: createOrchestrationV2WorkerRepository(db, () => uuid(50), { retry: noSleep }) };
}

test('dispatch fence: a stopped run sends nothing new; a lost lease stays a lost lease', async () => {
  const live = database(sql => /pg_advisory_xact_lock/.test(sql) ? [{}]
    : /SET dispatch_started_at/.test(sql) ? [{ id: TASK }] : undefined);
  await live.worker.markProviderDispatched(lease());
  const fence = live.calls[1]!.sql;
  assert.match(fence, /run\.status IN \('planning','executing','finalizing'\)/);
  assert.equal(live.calls.length, 2);

  for (const status of ['needs_action', 'canceled', 'ready']) {
    const stopped = database(sql => /pg_advisory_xact_lock/.test(sql) ? [{}] : /SET dispatch_started_at/.test(sql) ? []
      : /SELECT status FROM lesson_author_workspace_v2_runs/.test(sql) ? [{ status }] : undefined);
    await assert.rejects(stopped.worker.markProviderDispatched(lease()), { code: 'ORCHESTRATION_V2_RUN_NOT_ACTIVE' });
    assert.deepEqual(stopped.events, ['BEGIN', 'ROLLBACK']);
  }
  const lost = database(sql => /pg_advisory_xact_lock/.test(sql) ? [{}] : /SET dispatch_started_at/.test(sql) ? []
    : /SELECT status FROM lesson_author_workspace_v2_runs/.test(sql) ? [{ status: 'executing' }] : undefined);
  await assert.rejects(lost.worker.markProviderDispatched(lease()), { code: 'ORCHESTRATION_V2_TASK_LEASE_LOST' });
});

test('stopped run: a claim refused at the fence releases its credit and fails without a requeue', async () => {
  const released: string[] = [];
  const f = database(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/SELECT status FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'needs_action' }];
    if (/SELECT t\.\*,coalesce\(o\.routing_shard,0\)/.test(sql)) return [taskRow()];
    if (/SET status='failed'/.test(sql)) return [{ id: TASK }];
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) {
      return [{ status: 'needs_action', failure_code: 'RUN_STOPPED_BY_AUTHOR' }];
    }
    if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/count\(\*\)::integer AS count/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: WORKSPACE }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 4 }];
    return undefined;
  });
  const disposition = await f.worker.recoverClaimFailure(lease(), 'ORCHESTRATION_V2_RUN_NOT_ACTIVE',
    async (_tx, task) => { released.push(String(task.ai_reservation_id)); },
    async () => assert.fail('nothing was dispatched'), async () => assert.fail('no replay'));
  assert.equal(disposition, 'failed');
  assert.deepEqual(released, [RESERVATION]);
  assert.equal(f.calls.some(call => /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(call.sql)), false);
  const failed = f.calls.find(call => /SET status='failed'/.test(call.sql))!;
  assert.equal(failed.params[3], 'ORCHESTRATION_V2_RUN_NOT_ACTIVE');
  // The last task settled, so the workspace now publishes the stop.
  assert.ok(f.calls.some(call => /UPDATE lesson_author_workspaces SET status='needs_action'/.test(call.sql)));
});

test('stopped run: an in-flight AI call that already crossed the fence still commits its content', async () => {
  const settled: string[] = [];
  const f = database(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/SELECT \* FROM lesson_author_workspace_v2_tasks/.test(sql)) {
      return [taskRow({ dispatch_started_at: new Date() })];
    }
    if (/INSERT INTO lesson_author_workspace_v2_artifacts/.test(sql)) return [{ id: uuid(30) }];
    if (/SET status='succeeded'/.test(sql)) return [{ id: TASK }];
    return undefined;
  });
  // A complete unit payload whose artifact hash is its own (write-time guard of succeed).
  const payload = { contract_version: 2, unit_path: 'chapter_1.lesson_1.unit_1', source_snapshot_hash: hash('source'),
    contract_hash: hash('contract'), nodes: [], generated_unit: { components: [] } };
  const artifactHash = orchestrationV2UnitArtifactHash(payload);
  await f.worker.succeed(lease(), artifactHash, 'orchestration-unit-baseline-v2',
    { inputTokens: 1, outputTokens: 2, embeddingTokens: 0, totalTokens: 3 },
    { artifact_kind: 'unit_baseline', artifact_hash: artifactHash, payload,
      validation_contract: 'orchestration-unit-baseline-v2' },
    async (_tx, current) => { settled.push(current.task_id); });
  assert.deepEqual(settled, [TASK]);
  // Success is fenced by the lease only: the run status of a stopped run is never consulted.
  assert.ok(f.calls.every(call => !/lesson_author_workspace_v2_runs/.test(call.sql)));
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
});

test('stopped run: a dispatched call that fails late is held as unknown and never replayed', async () => {
  const held: string[] = [];
  const f = database(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/SELECT status FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'needs_action' }];
    if (/SELECT t\.\*,coalesce\(o\.routing_shard,0\)/.test(sql)) return [taskRow({ dispatch_started_at: new Date() })];
    if (/SET status='outcome_unknown'/.test(sql)) return [{ id: TASK }];
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) {
      return [{ status: 'needs_action', failure_code: 'RUN_STOPPED_BY_AUTHOR' }];
    }
    if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/count\(\*\)::integer AS count/.test(sql)) return [{ count: 1 }];
    return undefined;
  });
  const disposition = await f.worker.recoverClaimFailure(lease(), 'AI_RAG_SERVICE_ERROR',
    async () => assert.fail('a dispatched call cannot be released'),
    async (_tx, task) => { held.push(String(task.id)); }, async () => assert.fail('a stopped run never replays'));
  assert.equal(disposition, 'outcome_unknown');
  assert.deepEqual(held, [TASK]);
  assert.equal(f.calls.some(call => /SET status='queued'/.test(call.sql)), false);
  // Another task is still running: the workspace keeps drafting until it settles.
  assert.equal(f.calls.some(call => /UPDATE lesson_author_workspaces/.test(call.sql)), false);
});

function recoveryRoute(candidate: Record<string, unknown> | null, locked: Record<string, unknown> | null): Route {
  return sql => {
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) la_v2_finished_run_unknown$/.test(sql)) return [];
    if (/t\.status IN \('failed','timed_out','outcome_unknown'\)/.test(sql)) return [];
    if (/r\.status='needs_action' AND w\.status IN/.test(sql)) return [];
    if (/WHERE t\.status='running' AND \(t\.lease_expires_at/.test(sql)) return [];
    if (/FROM ai_token_reservations reservation\s+JOIN lesson_author_workspace_v2_tasks t/.test(sql)) {
      return candidate ? [candidate] : [];
    }
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/SELECT t\.\*,r\.model/.test(sql)) return locked ? [locked] : [];
    // No recovered run left without live work in these cases.
    if (/WHERE r\.status='executing'\s+AND EXISTS\(SELECT 1 FROM lesson_author_workspace_v2_recoveries/.test(sql)) return [];
    return undefined;
  };
}

test('finished runs: a held unknown outcome is settled once at the upper bound', async () => {
  const reconciled: Array<Record<string, unknown>> = [];
  const candidate = { task_id: TASK, run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT };
  const unknown = taskRow({ status: 'outcome_unknown', accounting_state: 'pending_reconciliation',
    lease_token: null, model: 'model', dispatch_started_at: new Date() });
  const f = database(recoveryRoute(candidate, unknown));
  const result = await f.worker.recoverOne(async () => assert.fail('no release'), async () => assert.fail('no hold'),
    async (_tx, task) => { reconciled.push(task); });
  assert.equal(result, 'reconciled');
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]!.model, 'model');
  const scan = f.calls.find(call => /FROM ai_token_reservations reservation/.test(call.sql))!.sql;
  assert.match(scan, /reservation\.status='reserved'/);
  assert.match(scan, /r\.status IN \('needs_action','canceled'\)/);
  assert.match(scan, /reservation\.estimated_tokens=t\.input_tokens\+t\.embedding_tokens\+t\.max_output_tokens\*t\.provider_max_attempts/);
  const lock = f.calls.find(call => /SELECT t\.\*,r\.model/.test(call.sql))!.sql;
  assert.match(lock, /reservation\.status='reserved'/);
  assert.match(lock, /FOR UPDATE OF r,t/);
  const advisory = f.calls.findIndex(call => /pg_advisory_xact_lock/.test(call.sql));
  assert.ok(advisory < f.calls.findIndex(call => /SELECT t\.\*,r\.model/.test(call.sql)));

  // Already settled by another worker between the scan and the lock: nothing happens.
  const raced = database(recoveryRoute(candidate, null));
  assert.equal(await raced.worker.recoverOne(async () => undefined, async () => undefined,
    async () => assert.fail('settled once only')), null);
  // Nothing left: the sweep ends.
  const idle = database(recoveryRoute(null, null));
  assert.equal(await idle.worker.recoverOne(async () => undefined, async () => undefined, async () => undefined), null);
  // Without a reconciler (legacy wiring) the new scan is never issued.
  const legacy = database(recoveryRoute(candidate, unknown));
  assert.equal(await legacy.worker.recoverOne(async () => undefined, async () => undefined), null);
  assert.equal(legacy.calls.some(call => /FROM ai_token_reservations reservation/.test(call.sql)), false);
});

test('finished runs: a settlement that fails is skipped with a backoff and the stalled-run check still runs', async () => {
  const STALLED_RUN = uuid(20);
  const candidate = { task_id: TASK, run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT };
  const unknown = taskRow({ status: 'outcome_unknown', accounting_state: 'pending_reconciliation', lease_token: null,
    model: 'model', dispatch_started_at: new Date() });
  const base = recoveryRoute(candidate, unknown);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const route: Route = (sql, params) => {
    // The scan honours its exclusion list like PostgreSQL would (t.id<>ALL($1::uuid[])).
    if (/FROM ai_token_reservations reservation\s+JOIN/.test(sql)) {
      assert.match(sql, /AND t\.id<>ALL\(\$1::uuid\[\]\)/);
      return (params[0] as string[]).includes(TASK) ? [] : [candidate];
    }
    // The stalled recovered run of another workspace, found once the failing settlement is skipped.
    if (/WHERE r\.status='executing'\s+AND EXISTS\(SELECT 1 FROM lesson_author_workspace_v2_recoveries/.test(sql)) {
      return [{ run_id: STALLED_RUN, workspace_id: uuid(21), tenant_id: TENANT }];
    }
    if (/AS failure_code\s+FROM lesson_author_workspace_v2_runs r/.test(sql)) {
      return [{ run_id: STALLED_RUN, workspace_id: uuid(21), tenant_id: TENANT, course_id: COURSE,
        failure_code: 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID' }];
    }
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'executing' }];
    if (/UPDATE lesson_author_workspace_v2_runs\s+SET status='needs_action'/.test(sql)) return [{ id: STALLED_RUN }];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/count\(\*\)::integer AS count/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: uuid(21) }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 7 }];
    return base(sql, params);
  };
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    const rows = route(sql, params);
    assert.notEqual(rows, undefined, `unexpected SQL: ${sql}`);
    return { rows: rows as T[], rowCount: rows!.length };
  } };
  let clock = 1_000_000;
  const reports: Array<Record<string, unknown>> = [];
  const report = (event: Record<string, unknown>) => { reports.push(event); };
  const worker = createOrchestrationV2WorkerRepository({ transaction: async work => work(tx) }, () => uuid(50),
    { retry: noSleep, reconcileBackoff: { base_ms: 1_000, max_ms: 4_000, now: () => clock, report } });
  let attempts = 0;
  const failing = async () => { attempts += 1; throw Object.assign(new Error('ledger row missing'),
    { code: 'ORCHESTRATION_V2_ACCOUNTING_READBACK_INVALID' }); };
  const scans = () => calls.filter(call => /FROM ai_token_reservations reservation\s+JOIN/.test(call.sql));

  // The failing task is rolled back to before its locks, logged, and the stalled run is stopped in the same cycle.
  assert.equal(await worker.recoverOne(async () => undefined, async () => undefined, failing), 'reconciled');
  const order = calls.map(call => call.sql);
  const at = (pattern: RegExp) => order.findIndex(sql => pattern.test(sql));
  assert.ok(at(/^SAVEPOINT la_v2_finished_run_unknown$/) < at(/pg_advisory_xact_lock/));
  assert.ok(at(/SELECT t\.\*,r\.model/) < at(/^ROLLBACK TO SAVEPOINT la_v2_finished_run_unknown$/));
  assert.ok(at(/^ROLLBACK TO SAVEPOINT la_v2_finished_run_unknown$/) < at(/WHERE r\.status='executing'\s+AND EXISTS/));
  assert.deepEqual(calls.find(call => /SET status='needs_action',failure_code=\$2/.test(call.sql))!.params,
    [STALLED_RUN, 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID']);
  assert.deepEqual(reports, [{ event: 'worker_finished_run_unknown_reconcile_failed', task_id: TASK, run_id: RUN,
    tenant_id: TENANT, failure_code: 'ORCHESTRATION_V2_ACCOUNTING_READBACK_INVALID', retry_after_ms: 1_000 }]);
  assert.doesNotMatch(JSON.stringify(reports), /ledger row missing/, 'only the code is logged');
  assert.deepEqual(scans()[0]!.params, [[]]);

  // While it waits, the same task is excluded from the scan (no tight loop on one bad row).
  assert.equal(await worker.recoverOne(async () => undefined, async () => undefined, failing), 'reconciled');
  assert.deepEqual(scans()[1]!.params, [[TASK]]);
  assert.equal(attempts, 1);
  // After the wait it is tried again; each failure doubles the wait up to the maximum.
  for (const expected of [2_000, 4_000, 4_000]) {
    clock += 5_000;
    await worker.recoverOne(async () => undefined, async () => undefined, failing);
    assert.equal(reports.at(-1)!.retry_after_ms, expected);
  }
  assert.equal(attempts, 4);
  // A success clears the task from the list.
  clock += 5_000;
  assert.equal(await worker.recoverOne(async () => undefined, async () => undefined, async () => undefined), 'reconciled');
  assert.ok(calls.at(-1)!.sql === 'RELEASE SAVEPOINT la_v2_finished_run_unknown');
  await worker.recoverOne(async () => undefined, async () => undefined, async () => undefined);
  assert.deepEqual(scans().at(-1)!.params, [[]]);

  // A deadlock victim is not skipped: the whole transaction re-runs from BEGIN.
  let deadlocks = 0;
  const settled: string[] = [];
  const victim = createOrchestrationV2WorkerRepository({ transaction: async work => work(tx) }, () => uuid(50),
    { retry: noSleep, reconcileBackoff: { base_ms: 1_000, max_ms: 4_000, now: () => clock, report } });
  const reportsBefore = reports.length;
  assert.equal(await victim.recoverOne(async () => undefined, async () => undefined, async (_tx, task) => {
    if (deadlocks++ === 0) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    settled.push(String(task.id));
  }), 'reconciled');
  assert.deepEqual(settled, [TASK]);
  assert.equal(reports.length, reportsBefore, 'a retried deadlock is not a skipped settlement');
  assert.throws(() => createOrchestrationV2WorkerRepository({ transaction: async work => work(tx) }, () => uuid(50),
    { reconcileBackoff: { base_ms: 0, max_ms: 1 } }), /ORCHESTRATION_V2_RECONCILE_BACKOFF_INVALID/);
});

test('released validation and finalizer dispatch at their own epoch (reopened tasks are not epoch 0)', async () => {
  const outbox: unknown[][] = [];
  const unitTx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    let rows: Record<string, unknown>[] = [];
    if (/candidate\.kind='validate_chapter'/.test(sql)) rows = [{ id: uuid(29), dispatch_epoch: 3 }];
    else if (/INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(sql)) { outbox.push(params); rows = [{ id: uuid(31) }]; }
    else if (/FROM lesson_author_workspace_nodes WHERE/.test(sql)) rows = [];
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const unitWorker = { succeed: async (...args: unknown[]) => {
    await (args[6] as { afterSuccess(tx: GenerationJobSql): Promise<void> }).afterSuccess(unitTx);
  } };
  const unitDb = { transaction: async <T>(work: (tx: GenerationJobSql) => Promise<T>) => work(unitTx) } as GenerationJobDatabase;
  const publication = { unit_path: 'chapter_1.lesson_1.unit_1', source_snapshot_hash: hash('source'),
    validation_contract: 'orchestration-unit-baseline-v2', contract_hash: hash('c'), nodes: [], generated_unit: {},
    content_origin: 'provider_validated', quality_state: 'validated', result_hash: hash('r') };
  await createOrchestrationV2UnitRepository(unitDb, unitWorker as never, () => uuid(31)).complete(lease(),
    publication as never, {}, (async () => undefined) as never, (async () => undefined) as never, 'provider');
  assert.equal(outbox[0]![6], 3);

  const chapterTx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    let rows: Record<string, unknown>[] = [];
    if (/candidate\.kind='finalize_course'/.test(sql)) rows = [{ id: uuid(40), dispatch_epoch: 2 }];
    else if (/INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(sql)) { outbox.push(params); rows = [{ id: uuid(41) }]; }
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const chapterWorker = { succeed: async (...args: unknown[]) => {
    await (args[6] as { afterSuccess(tx: GenerationJobSql): Promise<void> }).afterSuccess(chapterTx);
  } };
  const chapterDb = { transaction: async <T>(work: (tx: GenerationJobSql) => Promise<T>) => work(chapterTx) } as GenerationJobDatabase;
  const chapterLease = lease({ kind: 'validate_chapter', node_id: uuid(60), ai_reservation_id: null });
  await createOrchestrationV2ChapterRepository(chapterDb, chapterWorker as never, () => uuid(41)).complete(chapterLease, {
    contract: 'orchestration-chapter-receipt-v2', chapter_key: 'chapter-1', chapter_node_id: uuid(60),
    source_snapshot_hash: hash('source'), receipt_hash: hash('receipt') } as never);
  assert.equal(outbox[1]![6], 2);

  // An epoch outside the schema range is refused instead of written.
  const badTx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string) {
    const rows = /candidate\.kind='finalize_course'/.test(sql) ? [{ id: uuid(40), dispatch_epoch: 101 }] : [];
    return { rows: rows as unknown as T[], rowCount: rows.length };
  } };
  const badWorker = { succeed: async (...args: unknown[]) => {
    await (args[6] as { afterSuccess(tx: GenerationJobSql): Promise<void> }).afterSuccess(badTx);
  } };
  await assert.rejects(createOrchestrationV2ChapterRepository(chapterDb, badWorker as never, () => uuid(41)).complete(
    chapterLease, { contract: 'orchestration-chapter-receipt-v2', chapter_key: 'chapter-1', chapter_node_id: uuid(60),
      source_snapshot_hash: hash('source'), receipt_hash: hash('receipt') } as never),
  { code: 'ORCHESTRATION_V2_CHAPTER_WRITE_UNCONFIRMED' });
});

test('chapter validation accepts an author-edited chapter title and reads the revision-zero baselines', async () => {
  const authority = (currentRevision: unknown) => database(sql => {
    if (/r\.status AS run_status,r\.manifest_hash/.test(sql)) {
      return [{ workspace_status: 'drafting', blueprint_id: null, run_status: 'executing', manifest_hash: hash('m'),
        snapshot_status: 'sealed', canonical_path: 'chapter_1', kind: 'chapter', content_state: 'content_ready',
        current_revision: currentRevision, task_key: 'content:chapter-1:validate', execution_budget_ms: 120_000 }];
    }
    if (/a\.artifact_kind IN \('architecture_validation','inventory_receipt'\)/.test(sql)) return [];
    return undefined;
  });
  const chapterLease = lease({ kind: 'validate_chapter', node_id: uuid(60), ai_reservation_id: null });
  for (const revision of [0, '2', 7]) {
    const f = authority(revision);
    // Past the authority check (an edited title is fine), the empty evidence stops it.
    await assert.rejects(createOrchestrationV2ChapterRepository(f.db, {} as never).load(chapterLease),
      { code: 'ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID' });
  }
  for (const revision of [null, -1, 'x']) {
    await assert.rejects(createOrchestrationV2ChapterRepository(authority(revision).db, {} as never).load(chapterLease),
      { code: 'ORCHESTRATION_V2_CHAPTER_AUTHORITY_INVALID' });
  }
});
