// Continue / rewrite (SQL 20261020_1500): the recover transaction, its lock
// order and idempotency, the service pre-checks, the AI points estimate and
// the worker-side rules that keep a recovered run moving or stop it cleanly.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthUser } from '../../../../../types/express.js';
import type { GenerationJobDatabase, GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import {
  createOrchestrationV2RecoveryCredit,
  orchestrationV2RecoveryEstimateUsd,
  orchestrationV2UnitCostBase,
} from './lesson-author-orchestration-v2-recovery-credit.service.js';
import { orchestrationV2RecoveryRequestHash } from './lesson-author-orchestration-v2-recovery.logic.js';
import {
  createOrchestrationV2RecoveryRepository,
  type OrchestrationV2RecoverInput,
} from './lesson-author-orchestration-v2-recovery.repository.js';
import { orchestrationV2RecoveryEnabled } from './lesson-author-orchestration-v2-recovery.routes.js';
import { createOrchestrationV2RecoveryService } from './lesson-author-orchestration-v2-recovery.service.js';
import { createOrchestrationV2WorkerRepository } from '../worker/lesson-author-orchestration-v2-worker.repository.js';
import { orchestrationV2DispatchEnvelope } from '../dispatch/lesson-author-orchestration-v2-dispatch.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WORKSPACE = uuid(4), TENANT = uuid(5), USER = uuid(6), CONVERSATION = uuid(7), RUN = uuid(2), OPERATION = uuid(8);
const COURSE = 'course-v1:recovery+2+2026', INVENTORY = uuid(100), FINALIZE = uuid(900), COURSE_NODE = uuid(990);
const owner = { tenantId: TENANT, userId: USER, conversationId: CONVERSATION, courseId: COURSE };
const noSleep = { sleep: async () => undefined, random: () => 0 };
const unitId = (c: number, u: number) => uuid(1000 + c * 10 + u), unitNode = (c: number, u: number) => uuid(3000 + c * 10 + u);
const validateId = (c: number) => uuid(2000 + c), chapterNode = (c: number) => uuid(4000 + c);

type Row = Record<string, unknown>;
type Status = 'succeeded' | 'failed' | 'canceled' | 'outcome_unknown';

function taskRows(chapters: Array<Status[]>, validate: Partial<Record<number, Status>> = {}): Row[] {
  const rows: Row[] = [{ task_id: INVENTORY, ordinal: 11, kind: 'publish_inventory', status: 'succeeded', failure_code: null,
    attempt_count: 1, max_attempts: 2, dispatch_epoch: 1, chapter_key: null, node_id: null, node_path: null,
    node_has_content: false, ai_reservation_id: null, accounting_state: 'not_required', reservation_status: null }];
  let ordinal = 12;
  const terminal = (status: Status) => status === 'succeeded' ? { failure_code: null, attempt_count: 1, dispatch_epoch: 1 }
    : status === 'canceled' ? { failure_code: 'UPSTREAM_UNIT_UNAVAILABLE', attempt_count: 0, dispatch_epoch: 0 }
      : status === 'outcome_unknown' ? { failure_code: 'PROVIDER_OUTCOME_UNKNOWN', attempt_count: 1, dispatch_epoch: 1,
        ai_reservation_id: uuid(7000), accounting_state: 'pending_reconciliation', reservation_status: 'reserved' }
        : { failure_code: 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID', attempt_count: 2, dispatch_epoch: 2 };
  chapters.forEach((units, index) => units.forEach((status, unitIndex) => {
    const c = index + 1, u = unitIndex + 1;
    rows.push({ task_id: unitId(c, u), ordinal: ordinal++, kind: 'generate_unit', status, max_attempts: 2,
      chapter_key: `chapter-${c}`, node_id: unitNode(c, u), node_path: `chapter_${c}.lesson_1.unit_${u}`,
      node_has_content: status === 'succeeded', ai_reservation_id: null, accounting_state: 'not_required',
      reservation_status: null, ...terminal(status) });
  }));
  chapters.forEach((units, index) => {
    const c = index + 1, status = validate[c] ?? (units.every(unit => unit === 'succeeded') ? 'succeeded' : 'canceled');
    rows.push({ task_id: validateId(c), ordinal: ordinal++, kind: 'validate_chapter', status, max_attempts: 2,
      chapter_key: `chapter-${c}`, node_id: chapterNode(c), node_path: `chapter_${c}`, node_has_content: true,
      ai_reservation_id: null, accounting_state: 'not_required', reservation_status: null, ...terminal(status) });
  });
  rows.push({ task_id: FINALIZE, ordinal: ordinal++, kind: 'finalize_course', status: 'canceled', max_attempts: 2,
    chapter_key: null, node_id: null, node_path: null, node_has_content: false, ai_reservation_id: null,
    accounting_state: 'not_required', reservation_status: null, ...terminal('canceled') });
  return rows;
}
function dependencyRows(chapters: Array<Status[]>): Row[] {
  const rows: Row[] = [];
  chapters.forEach((units, index) => units.forEach((_, unitIndex) => {
    rows.push({ task_id: unitId(index + 1, unitIndex + 1), depends_on_task_id: INVENTORY });
    rows.push({ task_id: validateId(index + 1), depends_on_task_id: unitId(index + 1, unitIndex + 1) });
  }));
  chapters.forEach((_, index) => rows.push({ task_id: FINALIZE, depends_on_task_id: validateId(index + 1) }));
  return rows;
}

interface State {
  chapters: Array<Status[]>;
  validate?: Partial<Record<number, Status>>;
  run_status?: string;
  event_head?: number;
  recorded?: Row | null;
  other_active?: boolean;
  generations?: Row[];
  scope?: Row | null;
}

function database(state: State) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const events: string[] = [];
  const counted = (params: unknown[], index: number) => (JSON.parse(String(params[index])) as unknown[]).map(() => ({ id: uuid(1) }));
  const route = (sql: string, params: unknown[]): Row[] | undefined => {
    if (/SET LOCAL lock_timeout/.test(sql) || /\/\* reconcile \*\//.test(sql)) return [];
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/FOR UPDATE OF r,w/.test(sql)) {
      return [{ run_id: RUN, run_status: state.run_status ?? 'needs_action', failure_code: 'RUN_STOPPED_BY_AUTHOR',
        finished_at: '2026-10-20 10:00:00.123456+07', manifest_hash: 'a'.repeat(64), workspace_status: 'needs_action',
        event_head: String(state.event_head ?? 42), completion_receipt: false, review_receipt: false }];
    }
    if (/FROM lesson_author_workspace_v2_recoveries\s+WHERE workspace_id=\$1 AND idempotency_key=\$2/.test(sql)) {
      return state.recorded ? [state.recorded] : [];
    }
    if (/lesson_author_session_deletion_jobs/.test(sql)) return [];
    if (/FROM lesson_author_workspace_v2_tasks t[\s\S]*FOR UPDATE OF t/.test(sql)) return taskRows(state.chapters, state.validate);
    if (/FROM lesson_author_workspace_v2_dependencies/.test(sql)) return dependencyRows(state.chapters);
    if (/FROM lesson_author_workspace_v2_recovery_tasks WHERE task_id=ANY/.test(sql)) return state.generations ?? [];
    if (/FROM lesson_author_workspace_nodes\s+WHERE workspace_id=\$1 AND tenant_id=\$2 AND course_id=\$3 AND id=\$4/.test(sql)) {
      return state.scope === null ? [] : [state.scope ?? { node_id: chapterNode(1), kind: 'chapter', canonical_path: 'chapter_1' }];
    }
    if (/FROM courses WHERE id=\$1 AND deleted_at IS NULL FOR UPDATE/.test(sql)) return [];
    if (/AND status IN \('queued','designing','drafting'\) LIMIT 1/.test(sql)) return state.other_active ? [{ id: uuid(77) }] : [];
    if (/SELECT t\.\*,r\.model FROM lesson_author_workspace_v2_tasks t/.test(sql)) {
      return [{ id: params[0], run_id: RUN, status: 'outcome_unknown', model: 'model' }];
    }
    if (/SELECT DISTINCT routing_shard/.test(sql)) return [{ routing_shard: 19 }];
    if (/INSERT INTO lesson_author_workspace_v2_recoveries/.test(sql)) return [{ id: params[0] }];
    if (/INSERT INTO lesson_author_workspace_v2_recovery_tasks/.test(sql)) return counted(params, 5);
    if (/UPDATE lesson_author_workspace_v2_runs\s+SET status='executing'/.test(sql)) return [{ id: RUN }];
    if (/UPDATE lesson_author_workspace_v2_tasks t SET status=x\.reopened_status/.test(sql)) return counted(params, 1);
    if (/INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(sql)) return counted(params, 5);
    if (/UPDATE lesson_author_workspaces SET status='drafting'/.test(sql)) return [{ status: 'drafting' }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 43 }];
    return undefined;
  };
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
  const repository = createOrchestrationV2RecoveryRepository({ db, canEdit: async (scopedTx) => {
    await scopedTx.query(`SET LOCAL lock_timeout='3000ms' /* canEdit fence */`); return true;
  } }, { retry: noSleep });
  return { calls, events, repository };
}

