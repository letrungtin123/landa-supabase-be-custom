import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createOrchestrationV2RecoveryRepository } from './lesson-author-orchestration-v2-recovery.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WORKSPACE = uuid(4), TENANT = uuid(5), USER = uuid(6), CONVERSATION = uuid(7), RUN = uuid(2), OPERATION = uuid(8);
const COURSE = 'course-v1:recovery+1+2026';
const owner = { tenantId: TENANT, userId: USER, conversationId: CONVERSATION, courseId: COURSE };
const noSleep = { sleep: async () => undefined, random: () => 0 };

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
  return { db, calls, events };
}

function stopRoute(state: { run_status: string; failure_code?: string | null; running?: number;
  deleting?: boolean; locked?: boolean }): Route {
  return sql => {
    if (/SET LOCAL lock_timeout/.test(sql)) return [];
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/FOR UPDATE OF r,w/.test(sql)) {
      return state.locked === false ? [] : [{ run_id: RUN, run_status: state.run_status,
        failure_code: state.failure_code ?? null, workspace_status: 'drafting' }];
    }
    if (/lesson_author_session_deletion_jobs/.test(sql)) return state.deleting ? [{ id: uuid(99) }] : [];
    if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [{ id: RUN }];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/count\(\*\)::integer AS count/.test(sql)) return [{ count: state.running ?? 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: WORKSPACE }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 9 }];
    if (/SELECT status FROM lesson_author_workspaces/.test(sql)) {
      return [{ status: (state.running ?? 0) > 0 ? 'drafting' : 'needs_action' }];
    }
    return undefined;
  };
}

test('stop: an active run becomes needs_action under the workspace lock and cancels waiting work', async () => {
  const f = database(stopRoute({ run_status: 'executing' }));
  const fenced: string[] = [];
  const repository = createOrchestrationV2RecoveryRepository({ db: f.db, canEdit: async (tx, target) => {
    fenced.push(target.userId); await tx.query('SET LOCAL lock_timeout=\'3000ms\''); return true;
  } }, { retry: noSleep });
  const result = await repository.stop(owner, WORKSPACE, OPERATION);
  assert.deepEqual(result, { recovery_id: null, run_id: RUN, action: 'stop', reopened_task_count: 0,
    workspace_status: 'needs_action', replayed: false });
  assert.deepEqual(fenced, [USER]);
  const order = f.calls.map(call => call.sql);
  const index = (pattern: RegExp) => order.findIndex(sql => pattern.test(sql));
  // Permission fence -> W -> run/workspace rows -> writes (which take C/Q through triggers).
  assert.ok(index(/la:v2:workspace/) > 0);
  assert.ok(index(/la:v2:workspace/) < index(/FOR UPDATE OF r,w/));
  assert.ok(index(/FOR UPDATE OF r,w/) < index(/UPDATE lesson_author_workspace_v2_runs/));
  const runUpdate = f.calls.find(call => /UPDATE lesson_author_workspace_v2_runs/.test(call.sql))!;
  assert.match(runUpdate.sql, /status IN \('planning','executing','finalizing'\)/);
  assert.deepEqual(runUpdate.params, [RUN, 'RUN_STOPPED_BY_AUTHOR']);
  const cancel = f.calls.find(call => /SET status='canceled'/.test(call.sql))!;
  assert.deepEqual(cancel.params, [RUN, 'RUN_STOPPED_BY_AUTHOR']);
  const event = f.calls.find(call => /INSERT INTO lesson_author_workspace_events/.test(call.sql))!;
  assert.match(event.sql, /'run_needs_action'/);
  assert.equal(event.params[3], OPERATION);
  // Ownership binds tenant, course, conversation and the author as requester.
  const lock = f.calls.find(call => /FOR UPDATE OF r,w/.test(call.sql))!;
  assert.deepEqual(lock.params, [WORKSPACE, TENANT, COURSE, CONVERSATION, USER]);
  assert.match(lock.sql, /w\.blueprint_id IS NULL/);
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
});

test('stop keeps the workspace drafting while in-flight work drains', async () => {
  const f = database(stopRoute({ run_status: 'executing', running: 2 }));
  const repository = createOrchestrationV2RecoveryRepository({ db: f.db, canEdit: async () => true }, { retry: noSleep });
  const result = await repository.stop(owner, WORKSPACE, OPERATION);
  assert.equal(result.workspace_status, 'drafting');
  assert.equal(f.calls.some(call => /UPDATE lesson_author_workspaces SET status='needs_action'/.test(call.sql)), false);
  assert.equal(f.calls.some(call => /INSERT INTO lesson_author_workspace_events/.test(call.sql)), false);
});

