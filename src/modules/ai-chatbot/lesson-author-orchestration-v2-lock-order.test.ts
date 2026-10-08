import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createOrchestrationV2QuotaAccounting } from './lesson-author-orchestration-v2-accounting.service.js';
import { orchestrationV2DispatchEnvelope } from './lesson-author-orchestration-v2-dispatch.logic.js';
import {
  ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY,
  ORCHESTRATION_V2_TRANSIENT_DB_REQUEUE_EPOCH_LIMIT,
  isOrchestrationV2TransientRetryExhausted,
  orchestrationV2TransientDbRequeueDelayMs,
  orchestrationV2TransientRetryDelayMs,
  withOrchestrationV2TransactionRetry,
  withOrchestrationV2TransientRetry,
} from './lesson-author-orchestration-v2-lock-order.js';
import { createOrchestrationV2OutboxRepository } from './lesson-author-orchestration-v2-outbox.repository.js';
import { runOrchestrationV2WorkerRecoveryLoop } from './lesson-author-orchestration-v2-rabbit.service.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import {
  createOrchestrationV2WorkerRepository,
  type OrchestrationV2TaskLease,
} from './lesson-author-orchestration-v2-worker.repository.js';
import {
  handleOrchestrationV2Delivery,
  type OrchestrationV2WorkerRuntimeDependencies,
} from './lesson-author-orchestration-v2-worker.service.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (value: string) => orchestrationV2Hash(value);
const OUTBOX = uuid(1), RUN = uuid(2), TASK = uuid(3), WORKSPACE = uuid(4), TENANT = uuid(5);
const LEASE_TOKEN = uuid(9), RESERVATION = uuid(10), COURSE = 'course-v1:lock+order+2026';
const INPUT_TOKENS = 200_000, OUTPUT_TOKENS = 65_536, PROVIDER_ATTEMPTS = 2;
const RESERVED_TOTAL = INPUT_TOKENS + OUTPUT_TOKENS * PROVIDER_ATTEMPTS;
const limits = { global_concurrency_limit: 6, provider_concurrency_limit: 4, lease_seconds: 30 };
const envelope = orchestrationV2DispatchEnvelope({
  outbox_id: OUTBOX, run_id: RUN, task_id: TASK, dispatch_epoch: 0, routing_shard: 19,
});
const noSleep = { sleep: async () => undefined, random: () => 0 };
const pgError = (code: string, message = 'deadlock detected') => Object.assign(new Error(message), { code });

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK, run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT, course_id: COURSE,
    task_key: 'content:chapter-1:unit:1', kind: 'generate_unit', chapter_key: 'chapter-1', node_id: uuid(6),
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(7),
    source_snapshot_hash: hash('source'), runtime_config_hash: hash('runtime'), model: 'model', locale: 'vi',
    input_tokens: INPUT_TOKENS, embedding_tokens: 0, max_output_tokens: OUTPUT_TOKENS,
    provider_max_attempts: PROVIDER_ATTEMPTS, execution_budget_ms: 600_000, lease_token: null,
    dispatch_epoch: 0, ai_reservation_id: null, attempt_count: 0, max_attempts: 2, status: 'queued',
    run_status: 'executing', outbox_status: 'published', tenant_concurrency_limit: 4,
    workspace_concurrency_limit: 4, dispatch_started_at: null, accounting_state: 'not_required',
    provider_replay_required: false, routing_shard: 19, ...overrides,
  };
}

function lease(overrides: Partial<OrchestrationV2TaskLease> = {}): OrchestrationV2TaskLease {
  return {
    task_id: TASK, run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT, course_id: COURSE,
    task_key: 'content:chapter-1:unit:1', kind: 'generate_unit', chapter_key: 'chapter-1', node_id: uuid(6),
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(7),
    source_snapshot_hash: hash('source'), runtime_config_hash: hash('runtime'), model: 'model', locale: 'vi',
    max_output_tokens: OUTPUT_TOKENS, provider_max_attempts: PROVIDER_ATTEMPTS, execution_budget_ms: 600_000,
    lease_token: LEASE_TOKEN, dispatch_epoch: 1, provider_replay_required: false, routing_shard: 19,
    ai_reservation_id: RESERVATION, ...overrides,
  };
}

const runningTask = (overrides: Record<string, unknown> = {}) => taskRow({ status: 'running',
  lease_token: LEASE_TOKEN, attempt_count: 1, dispatch_epoch: 1, ai_reservation_id: RESERVATION,
  accounting_state: 'reserved', ...overrides });

type Route = (sql: string, params: unknown[]) => Record<string, unknown>[] | undefined;