function input(overrides: Partial<OrchestrationV2RecoverInput> = {}, reconcile?: OrchestrationV2RecoverInput['reconcileUnknown'])
  : OrchestrationV2RecoverInput {
  return { operation_id: OPERATION, expected_workspace_revision: 42, request: { action: 'regenerate', node_id: chapterNode(1) },
    max_ai_unit_count: 10, estimated_cost_usd: 0.39, reconcileUnknown: reconcile ?? (async () => assert.fail('no reconcile')),
    ...overrides };
}
const writes = (calls: Array<{ sql: string }>) => calls.filter(call => /^\s*(INSERT|UPDATE)\s/.test(call.sql)
  && !/SET LOCAL/.test(call.sql));

test('rewrite a chapter: one transaction, guard order and exact reopen evidence', async () => {
  const f = database({ chapters: [['succeeded', 'failed'], ['succeeded']] });
  const result = await f.repository.recover(owner, WORKSPACE, input());
  assert.equal(result.action, 'regenerate');
  assert.equal(result.reopened_task_count, 3);
  assert.equal(result.workspace_status, 'drafting');
  assert.equal(result.replayed, false);
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
  const order = f.calls.map(call => call.sql);
  const at = (pattern: RegExp) => { const index = order.findIndex(sql => pattern.test(sql)); assert.ok(index >= 0, String(pattern)); return index; };
  // Permission fence -> W -> run/workspace -> tasks by ordinal -> course fence -> writes in guard order.
  const sequence = [/canEdit fence/, /la:v2:workspace/, /FOR UPDATE OF r,w/, /FOR UPDATE OF t/, /FROM courses WHERE/,
    /INSERT INTO lesson_author_workspace_v2_recoveries\s/, /INSERT INTO lesson_author_workspace_v2_recovery_tasks/,
    /SET status='executing'/, /SET status=x\.reopened_status/, /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/,
    /SET status='drafting'/, /'run_resumed'/].map(at);
  assert.deepEqual([...sequence].sort((left, right) => left - right), sequence);
  assert.match(order[at(/FOR UPDATE OF t/)]!, /ORDER BY t\.ordinal FOR UPDATE OF t/);

  const recovery = f.calls.find(call => /INSERT INTO lesson_author_workspace_v2_recoveries\s/.test(call.sql))!;
  assert.match(recovery.sql, /r\.failure_code,r\.finished_at/, 'the stop is copied from the locked run row, never from JS');
  assert.deepEqual(recovery.params.slice(1), ['regenerate', 'chapter', chapterNode(1), USER, OPERATION,
    orchestrationV2RecoveryRequestHash({ action: 'regenerate', node_id: chapterNode(1), expected_workspace_revision: 42 }),
    3, 1, 0.39, RUN]);
  const logged = JSON.parse(String(f.calls.find(call => /INSERT INTO lesson_author_workspace_v2_recovery_tasks/.test(call.sql))!
    .params[5])) as Row[];
  assert.deepEqual(logged.map(row => [row.task_id, row.generation, row.prior_dispatch_epoch, row.reopen_epoch,
    row.reopened_status]), [[unitId(1, 2), 1, 2, 3, 'queued'], [validateId(1), 1, 0, 1, 'blocked'], [FINALIZE, 1, 0, 1, 'blocked']]);
  const outbox = JSON.parse(String(f.calls.find(call => /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(call.sql))!
    .params[5])) as Row[];
  assert.deepEqual(outbox.map(row => [row.task_id, row.dispatch_epoch]), [[unitId(1, 2), 3]]);
  const event = f.calls.find(call => /'run_resumed'/.test(call.sql))!;
  assert.equal(event.params[3], OPERATION);
});