test('stop is idempotent by state and refuses a run that is not running', async () => {
  const replay = database(stopRoute({ run_status: 'needs_action', failure_code: 'RUN_STOPPED_BY_AUTHOR' }));
  const replayed = await createOrchestrationV2RecoveryRepository({ db: replay.db, canEdit: async () => true },
    { retry: noSleep }).stop(owner, WORKSPACE, OPERATION);
  assert.equal(replayed.replayed, true);
  assert.equal(replay.calls.some(call => /^\s*UPDATE /.test(call.sql)), false);
  assert.ok(replay.calls.some(call => /FOR UPDATE OF r,w/.test(call.sql)));

  for (const state of [{ run_status: 'needs_action', failure_code: 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID' },
    { run_status: 'ready' }, { run_status: 'canceled', failure_code: 'X' }]) {
    const f = database(stopRoute(state));
    await assert.rejects(createOrchestrationV2RecoveryRepository({ db: f.db, canEdit: async () => true },
      { retry: noSleep }).stop(owner, WORKSPACE, OPERATION), { code: 'RUN_STOP_NOT_ACTIVE' });
    assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
  }
});

test('stop refusals: permission, ownership, deletion in progress and bad input', async () => {
  const forbidden = database(stopRoute({ run_status: 'executing' }));
  await assert.rejects(createOrchestrationV2RecoveryRepository({ db: forbidden.db, canEdit: async () => false },
    { retry: noSleep }).stop(owner, WORKSPACE, OPERATION), { code: 'RECOVERY_FORBIDDEN' });
  assert.equal(forbidden.calls.some(call => /pg_advisory_xact_lock/.test(call.sql)), false);

  const missing = database(stopRoute({ run_status: 'executing', locked: false }));
  await assert.rejects(createOrchestrationV2RecoveryRepository({ db: missing.db, canEdit: async () => true },
    { retry: noSleep }).stop(owner, WORKSPACE, OPERATION), { code: 'RECOVERY_NOT_FOUND' });

  const deleting = database(stopRoute({ run_status: 'executing', deleting: true }));
  await assert.rejects(createOrchestrationV2RecoveryRepository({ db: deleting.db, canEdit: async () => true },
    { retry: noSleep }).stop(owner, WORKSPACE, OPERATION), { code: 'RECOVERY_STATE_CHANGED' });

  const input = database(() => assert.fail('no SQL for invalid input'));
  const repository = createOrchestrationV2RecoveryRepository({ db: input.db, canEdit: async () => true }, { retry: noSleep });
  await assert.rejects(repository.stop(owner, 'not-a-uuid', OPERATION), { code: 'RECOVERY_INPUT_INVALID' });
  await assert.rejects(repository.stop(owner, WORKSPACE, 'nope'), { code: 'RECOVERY_INPUT_INVALID' });
  await assert.rejects(repository.stop({ ...owner, courseId: '' }, WORKSPACE, OPERATION), { code: 'RECOVERY_INPUT_INVALID' });
});

test('stop retries a deadlock victim from BEGIN', async () => {
  let first = true;
  const f = database((sql, params) => {
    if (first && /FOR UPDATE OF r,w/.test(sql)) {
      first = false;
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    }
    return stopRoute({ run_status: 'executing' })(sql, params);
  });
  const result = await createOrchestrationV2RecoveryRepository({ db: f.db, canEdit: async () => true },
    { retry: noSleep }).stop(owner, WORKSPACE, OPERATION);
  assert.equal(result.replayed, false);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
});

test('snapshot: one read-only repeatable-read view of the run, its tasks and the course node', async () => {
  const f = database(sql => {
    if (/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/.test(sql)) return [];
    if (/AS completion_receipt/.test(sql)) {
      return [{ workspace_status: 'needs_action', event_head: '42', run_id: RUN, run_status: 'needs_action',
        failure_code: 'RUN_STOPPED_BY_AUTHOR', finished_at: '2026-10-20 10:00:00.123456+07', manifest_hash: 'a'.repeat(64),
        runtime_config_hash: 'b'.repeat(64), model: 'gemini-test', completion_receipt: false, review_receipt: false }];
    }
    if (/FROM lesson_author_workspace_v2_tasks t/.test(sql)) {
      return [{ task_id: uuid(30), ordinal: 12, kind: 'generate_unit', status: 'canceled', failure_code: 'RUN_STOPPED_BY_AUTHOR',
        attempt_count: 0, max_attempts: 2, dispatch_epoch: 0, chapter_key: 'chapter-1', node_id: uuid(31),
        node_path: 'chapter_1.lesson_1.unit_1', node_has_content: false, ai_reservation_id: null,
        accounting_state: 'not_required', reservation_status: null }];
    }
    if (/FROM lesson_author_workspace_v2_dependencies/.test(sql)) return [{ task_id: uuid(30), depends_on_task_id: uuid(29) }];
    if (/kind='course'/.test(sql)) return [{ node_id: uuid(40), canonical_path: 'course' }];
    if (/FROM lesson_author_workspace_v2_recovery_tasks WHERE task_id=ANY/.test(sql)) return [{ task_id: uuid(30), reopens: 2 }];
    return undefined;
  });
  const snapshot = await createOrchestrationV2RecoveryRepository({ db: f.db,
    canEdit: async () => assert.fail('reads never take the write fence') }, { retry: noSleep }).snapshot(owner, WORKSPACE);
  assert.equal(snapshot.run?.status, 'needs_action');
  assert.equal(snapshot.run?.event_head, 42);
  assert.equal(snapshot.run?.manifest_sealed, true);
  assert.deepEqual(snapshot.tasks[0]!.depends_on, [uuid(29)]);
  assert.equal(snapshot.tasks[0]!.generation, 2);
  assert.equal(snapshot.recorded, false);
  assert.equal(snapshot.scope_node, null);
  assert.deepEqual(snapshot.course_node, { node_id: uuid(40), path: 'course' });
  assert.deepEqual(snapshot.runtime, { runtime_config_hash: 'b'.repeat(64), model: 'gemini-test' });
  assert.match(f.calls[0]!.sql, /REPEATABLE READ, READ ONLY/);
  assert.ok(f.calls.every(call => !/FOR UPDATE|FOR SHARE|pg_advisory/.test(call.sql)));
  assert.ok(f.calls.every(call => !/^\s*(UPDATE|INSERT|DELETE)/.test(call.sql)));

  const absent = database(sql => /REPEATABLE READ/.test(sql) ? [] : /AS completion_receipt/.test(sql) ? [] : undefined);
  await assert.rejects(createOrchestrationV2RecoveryRepository({ db: absent.db, canEdit: async () => true },
    { retry: noSleep }).snapshot(owner, WORKSPACE), { code: 'RECOVERY_NOT_FOUND' });

  const legacy = database(sql => /REPEATABLE READ/.test(sql) ? [] : /AS completion_receipt/.test(sql)
    ? [{ workspace_status: 'ready', event_head: 3, run_id: null }] : undefined);
  const view = await createOrchestrationV2RecoveryRepository({ db: legacy.db, canEdit: async () => true },
    { retry: noSleep }).snapshot(owner, WORKSPACE);
  assert.equal(view.run, null);
  assert.deepEqual(view.tasks, []);
});

test('readers accept the run_resumed event a recovery appends', async () => {
  const row = { id: WORKSPACE, correlation_id: uuid(60), contract_version: 1, content_locale: 'vi', status: 'drafting',
    event_head: '2', updated_at: new Date('2026-10-20T10:00:00Z'), first_sequence: '1', events: [
      { sequence: 1, event_kind: 'run_needs_action', node_id: null, node_revision: null, operation_id: uuid(61),
        created_at: '2026-10-20T09:00:00Z' },
      { sequence: 2, event_kind: 'run_resumed', node_id: null, node_revision: null, operation_id: OPERATION,
        created_at: '2026-10-20T10:00:00Z' }] };
  const db: GenerationJobSql = { async query<T extends Record<string, unknown>>() {
    return { rows: [structuredClone(row)] as unknown as T[], rowCount: 1 };
  } };
  const { createWorkspaceReadRepository } = await import('./lesson-author-workspace-read.repository.js');
  const page = await createWorkspaceReadRepository({ db, canRead: async () => true }).events(owner, WORKSPACE, 0);
  assert.deepEqual(page.events.map(event => event.event_kind), ['run_needs_action', 'run_resumed']);
  assert.equal(page.next_sequence, 2);
});