/** Plausible rows for every statement the worker, outbox and accounting code issues. */
const baseRoute: Route = sql => {
  // Worker recovery candidates (plain reads) first: they embed status lists used below.
  if (/t\.status IN \('failed','timed_out','outcome_unknown'\)/.test(sql)) return [];
  if (/r\.status='needs_action'/.test(sql)) return [];
  if (/SELECT t\.id::text AS task_id/.test(sql)) {
    return [{ task_id: TASK, run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT }];
  }
  if (/FROM courses WHERE id=\$1 AND deleted_at IS NULL FOR UPDATE/.test(sql)) return [];
  if (/pg_advisory_xact_lock/.test(sql)) return [{}];
  if (/FROM ai_token_monthly_usage usage[\s\S]*FOR UPDATE OF usage/.test(sql)) return [{ tenant_id: TENANT }];
  if (/^INSERT INTO ai_token_reservations/.test(sql)) return [{ id: RESERVATION }];
  if (/^UPDATE ai_token_monthly_usage/.test(sql)) return [];
  if (/^UPDATE ai_token_reservations SET status/.test(sql)) return [];
  if (/^INSERT INTO ai_token_usage_ledger/.test(sql)) return [];
  if (/SELECT o\.tenant_id::text,o\.workspace_id::text/.test(sql)) return [{ tenant_id: TENANT, workspace_id: WORKSPACE }];
  if (/SELECT t\.\*,r\.source_snapshot_id::text/.test(sql)) return [taskRow()];
  if (/FROM lesson_author_workspace_v2_dependencies d\s+JOIN lesson_author_workspace_v2_tasks p/.test(sql)) return [{ count: 0 }];
  if (/global_running/.test(sql) && /provider_running/.test(sql) && !/WITH scheduler_clock/.test(sql)) {
    return [{ global_running: 0, provider_running: 0, tenant_running: 0, workspace_running: 0 }];
  }
  if (/SELECT w\.requested_by::text/.test(sql)) {
    return [{ requested_by: uuid(11), conversation_id: uuid(12), correlation_id: uuid(13) }];
  }
  if (/SELECT id::text,status,estimated_tokens::text,budget_metadata\s+FROM ai_token_reservations/.test(sql)) {
    return [{ id: RESERVATION, status: 'reserved', estimated_tokens: String(RESERVED_TOTAL),
      budget_metadata: { orchestration_task_id: TASK, orchestration_run_id: RUN } }];
  }
  if (/SET status='running'/.test(sql)) {
    return [runningTask({ dispatch_epoch: 1, attempt_count: 1, ai_reservation_id: RESERVATION })];
  }
  if (/SET status='consumed'/.test(sql)) return [{ id: OUTBOX }];
  if (/WITH authority AS/.test(sql)) return [{ delay_ms: 7_500, capacity_deferral_count: 1 }];
  if (/WITH scheduler_clock AS/.test(sql)) {
    return [{ outbox_id: OUTBOX, run_id: RUN, task_id: TASK, tenant_id: TENANT, workspace_id: WORKSPACE,
      task_kind: 'generate_unit' }];
  }
  if (/SET heartbeat_at=clock_timestamp\(\)/.test(sql)) return [{ id: TASK }];
  if (/SET dispatch_started_at=clock_timestamp\(\)/.test(sql)) return [{ id: TASK }];
  if (/SELECT \* FROM lesson_author_workspace_v2_tasks/.test(sql)) {
    return [runningTask({ dispatch_started_at: new Date() })];
  }
  if (/r\.budget_input_tokens::text/.test(sql)) return [{ id: RESERVATION, status: 'reserved' }];
  if (/SELECT r\.status,/.test(sql)) return [{ status: 'finalized', ledger_count: 1 }];
  if (/SELECT id::text FROM ai_token_reservations/.test(sql)) return [{ id: RESERVATION }];
  if (/SELECT status FROM ai_token_reservations/.test(sql)) return [{ status: 'released' }];
  if (/UPDATE ai_token_reservations SET budget_metadata/.test(sql)) {
    return [{ id: RESERVATION, status: 'reserved', budget_metadata: {
      orchestration_v2_accounting: { state: 'pending_reconciliation', task_id: TASK } } }];
  }
  if (/t\.status='outcome_unknown' AND t\.accounting_state='pending_reconciliation'/.test(sql)) {
    return [{ id: RESERVATION, status: 'reserved', estimated_tokens: String(RESERVED_TOTAL) }];
  }
  if (/INSERT INTO lesson_author_workspace_v2_artifacts/.test(sql)) return [{ id: uuid(30) }];
  if (/FROM lesson_author_workspace_nodes[\s\S]*FOR UPDATE/.test(sql)) return [{ id: uuid(6) }];
  if (/INSERT INTO lesson_author_workspace_revisions/.test(sql)) return [{ node_id: uuid(6), revision: 0 }];
  if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 1 }];
  if (/SET status='succeeded'/.test(sql)) return [{ id: TASK }];
  if (/SET status='failed'/.test(sql)) return [{ id: TASK }];
  if (/SET status='outcome_unknown'/.test(sql)) return [{ id: TASK }];
  if (/SET status='queued'/.test(sql)) return [{ id: TASK }];
  if (/INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(sql)) return [{ id: uuid(31) }];
  if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'executing' }];
  if (/SELECT status FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'executing' }];
  if (/WITH RECURSIVE descendants/.test(sql)) return [];
  if (/status IN \('blocked','queued','running'\)/.test(sql)) return [{ count: 3 }];
  if (/SELECT t\.\*,coalesce\(o\.routing_shard,0\)/.test(sql)) return [runningTask()];
  if (/SELECT t\.\*,r\.status AS run_status/.test(sql)) {
    return [runningTask({ dispatch_started_at: new Date(), run_status: 'executing' })];
  }
  if (/WITH eligible AS/.test(sql)) {
    return [{ outbox_id: OUTBOX, run_id: RUN, task_id: TASK, dispatch_epoch: 0, routing_shard: 19,
      lease_token: uuid(40), attempt_count: 1 }];
  }
  if (/SET status='published'/.test(sql)) return [{ id: OUTBOX }];
  if (/status=CASE WHEN \$6::boolean THEN 'dead' ELSE 'pending' END/.test(sql)) return [{ status: 'pending' }];
  if (/WITH candidate AS/.test(sql)) return [{ status: 'pending' }];
  return undefined;
};