test('reconcile-before-reopen: a held unknown outcome is settled after the course fence, before any log row', async () => {
  const f = database({ chapters: [['succeeded', 'outcome_unknown']] });
  const settled: string[] = [];
  const result = await f.repository.recover(owner, WORKSPACE, input({}, async (tx, task) => {
    settled.push(String(task.id));
    assert.equal(task.model, 'model');
    await tx.query('SELECT /* reconcile */ 1');
  }));
  assert.equal(result.reopened_task_count, 3);
  assert.deepEqual(settled, [unitId(1, 2)]);
  const order = f.calls.map(call => call.sql);
  const reconcile = order.findIndex(sql => /SELECT t\.\*,r\.model/.test(sql));
  assert.ok(order.findIndex(sql => /FROM courses WHERE/.test(sql)) < reconcile);
  assert.ok(reconcile < order.findIndex(sql => /INSERT INTO lesson_author_workspace_v2_recoveries\s/.test(sql)));
  const logged = JSON.parse(String(f.calls.find(call => /INSERT INTO lesson_author_workspace_v2_recovery_tasks/.test(call.sql))!
    .params[5])) as Row[];
  assert.equal(logged[0]!.prior_status, 'outcome_unknown');
  assert.equal(logged[0]!.prior_ai_reservation_id, uuid(7000));
});