/** Recording database: every transaction keeps its own ordered statement list. */
function recordingDatabase(route: Route = baseRoute) {
  const transactions: string[][] = [];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const events: string[] = [];
  let active: { statements: string[]; tx: GenerationJobSql } | null = null;
  const db: GenerationJobDatabase = {
    async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
      const statements: string[] = [];
      transactions.push(statements);
      const tx: GenerationJobSql = {
        async query<R extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
          statements.push(sql);
          calls.push({ sql, params });
          const rows = route(sql, params);
          assert.notEqual(rows, undefined, `unexpected SQL: ${sql}`);
          return { rows: rows as R[], rowCount: rows!.length };
        },
      };
      active = { statements, tx };
      events.push('BEGIN');
      try {
        const value = await work(tx);
        events.push('COMMIT');
        return value;
      } catch (error) {
        events.push('ROLLBACK');
        throw error;
      } finally {
        active = null;
      }
    },
  };
  /** AI token service statements run on the ambient transaction client in production. */
  const ambient = async (sql: string) => {
    assert.ok(active, 'AI token statement outside the caller transaction');
    await active.tx.query(sql, []);
  };
  return { db, transactions, calls, events, ambient };
}

/** The real V2 accounting service; its AI-token dependencies replay the SQL
 * shapes of ai-token-quota.service on the same transaction. */
function accountingFor(ambient: (sql: string) => Promise<void>) {
  const settings = {
    tenantId: TENANT, activeEngine: 'self_built_rag' as const, provider: 'google_ai_studio' as const,
    monthlyTokenLimit: null, tokenTimezone: 'Asia/Saigon', chatModel: 'chat', lessonAuthorModel: 'model',
    embeddingModel: 'gemini-embedding-001', embeddingDimensions: 768, transitionState: 'idle' as const,
    activeTransitionJobId: null, hasGoogleAiStudioKey: true, apiKeyFingerprint: 'fingerprint',
  };
  return createOrchestrationV2QuotaAccounting({
    settings: async () => settings,
    reserve: async input => {
      await ambient(`SELECT usage.total_tokens::text FROM ai_token_monthly_usage usage
        JOIN tenant_ai_settings settings ON settings.tenant_id=usage.tenant_id FOR UPDATE OF usage, settings`);
      await ambient('INSERT INTO ai_token_reservations (tenant_id) VALUES ($1) RETURNING id');
      await ambient('UPDATE ai_token_monthly_usage SET reserved_tokens=reserved_tokens+$3');
      const total = input.maximumTokens ?? 0;
      return { id: RESERVATION, reservedTokens: total, minimumTokens: total, maximumTokens: total,
        remainingTokens: null, isPartialGrant: false };
    },
    // finalizeTenantAiTokens: reservation update (size grows) before the usage update.
    finalize: async () => {
      await ambient(`UPDATE ai_token_reservations SET status='finalized' WHERE id=$1`);
      await ambient('UPDATE ai_token_monthly_usage SET total_tokens=total_tokens+$6');
      await ambient('INSERT INTO ai_token_usage_ledger (reservation_id) VALUES ($1)');
    },
    release: async () => {
      await ambient(`UPDATE ai_token_reservations SET status='released' WHERE id=$1`);
      await ambient('UPDATE ai_token_monthly_usage SET reserved_tokens=reserved_tokens-$3');
    },
  });
}

/*
 * PostgreSQL lock model used by the order assertions. Each statement acquires,
 * in this order: its explicit advisory/row locks, then for a write to a
 * course-scoped Lesson Author table the deletion-fence course row (C, BEFORE
 * ROW trigger) and finally the tenant quota lock (Q, AFTER STATEMENT trigger).
 * AI token tables are quota-registered but not course-scoped (Q only); the
 * monthly usage row is M. Global rank: G < T < W < C < M < Q.
 */
type MutexLock = 'G' | 'T' | 'W' | 'C' | 'M' | 'Q';
const RANK: Record<MutexLock, number> = { G: 0, T: 1, W: 2, C: 3, M: 4, Q: 5 };

function statementLocks(sql: string): MutexLock[] {
  const locks: MutexLock[] = [];
  if (/'la:v2:global'/.test(sql)) locks.push('G');
  if (/'la:v2:tenant:'/.test(sql)) locks.push('T');
  if (/'la:v2:workspace:'/.test(sql)) locks.push('W');
  if (/20260907/.test(sql)) locks.push('Q');
  if (/FROM courses\b[\s\S]*FOR UPDATE/.test(sql)) locks.push('C');
  if (/FROM ai_token_monthly_usage\b[\s\S]*FOR UPDATE/.test(sql)) locks.push('M');
  if (/\b(?:UPDATE|INSERT INTO)\s+lesson_author_workspace\w*/.test(sql)) locks.push('C', 'Q');
  if (/\bUPDATE\s+ai_token_monthly_usage\b/.test(sql)) locks.push('M', 'Q');
  if (/\b(?:UPDATE|INSERT INTO)\s+ai_token_(?:reservations|usage_ledger)\b/.test(sql)) locks.push('Q');
  return locks;
}

function firstAcquisitions(statements: readonly string[]): MutexLock[] {
  const order: MutexLock[] = [];
  for (const sql of statements) {
    for (const lock of statementLocks(sql)) if (!order.includes(lock)) order.push(lock);
  }
  return order;
}

function assertGlobalOrder(name: string, statements: readonly string[]): MutexLock[] {
  const order = firstAcquisitions(statements);
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(RANK[order[index - 1]!] < RANK[order[index]!],
      `${name} acquires ${order.join(' -> ')}, violating G -> T -> W -> C -> M -> Q`);
  }
  return order;
}

/** Two transactions can deadlock on these locks when they acquire a pair in opposite orders. */
function inversions(left: readonly MutexLock[], right: readonly MutexLock[]): string[] {
  const found: string[] = [];
  for (const first of left) {
    for (const second of left) {
      if (left.indexOf(first) >= left.indexOf(second) || !right.includes(first) || !right.includes(second)) continue;
      if (right.indexOf(second) < right.indexOf(first)) found.push(`${first}/${second}`);
    }
  }
  return found;
}

test('transient retry backs off exponentially with bounded jitter and only for 40P01/40001', async () => {
  const delays: number[] = [];
  let attempts = 0;
  const value = await withOrchestrationV2TransientRetry(async attempt => {
    attempts = attempt;
    if (attempt < 4) throw pgError(attempt % 2 === 0 ? '40001' : '40P01');
    return 'committed';
  }, { random: () => 0, sleep: async delay => { delays.push(delay); } });
  assert.equal(value, 'committed');
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [25, 50, 100], 'equal jitter lower bound doubles per retry');

  for (let failed = 1; failed <= 12; failed += 1) {
    const cap = Math.min(ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY.max_delay_ms,
      ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY.base_delay_ms * 2 ** (failed - 1));
    for (const random of [0, 0.5, 0.999_999, 7, -1, Number.NaN]) {
      const delay = orchestrationV2TransientRetryDelayMs(failed, ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY, () => random);
      assert.ok(delay >= Math.floor(cap / 2) && delay <= cap, `delay ${delay} outside [${cap / 2}, ${cap}]`);
      assert.ok(delay <= ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY.max_delay_ms);
    }
  }

  for (const code of ['23514', '42703', '55P03', undefined]) {
    let calls = 0;
    const failure = Object.assign(new Error('not transient'), { code });
    await assert.rejects(() => withOrchestrationV2TransientRetry(async () => { calls += 1; throw failure; }, noSleep),
      error => error === failure);
    assert.equal(calls, 1, `${String(code)} must not be retried`);
  }
});

test('exhausted retries are bounded, marked, and never multiplied by an outer boundary', async () => {
  let calls = 0;
  const deadlock = pgError('40P01');
  const inner = () => withOrchestrationV2TransientRetry(async () => { calls += 1; throw deadlock; }, noSleep);
  await assert.rejects(() => withOrchestrationV2TransientRetry(inner, noSleep), error => error === deadlock);
  assert.equal(calls, ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY.max_attempts);
  assert.equal(isOrchestrationV2TransientRetryExhausted(deadlock), true);

  const controller = new AbortController();
  let abortedCalls = 0;
  await assert.rejects(() => withOrchestrationV2TransientRetry(async () => {
    abortedCalls += 1;
    throw pgError('40P01');
  }, { signal: controller.signal, random: () => 0, sleep: async () => { controller.abort(new Error('shutdown')); } }),
  /shutdown/);
  assert.equal(abortedCalls, 1, 'an aborted task never starts another transaction');
});