test('idempotency: same operation replays without writes; another body or author is refused', async () => {
  const hash = orchestrationV2RecoveryRequestHash({ action: 'regenerate', node_id: chapterNode(1), expected_workspace_revision: 42 });
  const recorded = { id: uuid(500), run_id: RUN, action: 'regenerate', request_hash: hash, requested_by: USER, reopened_task_count: 3 };
  const replay = database({ chapters: [['succeeded', 'failed']], run_status: 'executing', event_head: 43, recorded });
  const replayed = await replay.repository.recover(owner, WORKSPACE, input());
  assert.deepEqual(replayed, { recovery_id: uuid(500), run_id: RUN, action: 'regenerate', reopened_task_count: 3,
    workspace_status: 'needs_action', replayed: true });
  assert.deepEqual(writes(replay.calls), []);
  for (const conflict of [{ ...recorded, request_hash: 'f'.repeat(64) }, { ...recorded, requested_by: uuid(99) },
    { ...recorded, action: 'resume' }]) {
    const f = database({ chapters: [['succeeded', 'failed']], recorded: conflict });
    await assert.rejects(f.repository.recover(owner, WORKSPACE, input()), { code: 'RECOVERY_IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(writes(f.calls), []);
  }
});

test('stale event head and two tabs racing: the loser changes nothing', async () => {
  const stale = database({ chapters: [['succeeded', 'failed']], event_head: 43 });
  await assert.rejects(stale.repository.recover(owner, WORKSPACE, input()), { code: 'RECOVERY_STATE_CHANGED' });
  assert.deepEqual(writes(stale.calls), []);
  // The other tab committed first (run executing again) and this tab still sent the old head.
  const loser = database({ chapters: [['succeeded', 'failed']], run_status: 'executing', event_head: 43 });
  await assert.rejects(loser.repository.recover(owner, WORKSPACE, input()), { code: 'RECOVERY_STATE_CHANGED' });
  // Even with the new head, an executing run is not reopened.
  const late = database({ chapters: [['succeeded', 'failed']], run_status: 'executing', event_head: 42 });
  await assert.rejects(late.repository.recover(owner, WORKSPACE, input()), { code: 'RECOVERY_STATE_CHANGED' });
  assert.deepEqual(writes(late.calls), []);
});

test('refusals under the lock: limit, other draft running, more lessons than checked, scope and content', async () => {
  const limit = database({ chapters: [['succeeded', 'failed']], generations: [{ task_id: unitId(1, 2), reopens: 3 }] });
  await assert.rejects(limit.repository.recover(owner, WORKSPACE, input()), { code: 'RECOVERY_LIMIT_REACHED' });
  const other = database({ chapters: [['succeeded', 'failed']], other_active: true });
  await assert.rejects(other.repository.recover(owner, WORKSPACE, input()), { code: 'RECOVERY_OTHER_RUN_ACTIVE' });
  assert.deepEqual(writes(other.calls), []);
  const grew = database({ chapters: [['failed', 'failed']] });
  await assert.rejects(grew.repository.recover(owner, WORKSPACE, input({ max_ai_unit_count: 1 })), { code: 'RECOVERY_STATE_CHANGED' });
  const missing = database({ chapters: [['succeeded', 'failed']], scope: null });
  await assert.rejects(missing.repository.recover(owner, WORKSPACE, input()), { code: 'RECOVERY_NOT_FOUND' });
  const component = database({ chapters: [['succeeded', 'failed']], scope: { node_id: uuid(55), kind: 'component',
    canonical_path: 'chapter_1.lesson_1.unit_2.component_1' } });
  await assert.rejects(component.repository.recover(owner, WORKSPACE, input()), { code: 'RECOVERY_NOTHING_TO_DO' });
  const done = database({ chapters: [['succeeded', 'failed']], scope: { node_id: unitNode(1, 1), kind: 'unit',
    canonical_path: 'chapter_1.lesson_1.unit_1' } });
  await assert.rejects(done.repository.recover(owner, WORKSPACE, input({ request: { action: 'regenerate', node_id: unitNode(1, 1) } })),
    { code: 'RECOVERY_UNIT_HAS_CONTENT' });
  for (const f of [limit, grew, missing, component, done]) assert.deepEqual(writes(f.calls), []);
});

test('continue (resume) re-runs free work only: no scope, no AI unit, no cost', async () => {
  const f = database({ chapters: [['succeeded'], ['succeeded']], validate: { 1: 'failed' } });
  const result = await f.repository.recover(owner, WORKSPACE, input({ request: { action: 'resume' }, max_ai_unit_count: 0,
    estimated_cost_usd: 0 }));
  assert.equal(result.action, 'resume');
  assert.equal(result.reopened_task_count, 2);
  const recovery = f.calls.find(call => /INSERT INTO lesson_author_workspace_v2_recoveries\s/.test(call.sql))!;
  assert.deepEqual(recovery.params.slice(1, 4), ['resume', null, null]);
  assert.deepEqual(recovery.params.slice(7, 10), [2, 0, 0]);
  assert.equal(f.calls.some(call => /FROM lesson_author_workspace_nodes\s+WHERE workspace_id=\$1 AND tenant_id=\$2 AND course_id=\$3 AND id=\$4/
    .test(call.sql)), false);
});

test('recover retries a deadlock victim from BEGIN, then reports the real refusal', async () => {
  let attempts = 0;
  const flaky = createOrchestrationV2RecoveryRepository({ db: { transaction: async work => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    return work({ query: async () => ({ rows: [], rowCount: 0 }) } as GenerationJobSql);
  } }, canEdit: async () => false }, { retry: noSleep });
  await assert.rejects(flaky.recover(owner, WORKSPACE, input()), { code: 'RECOVERY_FORBIDDEN' });
  assert.equal(attempts, 2);
});

const author = { id: USER, tenantId: TENANT, role: 'staff', username: 'author', sessionMode: 'normal' } as AuthUser & { tenantId: string };
const target = { workspaceId: WORKSPACE, conversationId: CONVERSATION, courseId: COURSE };

function service(overrides: Record<string, unknown> = {}, snapshotOverrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const tasks = taskRows([['succeeded', 'failed']]).map(row => ({ ...row, generation: 0,
    depends_on: dependencyRows([['succeeded', 'failed']]).filter(dep => dep.task_id === row.task_id).map(dep => String(dep.depends_on_task_id)) }));
  const snapshot = { run: { run_id: RUN, status: 'needs_action', failure_code: 'RUN_STOPPED_BY_AUTHOR', finished_at: 'x',
    manifest_sealed: true, completion_receipt: false, review_receipt: false, workspace_status: 'needs_action', event_head: 42 },
  workspace_status: 'needs_action', event_head: 42, tasks, course_node: { node_id: COURSE_NODE, path: 'course' },
  runtime: { runtime_config_hash: 'c'.repeat(64), model: 'model' },
  scope_node: { node_id: chapterNode(1), kind: 'chapter', path: 'chapter_1' }, recorded: false, ...snapshotOverrides };
  const repository = {
    snapshot: async () => { calls.push('snapshot'); return snapshot; },
    stop: async () => assert.fail('no stop'),
    recover: async (_owner: unknown, _workspace: unknown, value: OrchestrationV2RecoverInput) => {
      calls.push(`recover:${value.max_ai_unit_count}:${value.estimated_cost_usd}`);
      return { recovery_id: uuid(500), run_id: RUN, action: value.request.action, reopened_task_count: 3,
        workspace_status: 'drafting', replayed: false };
    },
  };
  return { calls, service: createOrchestrationV2RecoveryService({
    repository: () => repository as never, canRead: async () => true, stopEnabled: () => true,
    recoveryEnabled: () => true, runtimeCurrent: async () => true,
    assertAffordable: async (_tenant, units) => { calls.push(`credit:${units}`); return 0.585; },
    reconcileUnknown: async () => undefined, ...overrides,
  }) };
}
const command = { operation_id: OPERATION, expected_workspace_revision: 42 };

test('service: gates, pre-checks without locks, AI points only for a rewrite', async () => {
  const ok = service();
  const result = await ok.service.recover(author, target, { action: 'regenerate', node_id: chapterNode(1) }, command);
  assert.equal(result.replayed, false);
  assert.deepEqual(ok.calls, ['snapshot', 'credit:1', 'recover:1:0.585']);

  await assert.rejects(service({ recoveryEnabled: () => false }).service.recover(author, target, { action: 'resume' }, command),
    { code: 'RECOVERY_DISABLED' });
  await assert.rejects(service({ runtimeCurrent: async () => false }).service.recover(author, target,
    { action: 'regenerate', node_id: chapterNode(1) }, command), { code: 'RECOVERY_RUNTIME_CHANGED' });
  await assert.rejects(service({ assertAffordable: async () => { throw Object.assign(new Error('x'),
    { code: 'AI_CREDIT_INSUFFICIENT_FOR_RECOVERY' }); } }).service.recover(author, target,
  { action: 'regenerate', node_id: chapterNode(1) }, command), { code: 'AI_CREDIT_INSUFFICIENT_FOR_RECOVERY' });
  const stale = service();
  await assert.rejects(stale.service.recover(author, target, { action: 'regenerate', node_id: chapterNode(1) },
    { ...command, expected_workspace_revision: 41 }), { code: 'RECOVERY_STATE_CHANGED' });
  assert.deepEqual(stale.calls, ['snapshot']);
  const unknownNode = service({}, { scope_node: null });
  await assert.rejects(unknownNode.service.recover(author, target, { action: 'regenerate', node_id: uuid(66) }, command),
    { code: 'RECOVERY_NOT_FOUND' });
  // Resume ignores any node and plans free work only: here a lesson is missing, so nothing can continue.
  const resume = service();
  await assert.rejects(resume.service.recover(author, target, { action: 'resume' }, command), { code: 'RECOVERY_NOTHING_TO_DO' });
  assert.deepEqual(resume.calls, ['snapshot']);
  // A recorded operation id skips every pre-check and replays in the transaction.
  const replay = service({ runtimeCurrent: async () => assert.fail('no runtime check on replay') },
    { recorded: true, event_head: 50, run: null });
  await replay.service.recover(author, target, { action: 'regenerate', node_id: chapterNode(1) }, command);
  assert.deepEqual(replay.calls, ['snapshot', 'recover:0:0']);
});

test('AI points estimate: tenant median, then global, then the configured fallback; 30% margin', async () => {
  assert.equal(orchestrationV2UnitCostBase({ tenant_median: '0.2', tenant_units: 3, global_median: '0.1', global_units: 9 }, 0.15), 0.2);
  assert.equal(orchestrationV2UnitCostBase({ tenant_median: '0.2', tenant_units: 2, global_median: '0.1', global_units: 9 }, 0.15), 0.1);
  assert.equal(orchestrationV2UnitCostBase({ tenant_median: '0', tenant_units: 5, global_median: null, global_units: 0 }, 0.15), 0.15);
  assert.equal(orchestrationV2UnitCostBase(undefined, 0.15), 0.15);
  assert.equal(orchestrationV2RecoveryEstimateUsd(0.15, 3), 0.585);
  assert.equal(orchestrationV2RecoveryEstimateUsd(0.15, 0), 0);
  assert.throws(() => orchestrationV2RecoveryEstimateUsd(0.15, -1), { code: 'RECOVERY_UNAVAILABLE' });

  const keys: string[] = [];
  const queries: unknown[][] = [];
  const credit = (available: number | null) => createOrchestrationV2RecoveryCredit({
    fallbackUnitCostUsd: () => 0.15,
    cache: async (key, _ttl, loader) => { keys.push(key); return loader(); },
    query: (async (_sql: string, params?: unknown[]) => { queries.push(params ?? []);
      return { rows: [{ tenant_median: '0.2', tenant_units: 4, global_median: '0.1', global_units: 10 }] }; }) as never,
    available: async () => available,
  });
  assert.equal(await credit(null).assertAffordable(TENANT, 2), 0.52);
  assert.equal(await credit(0.52).assertAffordable(TENANT, 2), 0.52);
  await assert.rejects(credit(0.51).assertAffordable(TENANT, 2), { code: 'AI_CREDIT_INSUFFICIENT_FOR_RECOVERY' });
  assert.ok(keys.every(key => key.includes('lesson-author-recovery') && key.includes(TENANT)));
  assert.equal(queries[0]![0], TENANT);
  assert.match(String(queries[0]![1]), /^\^\[0-9a-f\]\{8\}/);
});

test('rollout gate: flag + workspace gates; empty allow-list means every tenant', () => {
  const settings = (overrides: Partial<{ writes: boolean; enabled: boolean; tenant_allowlist: string[] }>) => ({
    writes: true, enabled: true, tenant_allowlist: [] as string[], ...overrides });
  assert.equal(orchestrationV2RecoveryEnabled(TENANT, settings({})), true);
  assert.equal(orchestrationV2RecoveryEnabled(TENANT, settings({ enabled: false })), false);
  assert.equal(orchestrationV2RecoveryEnabled(TENANT, settings({ writes: false })), false);
  assert.equal(orchestrationV2RecoveryEnabled(TENANT, settings({ tenant_allowlist: [uuid(99)] })), false);
  assert.equal(orchestrationV2RecoveryEnabled(TENANT.toUpperCase(), settings({ tenant_allowlist: [TENANT] })), true);
});

test('worker: replay evidence and stale failures count only after the latest reopen', async () => {
  const claimSql: string[] = [];
  const envelope = orchestrationV2DispatchEnvelope({ outbox_id: uuid(1), run_id: RUN, task_id: uuid(3), dispatch_epoch: 0,
    routing_shard: 19 });
  const worker = createOrchestrationV2WorkerRepository({ transaction: async work => work({ query: async (sql: string) => {
    claimSql.push(sql); return { rows: [], rowCount: 0 };
  } } as GenerationJobSql) }, () => uuid(9), { retry: noSleep });
  assert.deepEqual(await worker.claimExact(envelope, { global_concurrency_limit: 4, provider_concurrency_limit: 2,
    lease_seconds: 30 }, async () => uuid(10)), { disposition: 'stale' });
  const recoverSql: string[] = [];
  const sweeper = createOrchestrationV2WorkerRepository({ transaction: async work => work({ query: async (sql: string) => {
    recoverSql.push(sql); return { rows: [], rowCount: 0 };
  } } as GenerationJobSql) }, () => uuid(9), { retry: noSleep });
  assert.equal(await sweeper.recoverOne(async () => undefined, async () => undefined), null);
  assert.match(recoverSql[0]!, /recovery\.created_at>=t\.finished_at/);
  assert.match(recoverSql.at(-1)!, /WHERE r\.status='executing'\s+AND EXISTS\(SELECT 1 FROM lesson_author_workspace_v2_recoveries/);
  // claimExact's first statement is the identity read; the authority row (with the replay rule) follows only on a hit.
  assert.equal(claimSql.length, 1);
  const hit = createOrchestrationV2WorkerRepository({ transaction: async work => work({ query: async (sql: string) => {
    claimSql.push(sql);
    return { rows: /SELECT o\.tenant_id::text/.test(sql) ? [{ tenant_id: TENANT, workspace_id: WORKSPACE }] : [], rowCount: 0 };
  } } as GenerationJobSql) }, () => uuid(9), { retry: noSleep });
  await hit.claimExact(envelope, { global_concurrency_limit: 4, provider_concurrency_limit: 2, lease_seconds: 30 },
    async () => uuid(10));
  const authority = claimSql.find(sql => /provider_replay_required/.test(sql))!;
  assert.match(authority, /prior_attempt\.dispatch_epoch>COALESCE\(\(SELECT max\(reopened\.reopen_epoch\)/);
});

test('worker: a recovered run left without live work is stopped with its remaining failure', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const route = (sql: string): Row[] | undefined => {
    if (/t\.status IN \('failed','timed_out','outcome_unknown'\)/.test(sql)) return [];
    if (/r\.status='needs_action' AND w\.status IN/.test(sql)) return [];
    if (/WHERE t\.status='running' AND \(t\.lease_expires_at/.test(sql)) return [];
    if (/WHERE r\.status='executing'\s+AND EXISTS\(SELECT 1 FROM lesson_author_workspace_v2_recoveries/.test(sql)) {
      return [{ run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT }];
    }
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/AS failure_code\s+FROM lesson_author_workspace_v2_runs r/.test(sql)) {
      return [{ run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT, course_id: COURSE,
        failure_code: 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID' }];
    }
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'executing' }];
    if (/UPDATE lesson_author_workspace_v2_runs\s+SET status='needs_action'/.test(sql)) return [{ id: RUN }];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/count\(\*\)::integer AS count/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: WORKSPACE }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 50 }];
    return undefined;
  };
  const worker = createOrchestrationV2WorkerRepository({ transaction: async work => work({
    query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const rows = route(sql);
      assert.notEqual(rows, undefined, `unexpected SQL: ${sql}`);
      return { rows: rows as T[], rowCount: rows!.length };
    } } as GenerationJobSql) }, () => uuid(9), { retry: noSleep });
  assert.equal(await worker.recoverOne(async () => undefined, async () => undefined), 'reconciled');
  const stop = calls.find(call => /SET status='needs_action',failure_code=\$2/.test(call.sql))!;
  assert.deepEqual(stop.params, [RUN, 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID']);
  const event = calls.find(call => /INSERT INTO lesson_author_workspace_events/.test(call.sql))!;
  assert.match(event.sql, /'run_needs_action'/);
  assert.equal(event.params[3], RUN);
});