test('transaction decorator re-runs the whole transaction from BEGIN after a deadlock', async () => {
  const f = recordingDatabase();
  let attempts = 0;
  const db = withOrchestrationV2TransactionRetry(f.db, noSleep);
  const value = await db.transaction(async tx => {
    attempts += 1;
    await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET heartbeat_at=clock_timestamp() WHERE id=$1`, [TASK]);
    if (attempts === 1) throw pgError('40P01');
    return attempts;
  });
  assert.equal(value, 2);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
  assert.equal(f.transactions.length, 2);
});

test('the pre-fix statement orders contain the production C/Q cycle and the checker detects it', () => {
  const oldDefer = [
    `SELECT pg_advisory_xact_lock(hashtextextended(tenant_id::text,20260907)) AS locked
      FROM lesson_author_workspace_v2_dispatch_outbox WHERE id=$1`,
    `WITH authority AS (SELECT outbox.id FROM lesson_author_workspace_v2_dispatch_outbox outbox FOR UPDATE OF outbox),
      deferred AS (UPDATE lesson_author_workspace_v2_dispatch_outbox outbox SET status='pending') SELECT 1`,
  ];
  const oldMarkPublished = [
    `SELECT pg_advisory_xact_lock(hashtextextended(tenant_id::text,20260907)) AS locked
      FROM lesson_author_workspace_v2_dispatch_outbox WHERE id=$1`,
    `UPDATE lesson_author_workspace_v2_dispatch_outbox SET status='published' WHERE id=$1`,
  ];
  const oldProviderClaim = [
    `SELECT pg_advisory_xact_lock(hashtextextended('la:v2:global',0)),
      pg_advisory_xact_lock(hashtextextended('la:v2:tenant:'||$1,0)),
      pg_advisory_xact_lock(hashtextextended('la:v2:workspace:'||$2,0))`,
    'SELECT usage.total_tokens FROM ai_token_monthly_usage usage FOR UPDATE OF usage, settings',
    'INSERT INTO ai_token_reservations (tenant_id) VALUES ($1)',
    `UPDATE lesson_author_workspace_v2_tasks SET status='running' WHERE id=$1`,
  ];
  const dispatchFence = [
    `SELECT pg_advisory_xact_lock(hashtextextended('la:v2:workspace:'||$1::text,0))`,
    'UPDATE lesson_author_workspace_v2_tasks SET dispatch_started_at=clock_timestamp() WHERE id=$1',
  ];
  assert.deepEqual(firstAcquisitions(oldDefer), ['Q', 'C']);
  assert.deepEqual(firstAcquisitions(oldMarkPublished), ['Q', 'C']);
  assert.deepEqual(firstAcquisitions(oldProviderClaim), ['G', 'T', 'W', 'M', 'Q', 'C']);
  assert.deepEqual(firstAcquisitions(dispatchFence), ['W', 'C', 'Q']);
  assert.deepEqual(inversions(firstAcquisitions(oldDefer), firstAcquisitions(dispatchFence)), ['Q/C']);
  assert.deepEqual(inversions(firstAcquisitions(oldMarkPublished), firstAcquisitions(dispatchFence)), ['Q/C']);
  assert.throws(() => assertGlobalOrder('pre-fix deferral', oldDefer), /violating/);
  assert.throws(() => assertGlobalOrder('pre-fix provider claim', oldProviderClaim), /violating/);
});

test('every worker, dispatcher and accounting transaction acquires G -> T -> W -> C -> M -> Q', async () => {
  const f = recordingDatabase();
  const worker = createOrchestrationV2WorkerRepository(f.db, () => uuid(50), { retry: noSleep });
  const outbox = createOrchestrationV2OutboxRepository(f.db, () => uuid(40), { retry: noSleep });
  const accounting = accountingFor(f.ambient);
  const named: Array<[string, string[]]> = [];
  const capture = async (name: string, run: () => Promise<unknown>) => {
    const before = f.transactions.length;
    await run();
    assert.equal(f.transactions.length, before + 1, `${name} must be exactly one transaction`);
    named.push([name, f.transactions[f.transactions.length - 1]!]);
  };
  const usage = { inputTokens: 10, outputTokens: 20, embeddingTokens: 0, totalTokens: 30 };
  const unitHooks = {
    beforeSuccess: async (tx: GenerationJobSql) => {
      await tx.query(`SELECT id::text FROM lesson_author_workspace_nodes WHERE workspace_id=$1 ORDER BY canonical_path FOR UPDATE`);
      await tx.query('INSERT INTO lesson_author_workspace_revisions (workspace_id) VALUES ($1) RETURNING node_id,revision');
      await tx.query(`INSERT INTO lesson_author_workspace_events (workspace_id,event_kind) VALUES ($1,'unit_ready') RETURNING sequence`);
    },
    afterSuccess: async (tx: GenerationJobSql) => {
      await tx.query(`UPDATE lesson_author_workspace_v2_tasks candidate SET status='queued' WHERE candidate.run_id=$1 RETURNING id`);
      await tx.query('INSERT INTO lesson_author_workspace_v2_dispatch_outbox (id) VALUES ($1) RETURNING id');
    },
  };

  await capture('claimExact(provider)', async () => {
    const claim = await worker.claimExact(envelope, limits, accounting.reserveProvider);
    assert.equal(claim.disposition, 'claimed');
  });
  await capture('deferPublished', async () => {
    assert.deepEqual(await worker.deferPublished(envelope, 1_000), { delay_ms: 7_500, deferral_count: 1 });
  });
  await capture('wakeOneCapacityDeferred', () => worker.wakeOneCapacityDeferred(limits));
  await capture('renew', () => worker.renew(lease(), limits.lease_seconds));
  await capture('markProviderDispatched', () => worker.markProviderDispatched(lease()));
  await capture('succeed(provider unit)', () => worker.succeed(lease(), hash('artifact'), 'orchestration-unit-baseline-v2',
    usage, { artifact_kind: 'unit_baseline', artifact_hash: hash('artifact'), payload: { contract_version: 2 },
      validation_contract: 'orchestration-unit-baseline-v2' }, accounting.settleProvider, unitHooks));
  await capture('failProviderRejected', () => worker.failProviderRejected(lease(), 'AI_PROVIDER_REQUEST_REJECTED',
    accounting.releaseRejected));
  await capture('recoverClaimFailure(pre-dispatch)', async () => {
    assert.equal(await worker.recoverClaimFailure(lease(), 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED',
      accounting.releaseUndispatched, accounting.holdUnknown, accounting.reconcileUnknownAsBudget), 'requeued');
  });
  await capture('recoverOne(expired dispatched)', async () => {
    assert.equal(await worker.recoverOne(accounting.releaseUndispatched, accounting.holdUnknown,
      accounting.reconcileUnknownAsBudget), 'requeued');
  });
  await capture('outbox.claimNext', () => outbox.claimNext({ lane_count: 1, lane_index: 0, lease_seconds: 30,
    max_attempts: 5, retry_base_ms: 1_000, retry_max_ms: 60_000, published_recovery_seconds: 120 }));
  const outboxLease = { outbox_id: OUTBOX, run_id: RUN, task_id: TASK, dispatch_epoch: 0, routing_shard: 19,
    lease_token: uuid(40), attempt_count: 1 };
  await capture('outbox.markPublished', () => outbox.markPublished(outboxLease));
  await capture('outbox.releaseAfterPublishFailure', () => outbox.releaseAfterPublishFailure(outboxLease, {
    lane_count: 1, lane_index: 0, lease_seconds: 30, max_attempts: 5, retry_base_ms: 1_000, retry_max_ms: 60_000,
    published_recovery_seconds: 120 }));
  await capture('outbox.recoverOne', () => outbox.recoverOne({ lane_count: 1, lane_index: 0, lease_seconds: 30,
    max_attempts: 5, retry_base_ms: 1_000, retry_max_ms: 60_000, published_recovery_seconds: 120 }));

  // Post-dispatch claim failure: hold + pessimistic reconcile + requeue in one transaction.
  const dispatched = recordingDatabase((sql, params) => /SELECT t\.\*,coalesce\(o\.routing_shard,0\)/.test(sql)
    ? [runningTask({ dispatch_started_at: new Date() })] : baseRoute(sql, params));
  const dispatchedAccounting = accountingFor(dispatched.ambient);
  const dispatchedWorker = createOrchestrationV2WorkerRepository(dispatched.db, () => uuid(50), { retry: noSleep });
  assert.equal(await dispatchedWorker.recoverClaimFailure(lease(), 'AI_RAG_SERVICE_ERROR',
    dispatchedAccounting.releaseUndispatched, dispatchedAccounting.holdUnknown,
    dispatchedAccounting.reconcileUnknownAsBudget), 'requeued');
  named.push(['recoverClaimFailure(post-dispatch)', dispatched.transactions[0]!]);

  const orders = new Map<string, MutexLock[]>();
  for (const [name, statements] of named) {
    assert.ok(!statements.some(sql => /20260907/.test(sql)), `${name} must never take the tenant quota lock explicitly`);
    orders.set(name, assertGlobalOrder(name, statements));
  }
  assert.deepEqual(orders.get('claimExact(provider)'), ['G', 'T', 'W', 'C', 'M', 'Q']);
  assert.deepEqual(orders.get('deferPublished'), ['C', 'Q']);
  assert.deepEqual(orders.get('outbox.markPublished'), ['C', 'Q']);
  assert.deepEqual(orders.get('markProviderDispatched'), ['W', 'C', 'Q']);
  assert.deepEqual(orders.get('succeed(provider unit)'), ['W', 'C', 'M', 'Q']);
  assert.deepEqual(orders.get('recoverClaimFailure(post-dispatch)'), ['W', 'C', 'M', 'Q']);
  for (const [left, leftOrder] of orders) {
    for (const [right, rightOrder] of orders) {
      assert.deepEqual(inversions(leftOrder, rightOrder), [], `${left} and ${right} invert a lock pair`);
    }
  }
  // The course fence precedes the first AI-token write in every accounting path.
  for (const [name, statements] of named) {
    const fence = statements.findIndex(sql => /FROM courses\b/.test(sql));
    const aiWrite = statements.findIndex(sql => /^(?:INSERT INTO|UPDATE) ai_token_/.test(sql));
    if (aiWrite >= 0) assert.ok(fence >= 0 && fence < aiWrite, `${name}: course fence must precede AI token writes`);
  }
});

function deferralDatabase(failDeferral: (attempt: number) => boolean, providerRunning = limits.provider_concurrency_limit) {
  let deferralAttempts = 0;
  const f = recordingDatabase((sql, params) => {
    if (/global_running/.test(sql) && !/WITH scheduler_clock/.test(sql)) {
      return [{ global_running: providerRunning, provider_running: providerRunning, tenant_running: 0,
        workspace_running: 0 }];
    }
    if (/WITH authority AS/.test(sql)) {
      deferralAttempts += 1;
      if (failDeferral(deferralAttempts)) throw pgError('40P01');
    }
    return baseRoute(sql, params);
  });
  return { ...f, deferralAttempts: () => deferralAttempts };
}

test('a deadlocked capacity deferral is retried in a fresh transaction and deferred durably', async () => {
  const delays: number[] = [];
  const f = deferralDatabase(attempt => attempt < 3);
  const worker = createOrchestrationV2WorkerRepository(f.db, () => uuid(50),
    { retry: { random: () => 0, sleep: async delay => { delays.push(delay); } } });
  assert.deepEqual(await worker.deferPublished(envelope, 1_000), { delay_ms: 7_500, deferral_count: 1 });
  assert.equal(f.deferralAttempts(), 3);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
  assert.deepEqual(delays, [25, 50]);
});

test('an exhausted deferral deadlock requeues the delivery and never touches the task', async () => {
  const f = deferralDatabase(() => true);
  const real = createOrchestrationV2WorkerRepository(f.db, () => uuid(50), { retry: noSleep });
  const finalizations: string[] = [];
  const repository = {
    ...real,
    recoverClaimFailure: async () => { finalizations.push('recoverClaimFailure'); return 'failed' as const; },
    failProviderRejected: async () => { finalizations.push('failProviderRejected'); },
  };
  const events: Record<string, unknown>[] = [];
  const result = await handleOrchestrationV2Delivery(JSON.stringify(envelope), {
    repository, limits, reserveProvider: async () => assert.fail('a deferred claim must not reserve'),
    releaseUndispatched: async () => undefined, holdUnknown: async () => undefined,
    releaseRejected: async () => undefined, execute: async () => assert.fail('nothing was claimed'),
    report: event => { events.push(event); },
  } as OrchestrationV2WorkerRuntimeDependencies);
  assert.equal(result.settlement, 'requeue');
  assert.equal(result.disposition, 'claim_unconfirmed');
  assert.equal(f.deferralAttempts(), ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY.max_attempts);
  assert.deepEqual(finalizations, []);
  assert.ok(!f.transactions.flat().some(sql => /UPDATE lesson_author_workspace_v2_tasks/.test(sql)),
    'a capacity deferral never writes the task row');
  assert.ok(events.some(event => event.event === 'worker_delivery_defer_unconfirmed' && event.sqlstate === '40P01'));
  assert.ok(!events.some(event => event.event === 'worker_task_failed'));
});

test('a deadlocked claim transaction is retried from BEGIN and claims exactly once', async () => {
  let claimAttempts = 0;
  const f = recordingDatabase((sql, params) => {
    if (/SET status='running'/.test(sql)) {
      claimAttempts += 1;
      if (claimAttempts === 1) throw pgError('40P01');
    }
    return baseRoute(sql, params);
  });
  const worker = createOrchestrationV2WorkerRepository(f.db, () => uuid(50), { retry: noSleep });
  const accounting = accountingFor(f.ambient);
  const claim = await worker.claimExact(envelope, limits, accounting.reserveProvider);
  assert.equal(claim.disposition, 'claimed');
  assert.equal(claimAttempts, 2);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
  // The rolled-back attempt's reservation/lease vanished with its transaction;
  // the committed attempt re-took every lock in the same global order.
  assertGlobalOrder('retried claim', f.transactions[1]!);
});

function claimFailureDatabase(task: Record<string, unknown>) {
  return recordingDatabase((sql, params) => /SELECT t\.\*,coalesce\(o\.routing_shard,0\)/.test(sql)
    ? [task] : baseRoute(sql, params));
}

test('a pre-dispatch deadlock on the last attempt is requeued with the attempt refunded, not failed', async () => {
  for (const kind of ['generate_unit', 'validate_chapter'] as const) {
    const provider = kind === 'generate_unit';
    const f = claimFailureDatabase(runningTask({ kind, attempt_count: 2, max_attempts: 2, dispatch_epoch: 2,
      ...(provider ? {} : { ai_reservation_id: null, accounting_state: 'not_required' }) }));
    const worker = createOrchestrationV2WorkerRepository(f.db, () => uuid(50), { retry: noSleep });
    const released: string[] = [];
    const disposition = await worker.recoverClaimFailure(
      lease({ kind, dispatch_epoch: 2, ...(provider ? {} : { ai_reservation_id: null }) }),
      'ORCHESTRATION_V2_DB_DEADLOCK_RETRY_EXHAUSTED',
      async () => { released.push('released'); },
      async () => assert.fail('an undispatched claim must not be held as unknown'));
    assert.equal(disposition, 'requeued', `${kind} must not fail on a rolled-back transaction`);
    assert.deepEqual(released, provider ? ['released'] : []);
    const statements = f.transactions[0]!;
    assert.ok(!statements.some(sql => /SET status='failed'/.test(sql)));
    const queued = f.calls.find(call => /attempt_count=CASE WHEN \$4::boolean THEN attempt_count-1/.test(call.sql));
    assert.ok(queued, 'requeue refunds the attempt only for a transient DB failure');
    assert.equal(queued!.params[3], true, 'the attempt is refunded');
    const delayMs = Number(queued!.params[4]);
    assert.ok(delayMs >= 1_000 && delayMs < 31_000, 'the transient requeue backs off before redispatch');
    assert.match(queued!.sql, /dispatch_started_at IS NULL/, 'the refund is fenced to undispatched work');
    assert.match(queued!.sql, /lease_token=\$3::uuid/, 'the refund is fenced by the claim lease');
    const outboxInsert = f.calls.find(call => /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(call.sql));
    assert.equal(outboxInsert?.params[6], 2, 'the new delivery carries the current dispatch epoch');
    assert.equal(outboxInsert?.params[8], delayMs);
  }
});

test('transient refund is bounded by dispatch epoch and never applies after provider dispatch', async () => {
  const capped = claimFailureDatabase(runningTask({ attempt_count: 2, max_attempts: 2,
    dispatch_epoch: ORCHESTRATION_V2_TRANSIENT_DB_REQUEUE_EPOCH_LIMIT }));
  const cappedWorker = createOrchestrationV2WorkerRepository(capped.db, () => uuid(50), { retry: noSleep });
  assert.equal(await cappedWorker.recoverClaimFailure(lease({ dispatch_epoch: ORCHESTRATION_V2_TRANSIENT_DB_REQUEUE_EPOCH_LIMIT }),
    'ORCHESTRATION_V2_DB_DEADLOCK_RETRY_EXHAUSTED', async () => undefined, async () => undefined), 'failed');

  const real = claimFailureDatabase(runningTask({ attempt_count: 2, max_attempts: 2, dispatch_epoch: 2 }));
  const realWorker = createOrchestrationV2WorkerRepository(real.db, () => uuid(50), { retry: noSleep });
  assert.equal(await realWorker.recoverClaimFailure(lease({ dispatch_epoch: 2 }), 'AI_RAG_SERVICE_ERROR',
    async () => undefined, async () => undefined), 'failed', 'a real failure on the last attempt still fails');

  const dispatched = claimFailureDatabase(runningTask({ attempt_count: 1, max_attempts: 2,
    dispatch_started_at: new Date() }));
  const accounting = accountingFor(dispatched.ambient);
  const dispatchedWorker = createOrchestrationV2WorkerRepository(dispatched.db, () => uuid(50), { retry: noSleep });
  assert.equal(await dispatchedWorker.recoverClaimFailure(lease(), 'ORCHESTRATION_V2_DB_DEADLOCK_RETRY_EXHAUSTED',
    accounting.releaseUndispatched, accounting.holdUnknown, accounting.reconcileUnknownAsBudget), 'requeued');
  const statements = dispatched.transactions[0]!;
  assert.ok(statements.some(sql => /SET status='outcome_unknown'/.test(sql)), 'dispatched work keeps the unknown-outcome path');
  assert.ok(!statements.some(sql => /attempt_count=CASE/.test(sql)), 'dispatched work never gets an attempt refund');

  assert.equal(orchestrationV2TransientDbRequeueDelayMs(1, 0), 1_000);
  assert.equal(orchestrationV2TransientDbRequeueDelayMs(3, 4_321), 4_321);
  assert.equal(orchestrationV2TransientDbRequeueDelayMs(50, 999), 30_999);
});

test('a dispatch-fence deadlock on a claimed unit is requeued end to end instead of failing the run', async () => {
  const f = claimFailureDatabase(runningTask({ attempt_count: 2, max_attempts: 2, dispatch_epoch: 2 }));
  const real = createOrchestrationV2WorkerRepository(f.db, () => uuid(50), { retry: noSleep });
  const claimed = lease({ dispatch_epoch: 2 });
  const events: Record<string, unknown>[] = [];
  const result = await handleOrchestrationV2Delivery(JSON.stringify({ ...envelope, dispatch_epoch: 1 }), {
    repository: { ...real, claimExact: async () => ({ disposition: 'claimed', lease: claimed }),
      wakeOneCapacityDeferred: async () => null, renew: async () => true },
    limits, reserveProvider: async () => RESERVATION, releaseUndispatched: async () => undefined,
    holdUnknown: async () => assert.fail('no provider call crossed the fence'), releaseRejected: async () => undefined,
    execute: async () => {
      throw Object.assign(pgError('40P01'), { orchestration_stage: 'provider_dispatch_fence' });
    },
    report: event => { events.push(event); },
  } as OrchestrationV2WorkerRuntimeDependencies);
  assert.equal(result.settlement, 'ack', 'post-claim authority stays in the database, never the broker');
  const finalized = events.find(event => event.event === 'worker_claim_failure_finalized');
  assert.equal(finalized?.failure_code, 'ORCHESTRATION_V2_DB_DEADLOCK_RETRY_EXHAUSTED');
  assert.equal(finalized?.recovery, 'requeued');
  assert.equal(finalized?.execution_stage, 'provider_dispatch_fence');
  assert.ok(!f.transactions.flat().some(sql => /SET status='failed'|UPDATE lesson_author_workspace_v2_runs/.test(sql)));
});

test('a deadlocked heartbeat keeps the claimed task running until the next renewal', async () => {
  let renewals = 0;
  let aborted = false;
  const events: Record<string, unknown>[] = [];
  const result = await handleOrchestrationV2Delivery(JSON.stringify(envelope), {
    repository: {
      claimExact: async () => ({ disposition: 'claimed', lease: lease() }),
      renew: async () => { renewals += 1; throw pgError('40P01'); },
      wakeOneCapacityDeferred: async () => null,
    } as never,
    limits: { ...limits, lease_seconds: 5 }, reserveProvider: async () => RESERVATION,
    releaseUndispatched: async () => undefined, holdUnknown: async () => undefined,
    releaseRejected: async () => undefined,
    execute: async (_lease, signal) => {
      while (renewals === 0) await new Promise(resolve => setTimeout(resolve, 50));
      await new Promise(resolve => setTimeout(resolve, 20));
      aborted = signal.aborted;
    },
    report: event => { events.push(event); },
  });
  assert.equal(result.disposition, 'claimed_succeeded');
  assert.equal(aborted, false);
  assert.ok(events.some(event => event.event === 'worker_heartbeat_transient_failure' && event.sqlstate === '40P01'));
  assert.ok(!events.some(event => event.event === 'worker_heartbeat_failed'));
});

test('a second consecutive heartbeat deadlock aborts before the lease can expire', async () => {
  let renewals = 0;
  let abortedAtRenewal = 0;
  const events: Record<string, unknown>[] = [];
  const deadlock = pgError('40P01');
  const recovered: string[] = [];
  const result = await handleOrchestrationV2Delivery(JSON.stringify(envelope), {
    repository: {
      claimExact: async () => ({ disposition: 'claimed', lease: lease() }),
      renew: async () => { renewals += 1; throw deadlock; },
      recoverClaimFailure: async (_lease: unknown, code: string) => { recovered.push(code); return 'requeued'; },
      wakeOneCapacityDeferred: async () => null,
    } as never,
    limits: { ...limits, lease_seconds: 5 }, reserveProvider: async () => RESERVATION,
    releaseUndispatched: async () => undefined, holdUnknown: async () => undefined,
    releaseRejected: async () => undefined,
    execute: async (_lease, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
        abortedAtRenewal = renewals;
        reject(signal.reason);
      }, { once: true }));
    },
    report: event => { events.push(event); },
  });
  assert.equal(result.disposition, 'claimed_failed');
  assert.equal(abortedAtRenewal, 2, 'the first failure is tolerated, the second (past half the lease) aborts');
  assert.ok(events.some(event => event.event === 'worker_heartbeat_failed' && event.sqlstate === '40P01'));
  assert.deepEqual(recovered, ['ORCHESTRATION_V2_DB_DEADLOCK_RETRY_EXHAUSTED'],
    'the still-valid lease lets the fenced recovery requeue the task');
});

test('worker recovery loop survives an exhausted deadlock and keeps polling', async () => {
  const exhausted = pgError('40P01');
  await assert.rejects(() => withOrchestrationV2TransientRetry(async () => { throw exhausted; },
    { policy: { max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0 } }));
  const controller = new AbortController();
  const events: Record<string, unknown>[] = [];
  let cycles = 0;
  await runOrchestrationV2WorkerRecoveryLoop({
    deps: {
      repository: {
        recoverOne: async () => {
          cycles += 1;
          if (cycles === 1) throw exhausted;
          controller.abort();
          return null;
        },
        wakeOneCapacityDeferred: async () => null,
      },
      limits, releaseUndispatched: async () => undefined, holdUnknown: async () => undefined,
      report: (event: Record<string, unknown>) => { events.push(event); },
    } as never,
    batch_size: 1, poll_interval_ms: 1, signal: controller.signal,
  });
  assert.equal(cycles, 2);
  assert.ok(events.some(event => event.event === 'worker_recovery_transient_sql_cycle_deferred'));
});
